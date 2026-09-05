import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  isOutputFormat,
  offerFormat,
  offerGroups,
  planFormatConversion,
} from '../convert/formats.js'
import { ConversionError, runConversion, TooBusyError } from '../convert/index.js'
import {
  acceptedExtensions,
  contentTypeFor,
  decodeOriginalName,
  detectFormat,
  formatFromName,
  safeUnlink,
  tempFilePath,
  transliterateName,
  withExtension,
} from '../files.js'
import { keepACopy, publicKeep } from '../library.js'
import { settings } from '../settings.js'
import { readOptions } from './upload.js'

interface DownloadParams {
  id: string
  filename: string
}

class ConvertError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'ConvertError'
    this.statusCode = statusCode
  }
}

interface Uploaded {
  path: string
  originalName: string
  truncated: boolean
}

interface Body {
  fields: Map<string, string>
  upload: Uploaded | null
}

async function consume(req: FastifyRequest, body: Body): Promise<void> {
  const limits = { fileSize: settings.int('MAX_FILE_SIZE') }
  for await (const part of req.parts({ limits })) {
    if (part.type === 'field') {
      body.fields.set(part.fieldname, String(part.value))
      continue
    }
    if (body.upload || part.fieldname !== 'file' || !part.filename) {
      part.file.resume()
      await finished(part.file).catch(() => undefined)
      continue
    }

    const originalName = decodeOriginalName(part.filename)
    const extension = originalName.toLowerCase().endsWith('.kepub.epub')
      ? '.kepub.epub'
      : extname(originalName).toLowerCase()
    const target = tempFilePath(extension || '.bin')

    body.upload = { path: target, originalName, truncated: false }
    await pipeline(part.file, createWriteStream(target))
    body.upload.truncated = part.file.truncated
  }
}

export async function convertRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { from?: string } }>('/api/convert/targets', async (req, reply) => {
    const from = req.query.from ? formatFromName(`x.${req.query.from}`) : null
    return reply.send({ groups: offerGroups(from, app.tools) })
  })

  app.post(
    '/convert',
    {
      config: {
        rateLimit: {
          max: settings.int('CONVERT_RATE_MAX'),
          timeWindow: settings.str('CONVERT_RATE_WINDOW'),
        },
      },
    },
    async (req, reply) => {
      if (!req.isMultipart()) {
        return reply.code(415).send({ ok: false, error: 'Expected a multipart/form-data body' })
      }

      const body: Body = { fields: new Map(), upload: null }

      try {
        await consume(req, body)

        const upload = body.upload
        if (!upload) throw new ConvertError('No file selected')
        if (upload.truncated) throw new ConvertError('File is too large', 413)

        const requested = body.fields.get('format')?.trim() ?? ''
        if (!isOutputFormat(requested)) throw new ConvertError('Pick a format to convert to')

        const { size } = await stat(upload.path)
        if (size === 0) throw new ConvertError('Invalid file submitted (empty file)')

        if (!formatFromName(upload.originalName)) {
          throw new ConvertError(
            `Unsupported file type: ${upload.originalName}. Accepted: ${acceptedExtensions.join(', ')}`
          )
        }

        const detected = await detectFormat(upload.path, upload.originalName)
        if (!detected) {
          throw new ConvertError(
            `That is not a readable ${extname(upload.originalName) || 'ebook'}`
          )
        }

        const offer = offerFormat(detected.format, requested, app.tools)
        if (offer.refusal) throw new ConvertError(offer.refusal, 422)

        const options = readOptions(body.fields)
        const plan = planFormatConversion(detected.format, requested, options, app.tools)
        const jobId = randomUUID()
        req.job = jobId.slice(0, 8)

        const { path: outputPath, applied } = await runConversion(
          plan,
          upload.path,
          detected.format,
          { logger: req.log, job: req.job }
        )

        let filename = upload.originalName
        if (options.transliteration) filename = transliterateName(filename)
        filename = withExtension(filename, plan.targetFormat)

        const { size: finalSize } = await stat(outputPath)

        const kept = await keepACopy(app, req.user, {
          from: outputPath,
          name: filename,
          source: 'convert',
        })

        const result = app.conversions.add(
          {
            name: filename,
            path: outputPath,
            format: plan.targetFormat,
            size: finalSize,
            owner: req.user?.id ?? null,
          },
          jobId
        )

        return await reply.send({
          ok: true,
          id: result.id,
          filename: result.name,
          size: result.size,
          applied,
          url: `/convert/${result.id}/${encodeURIComponent(result.name)}`,
          kept: publicKeep(kept),
        })
      } catch (err) {
        await safeUnlink(body.upload?.path)

        if (err instanceof ConvertError) {
          return reply.code(err.statusCode).send({ ok: false, error: err.message })
        }
        if (err instanceof TooBusyError) {
          return reply.code(503).send({ ok: false, error: err.message })
        }
        if (err instanceof ConversionError) {
          req.log.error({ err, tool: err.tool, output: err.output }, 'Conversion failed')
          return reply.code(422).send({ ok: false, error: err.toUserMessage() })
        }
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(413).send({ ok: false, error: 'File is too large' })
        }
        throw err
      }
    }
  )

  app.get<{ Params: DownloadParams }>(
    '/convert/:id/:filename',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'filename'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
            filename: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
      },
    },
    async (req, reply) => {
      req.job = req.params.id.slice(0, 8)
      const file = app.conversions.get(req.params.id, req.user?.id ?? null)
      if (!file || file.name !== req.params.filename) {
        return reply.code(404).send({ error: 'Not found' })
      }

      let size: number
      try {
        size = (await stat(file.path)).size
      } catch {
        req.log.error({ id: file.id }, 'Converted file vanished from disk')
        await app.conversions.remove(file.id)
        return reply.code(404).send({ error: 'Not found' })
      }

      reply.header('Content-Type', contentTypeFor(file.format))
      reply.header('Content-Length', size)
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`)

      const stream = createReadStream(file.path)
      stream.on('end', () => {
        void app.conversions.remove(file.id)
      })
      stream.on('close', () => {
        if (!stream.readableEnded) {
          req.log.warn(
            { id: file.id },
            'Download broke off part way; the file is still collectable'
          )
        }
      })
      return reply.send(stream)
    }
  )
}
