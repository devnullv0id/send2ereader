import { createWriteStream } from 'node:fs'
import { copyFile, rename, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import {
  isOutputFormat,
  type OutputFormat,
  offerFormat,
  planFormatConversion,
} from '../convert/formats.js'
import {
  ConversionError,
  type ConversionPlan,
  type ConverterName,
  planConversion,
  runConversion,
  TooBusyError,
  type ToolAvailability,
} from '../convert/index.js'
import { deviceLabel } from '../device.js'
import { readEpubMetadata } from '../epub/metadata.js'
import {
  acceptedExtensions,
  decodeOriginalName,
  detectFormat,
  fileExtensions,
  formatFromName,
  isEpubFamily,
  kindleSafeName,
  safeUnlink,
  tempFilePath,
  transliterateName,
  withExtension,
} from '../files.js'
import { newBookId } from '../kobo/queue.js'
import { type KeepResult, keepACopy, publicKeep } from '../library.js'
import type { PendingDelivery, QueuedBook } from '../pending.js'
import { settings } from '../settings.js'
import {
  type ConversionOptions,
  type ConversionTarget,
  type EbookFormat,
  type KeyInfo,
  type LayoutFixSettings,
  type ResolvedTarget,
  resolveTarget,
} from '../types.js'

interface UploadedTemp {
  path: string
  originalName: string
  truncated: boolean
}

interface MultipartState {
  fields: Map<string, string>
  upload: UploadedTemp | null
}

class UploadError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'UploadError'
    this.statusCode = statusCode
  }
}

function isChecked(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== 'false' && value !== 'off'
}

const targets: ConversionTarget[] = ['auto', 'kobo', 'kindle', 'none']

function planFor(
  target: ResolvedTarget,
  format: EbookFormat,
  options: ConversionOptions,
  tools: ToolAvailability
): ConversionPlan {
  const wanted = options.format
  if (!wanted || !isOutputFormat(wanted)) {
    return planConversion(target, format, options, tools)
  }
  if (offerFormat(format, wanted as OutputFormat, tools).refusal) {
    return planConversion(target, format, options, tools)
  }
  return planFormatConversion(format, wanted as OutputFormat, options, tools)
}

const toolLabels: Record<string, string> = {
  calibre: 'calibre',
  kepubify: 'kepubify',
  pdfcropmargins: 'pdfCropMargins',
  layoutfix: 'the EPUB layout fix',
}

