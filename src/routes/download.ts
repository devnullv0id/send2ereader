import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { config, publicUrlFor } from '../config.js'
import { isEreader } from '../device.js'
import { contentTypeFor } from '../files.js'
import { settings } from '../settings.js'

interface DownloadParams {
  filename: string
}

interface DownloadQuery {
  key?: string
}

function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null

  let start: number
  let end: number
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

export async function downloadRoutes(app: FastifyInstance): Promise<void> {
  function needsSetup(agent: string | undefined): boolean {
    return !isEreader(agent) && app.hasDecorator('auth') && app.auth.unclaimed
  }

  app.get('/', async (req, reply) => {
    const agent = req.headers['user-agent']
    if (needsSetup(agent)) return reply.redirect('/setup')
    return reply.page(isEreader(agent) ? 'download.html' : 'send.html')
  })

  app.get('/receive', async (_req, reply) => reply.page('download.html'))

  app.get('/send', async (req, reply) => {
    if (needsSetup(req.headers['user-agent'])) return reply.redirect('/setup')
    return reply.page('send.html')
  })

  app.get('/convert', async (req, reply) => {
    if (needsSetup(req.headers['user-agent'])) return reply.redirect('/setup')
    return reply.page('convert.html')
  })

  // /history reads this browser's own localStorage and stands on its own with no
  // account at all; the kept-books section on it simply stays empty. /waiting is
  // only ever about books queued for a registered device, so without accounts it
  // has nothing to be. The two differ because the pages differ.
  app.get('/history', async (_req, reply) => reply.page('history.html'))

  app.get('/waiting', async (_req, reply) => {
    if (!app.hasDecorator('auth')) return reply.callNotFound()
    return reply.page('waiting.html')
  })

  // What the send and convert pages need to draw themselves, and nothing that
  // describes the deployment: the live key count and the key length together told
  // an anonymous caller how big the guessing space is and how full it is.
  app.get('/healthz', async (_req, reply) =>
    reply.send({
      ok: true,
      tools: app.tools,
      maxFileSize: settings.int('MAX_FILE_SIZE'),
      expireSeconds: settings.int('EXPIRE_SECONDS'),
      publicUrl: publicUrlFor(''),
      queueTtlSeconds: config.kobo.queueTtlSeconds,
    })
  )

  app.get<{ Params: DownloadParams; Querystring: DownloadQuery }>(
    '/download/:filename',
    {
      schema: {
        params: {
          type: 'object',
          required: ['filename'],
          properties: { filename: { type: 'string', minLength: 1, maxLength: 512 } },
        },
      },
    },
    async (req, reply) => {
      const key = req.query.key?.toUpperCase()
      if (!key) return reply.code(400).send({ error: 'Missing key' })

      const info = app.keystore.get(key)
      const file = info?.file
      if (!info || !file) return reply.code(404).send({ error: 'Not found' })
      if (file.name !== req.params.filename) return reply.code(404).send({ error: 'Not found' })
      if (info.agent !== (req.headers['user-agent'] ?? '')) {
        req.log.warn({ key }, 'User-agent mismatch on download')
        return reply.code(404).send({ error: 'Not found' })
      }

      let size: number
      try {
        size = (await stat(file.path)).size
      } catch {
        req.log.error({ key, path: file.path }, 'Stored file vanished from disk')
        await app.keystore.clearFile(key)
        return reply.code(404).send({ error: 'Not found' })
      }

      app.keystore.heard(key)
      req.log.info({ key, name: file.name, size }, 'Sending file')

      reply.header('Content-Type', contentTypeFor(file.format))
      reply.header('Accept-Ranges', 'bytes')
      reply.header('Cache-Control', 'no-store')
      if (info.device === 'kindle') {
        reply.header('Content-Disposition', `attachment; filename="${file.name}"`)
      }

      const range = parseRange(req.headers.range, size)
      if (range) {
        reply.code(206)
        reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        reply.header('Content-Length', range.end - range.start + 1)
        return reply.send(createReadStream(file.path, { start: range.start, end: range.end }))
      }

      reply.header('Content-Length', size)
      return reply.send(createReadStream(file.path))
    }
  )
}