function listTools(names: string[]): string {
  const labels = names.map((n) => toolLabels[n] ?? n)
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

const LAYOUT_FLAGS: [string, keyof LayoutFixSettings][] = [
  ['layoutFixImages', 'fixImages'],
  ['layoutFixCovers', 'fixCovers'],
  ['layoutDarkCover', 'darkCover'],
  ['layoutPreserveAnchors', 'preserveAnchors'],
  ['layoutFixCaptioned', 'fixCaptioned'],
  ['layoutFixMultiImage', 'fixMultiImage'],
]

export function readLayoutSettings(fields: Map<string, string>): LayoutFixSettings | undefined {
  const layout: LayoutFixSettings = {}

  for (const [field, key] of LAYOUT_FLAGS) {
    if (fields.has(field)) layout[key] = isChecked(fields.get(field)) as never
  }

  const percent = Number(fields.get('layoutMinWidthPercent'))
  if (Number.isFinite(percent) && percent > 0 && percent <= 100) {
    layout.minWidthPercent = percent
  }

  const colour = fields.get('layoutCoverColor')?.trim()
  if (colour && /^#[0-9a-f]{6}$/i.test(colour)) layout.coverColor = colour

  return Object.keys(layout).length > 0 ? layout : undefined
}

async function deliver(
  app: FastifyInstance,
  key: string,
  book: { filename: string; path: string; format: EbookFormat; size: number }
): Promise<void> {
  await app.keystore.setFile(key, {
    name: book.filename,
    path: book.path,
    format: book.format,
    size: book.size,
    uploaded: new Date(),
  })
}

export function readOptions(fields: Map<string, string>): ConversionOptions {
  const target = fields.get('target')
  const requested = fields.get('kindleFormat')
  const format = fields.get('format')
  return {
    target: targets.includes(target as ConversionTarget) ? (target as ConversionTarget) : 'auto',
    kindleFormat: requested === 'mobi' ? 'mobi' : 'azw3',
    format: format && isOutputFormat(format) ? format : null,
    pdfcropmargins: isChecked(fields.get('pdfcropmargins')),
    transliteration: isChecked(fields.get('transliteration')),
    layoutFix: fields.has('layoutFix')
      ? isChecked(fields.get('layoutFix'))
      : settings.bool('LAYOUT_FIX_DEFAULT'),
    layout: readLayoutSettings(fields),
  }
}

async function consumeMultipart(req: FastifyRequest, state: MultipartState): Promise<void> {
  const limits = { fileSize: settings.int('MAX_FILE_SIZE') }
  for await (const part of req.parts({ limits })) {
    if (part.type === 'field') {
      state.fields.set(part.fieldname, String(part.value))
      continue
    }

    if (state.upload || part.fieldname !== 'file' || !part.filename) {
      part.file.resume()
      await finished(part.file).catch(() => undefined)
      continue
    }

    const originalName = decodeOriginalName(part.filename)
    const extension = originalName.toLowerCase().endsWith('.kepub.epub')
      ? '.kepub.epub'
      : extname(originalName).toLowerCase()
    const target = tempFilePath(extension || '.bin')

    state.upload = { path: target, originalName, truncated: false }
    await pipeline(part.file, createWriteStream(target))
    state.upload.truncated = part.file.truncated
  }
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/upload',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!req.isMultipart()) {
        return reply.code(415).send({ ok: false, error: 'Expected a multipart/form-data body' })
      }

      const state: MultipartState = { fields: new Map(), upload: null }

      try {
        await consumeMultipart(req, state)
        const { fields } = state

        const deviceId = fields.get('deviceId')?.trim()
        if (deviceId) return await sendToDevice(app, req, reply, state, deviceId)

        const key = fields.get('key')?.trim().toUpperCase()
        if (!key) throw new UploadError('No key supplied')

        const info = app.keystore.get(key)
        if (!info) throw new UploadError(`Unknown key ${key}`)

        app.keystore.renew(key)
        const options = readOptions(fields)
        const messages: string[] = []

        const url = fields.get('url')?.trim()
        if (url) {
          if (!/^https?:\/\//i.test(url)) throw new UploadError('Only http(s) urls can be sent')
          if (!info.urls.includes(url)) info.urls.push(url)
          messages.push(`Added url: ${url}`)
        }

        let filename: string | null = null
        let conversion: string[] = []
        let pending: string | null = null
        let kept: KeepResult | null = null
        if (state.upload) {
          const result = await handleFile(app, info, state.upload, options, req)
          filename = result.filename
          conversion = result.applied

          if (isChecked(fields.get('hold'))) {
            pending = app.pending.hold({
              owner: info.key,
              path: result.path,
              filename: result.filename,
              format: result.format,
              size: result.size,
              applied: result.applied,
            })
          } else {
            await deliver(app, info.key, result)
            kept = await keepACopy(app, req.user, {
              from: result.path,
              name: result.filename,
              source: 'send',
            })
          }

          messages.push(
            conversion.length > 0
              ? `Upload successful! Processed with ${listTools(conversion)} and sent to ${deviceLabel(info.device)}.`
              : `Upload successful! Sent to ${deviceLabel(info.device)}.`
          )
          messages.push(`Filename: ${result.filename}`)
        }

        if (messages.length === 0) throw new UploadError('No file or url selected')

        app.keystore.renew(key)
        return await reply.send({
          ok: true,
          key,
          messages,
          filename,
          conversion,
          pending,
          url: url ?? null,
          kept: publicKeep(kept),
        })
      } catch (err) {
        await safeUnlink(state.upload?.path)

        if (err instanceof UploadError) {
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

  app.post<{ Body: { key?: string; deviceId?: string; token?: string } }>(
    '/upload/commit',
    async (req, reply) => {
      const token = req.body?.token ?? ''
      const deviceId = req.body?.deviceId?.trim() ?? ''
      const key = req.body?.key?.trim().toUpperCase() ?? ''

      if (deviceId) {
        if (!req.user) return reply.code(401).send({ ok: false, error: 'Sign in first' })
        const device = app.repos.devices.byId(deviceId)
        if (!device || device.userId !== req.user.id) {
          return reply.code(404).send({ ok: false, error: 'Unknown device' })
        }

        const held = app.pending.claim(token, deviceId)
        if (!held?.queued || held.queued.userId !== req.user.id) {
          return reply.code(404).send({ ok: false, error: 'Nothing is waiting to be sent' })
        }

        const kept = await keepACopy(app, req.user, {
          from: held.path,
          name: held.filename,
          source: 'send',
          id: held.queued.bookId,
          deviceId,
        })
        const book = queueForDevice(app, held)

        req.log.info({ deviceId, filename: held.filename }, 'Queued on request')
        return reply.send({
          ok: true,
          filename: book.name,
          book: { id: book.id, title: book.title, size: book.size },
          kept: publicKeep(kept),
        })
      }

      const info = app.keystore.get(key)
      if (!info) return reply.code(404).send({ ok: false, error: `Unknown key ${key}` })

      const held = app.pending.claim(token, key)
      if (!held) return reply.code(404).send({ ok: false, error: 'Nothing is waiting to be sent' })

      await deliver(app, key, held)

      const kept = await keepACopy(app, req.user, {
        from: held.path,
        name: held.filename,
        source: 'send',
      })

      app.keystore.renew(key)
      req.log.info({ key, filename: held.filename }, 'Delivered on request')
      return reply.send({ ok: true, filename: held.filename, kept: publicKeep(kept) })
    }
  )

  app.post<{ Body: { key?: string; deviceId?: string; token?: string } }>(
    '/upload/discard',
    async (req, reply) => {
      const token = req.body?.token ?? ''
      const owner = req.body?.deviceId?.trim() || (req.body?.key?.trim().toUpperCase() ?? '')

      const held = app.pending.claim(token, owner)
      if (!held) return reply.send({ ok: true, discarded: false })

      if (held.queued && held.queued.userId !== req.user?.id) {
        return reply.code(404).send({ ok: false, error: 'Nothing is waiting to be sent' })
      }

      await safeUnlink(held.path)
      req.log.info({ owner, filename: held.filename }, 'Discarded before delivery')
      return reply.send({ ok: true, discarded: true })
    }
  )
}

async function sendToDevice(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  state: MultipartState,
  deviceId: string
): Promise<FastifyReply> {
  if (!app.hasDecorator('deliveries')) {
    throw new UploadError('This server has no registered devices', 404)
  }
  if (!req.user) throw new UploadError('Sign in to send to a registered eReader', 401)
  if (!req.user.emailVerified) throw new UploadError('Confirm your e-mail address first', 403)

  const device = app.repos.devices.byId(deviceId)
  if (!device || device.userId !== req.user.id) {
    throw new UploadError('Unknown device', 404)
  }
  if (!state.upload) throw new UploadError('No file selected')

  const upload = state.upload
  if (upload.truncated) throw new UploadError('File is too large', 413)

  const { size } = await stat(upload.path)
  if (size === 0) throw new UploadError('Invalid file submitted (empty file)')

  const detected = await detectFormat(upload.path, upload.originalName)
  if (!detected) {
    throw new UploadError(`Uploaded file is not a valid ebook: ${upload.originalName}`)
  }

  const options = readOptions(state.fields)
  const target = resolveTarget(options.target, 'kobo')
  const plan = planFor(target, detected.format, options, app.tools)
  req.job = device.id.slice(0, 8)

  const { path: convertedPath, applied } = await runConversion(plan, upload.path, detected.format, {
    logger: req.log,
    job: req.job,
  })

  let filename = upload.originalName
  if (options.transliteration) filename = transliterateName(filename)
  filename = withExtension(filename, plan.targetFormat)

  const bookId = newBookId()
  const queuedPath = app.deliveries.pathFor(bookId, fileExtensions[plan.targetFormat])
  try {
    await rename(convertedPath, queuedPath)
  } catch {
    await copyFile(convertedPath, queuedPath)
    await safeUnlink(convertedPath)
  }

  const { size: finalSize } = await stat(queuedPath)

  const details = isEpubFamily(plan.targetFormat) ? await readEpubMetadata(queuedPath) : null
  if (details) {
    req.log.info(
      { deviceId: device.id, title: details.title, authors: details.authors },
      'Read metadata from the book'
    )
  }

  const queuedBook: QueuedBook = {
    bookId,
    deviceId: device.id,
    userId: req.user.id,
    title: details?.title,
    authors: details?.authors,
    language: details?.language,
  }

  if (isChecked(state.fields.get('hold'))) {
    const pending = app.pending.hold({
      owner: device.id,
      path: queuedPath,
      filename,
      format: plan.targetFormat,
      size: finalSize,
      applied,
      queued: queuedBook,
    })

    return reply.send({
      ok: true,
      deviceId: device.id,
      messages: [
        `Queued for ${device.label}. It will appear after the next sync.`,
        `Filename: ${filename}`,
      ],
      filename,
      conversion: applied,
      pending,
      url: null,
      kept: null,
    })
  }

  const kept = await keepACopy(app, req.user, {
    from: queuedPath,
    name: filename,
    source: 'send',
    id: bookId,
    deviceId: device.id,
  })

  const book = queueForDevice(app, {
    owner: device.id,
    path: queuedPath,
    filename,
    format: plan.targetFormat,
    size: finalSize,
    applied,
    queued: queuedBook,
  })

  return reply.send({
    ok: true,
    deviceId: device.id,
    messages: [
      `Queued for ${device.label}. It will appear after the next sync.`,
      `Filename: ${book.name}`,
    ],
    filename: book.name,
    conversion: applied,
    book: { id: book.id, title: book.title, size: book.size },
    url: null,
    kept: publicKeep(kept),
  })
}

function queueForDevice(app: FastifyInstance, held: PendingDelivery) {
  const queued = held.queued as QueuedBook
  return app.deliveries.add(
    {
      id: queued.bookId,
      deviceId: queued.deviceId,
      name: held.filename,
      path: held.path,
      format: held.format,
      size: held.size,
    },
    {
      title: queued.title ?? undefined,
      authors: queued.authors ?? undefined,
      language: queued.language ?? undefined,
    }
  )
}

async function handleFile(
  app: FastifyInstance,
  info: KeyInfo,
  upload: UploadedTemp,
  options: ConversionOptions,
  req: FastifyRequest
): Promise<{
  filename: string
  format: EbookFormat
  size: number
  applied: ConverterName[]
  path: string
}> {
  if (upload.truncated) {
    throw new UploadError('File is too large', 413)
  }

  const { size } = await stat(upload.path)
  if (size === 0) throw new UploadError('Invalid file submitted (empty file)')

  if (!formatFromName(upload.originalName)) {
    throw new UploadError(
      `Unsupported file type: ${upload.originalName}. Accepted: ${acceptedExtensions.join(', ')}`
    )
  }

  const detected = await detectFormat(upload.path, upload.originalName)
  if (!detected) {
    throw new UploadError(
      `Uploaded file is not a valid ${extname(upload.originalName) || 'ebook'} file: ${upload.originalName}`
    )
  }

  const target = resolveTarget(options.target, info.device)
  const plan = planFor(target, detected.format, options, app.tools)
  req.job = info.key

  const { path: outputPath, applied } = await runConversion(plan, upload.path, detected.format, {
    logger: req.log,
    job: req.job,
  })

  let filename = upload.originalName
  if (options.transliteration) filename = transliterateName(filename)
  if (target === 'kindle' || info.device === 'kindle') filename = kindleSafeName(filename)
  filename = withExtension(filename, plan.targetFormat)

  const { size: finalSize } = await stat(outputPath)

  return {
    filename,
    applied,
    path: outputPath,
    format: plan.targetFormat,
    size: finalSize,
  }
}
