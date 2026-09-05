import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import type { Book, Device } from '../db/repositories.js'
import { readEpubCover } from '../epub/cover.js'
import { contentTypeFor, isEpubFamily } from '../files.js'
import type { EbookFormat } from '../types.js'
import {
  initializationResources,
  metadataResponse,
  newEntitlement,
  readingState,
} from './entitlements.js'
import { proxyToStore } from './proxy.js'
import type { QueuedBook } from './queue.js'
import { nextSyncToken, parseSyncToken, SYNC_TOKEN_HEADER } from './synctoken.js'

interface TokenParams {
  token: string
}

const tokenSchema = {
  type: 'object',
  required: ['token'],
  properties: { token: { type: 'string', minLength: 16, maxLength: 128 } },
} as const

function keptAsQueued(book: Book, deviceId: string): QueuedBook {
  return {
    id: book.id,
    deviceId,
    name: book.name,
    title: book.title,
    authors: book.authors,
    language: null,
    path: book.path,
    format: book.format as EbookFormat,
    size: book.size,
    queuedAt: new Date(book.createdAt),
  }
}

export async function koboRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: config.kobo.proxyBodyLimit },
    (_req, body, done) => done(null, body)
  )

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: config.kobo.proxyBodyLimit },
    (_req, body, done) => {
      const text = typeof body === 'string' ? body.trim() : ''
      if (text.length === 0) return done(null, null)
      try {
        done(null, JSON.parse(text))
      } catch {
        done(null, text)
      }
    }
  )

  function authenticate(req: FastifyRequest, reply: FastifyReply, token: string): Device | null {
    const device = app.repos.devices.byToken(token)
    if (!device) {
      req.log.warn('Kobo request with an unknown device token')
      void reply.code(401).send({ error: 'Unknown device' })
      return null
    }
    return device
  }

  function keptFor(id: string, device: Device): QueuedBook | null {
    const book = app.repos.books.byIdForDevice(id, device.id, device.userId)
    return book ? keptAsQueued(book, device.id) : null
  }

  function findBook(id: string, device: Device): { book: QueuedBook; fromQueue: boolean } | null {
    const queued = app.deliveries.get(id, device.id)
    if (queued) return { book: queued, fromQueue: true }

    const kept = keptFor(id, device)
    return kept ? { book: kept, fromQueue: false } : null
  }

  app.get<{ Params: TokenParams }>(
    '/kobo/:token/v1/initialization',
    { schema: { params: tokenSchema } },
    async (req, reply) => {
      const device = authenticate(req, reply, req.params.token)
      if (!device) return reply

      app.repos.devices.recordSeen(device.id)
      const upstream = await app.koboStore.initializationResources(device, req.headers)
      return reply.send({ Resources: initializationResources(req.params.token, upstream) })
    }
  )

  app.post<{ Params: TokenParams; Body: { DeviceId?: string; UserKey?: string } }>(
    '/kobo/:token/v1/auth/device',
    { schema: { params: tokenSchema } },
    async (req, reply) => {
      const device = authenticate(req, reply, req.params.token)
      if (!device) return reply

      app.repos.devices.recordSeen(device.id, req.body?.DeviceId, req.body?.UserKey)
      req.log.info({ deviceId: device.id }, 'Kobo device checked in')

      return reply.send({
        AccessToken: req.params.token,
        RefreshToken: req.params.token,
        TokenType: 'Bearer',
        TrackingId: device.id,
        UserKey: req.body?.UserKey ?? device.koboUserId ?? device.id,
      })
    }
  )

  app.get<{ Params: TokenParams }>(
    '/kobo/:token/v1/library/sync',
    { schema: { params: tokenSchema } },
    async (req, reply) => {
      const device = authenticate(req, reply, req.params.token)
      if (!device) return reply

      app.repos.devices.recordSeen(device.id)
      const pending = app.deliveries.listFor(device.id)
      const queuedIds = new Set(pending.map((book) => book.id))
      const kept = app.repos.books
        .forDevice(device.id, device.userId)
        .filter((book) => !queuedIds.has(book.id))
        .map((book) => keptAsQueued(book, device.id))

      const entitlements = [...pending, ...kept].map((book) =>
        newEntitlement(book, req.params.token)
      )

      req.log.info({ deviceId: device.id, pending: pending.length, kept: kept.length }, 'Kobo sync')

      if (entitlements.length === 0 && device.lastSyncFailedAt) {
        app.repos.devices.clearSyncFailure(device.id)
      }

      reply.header(SYNC_TOKEN_HEADER, nextSyncToken(parseSyncToken(req.headers[SYNC_TOKEN_HEADER])))
      reply.header('x-kobo-sync-mode', 'delta')
      reply.header('x-kobo-apitoken', 'e30=')
      return reply.send(entitlements)
    }
  )

  app.get<{ Params: TokenParams & { uuid: string } }>(
    '/kobo/:token/v1/library/:uuid/metadata',
    { schema: { params: { ...tokenSchema, required: ['token', 'uuid'] } } },
    async (req, reply) => {
      const device = authenticate(req, reply, req.params.token)
      if (!device) return reply

      const found = findBook(req.params.uuid, device)
      if (!found) return reply.code(404).send({ error: 'Not found' })
      return reply.send([metadataResponse(found.book, req.params.token)])
    }
  )

  app.get<{ Params: TokenParams & { uuid: string } }>(
    '/kobo/:token/v1/library/:uuid/state',
    { schema: { params: { ...tokenSchema, required: ['token', 'uuid'] } } },
    async (req, reply) => {
      const device = authenticate(req, reply, req.params.token)
      if (!device) return reply

      const book = app.deliveries.get(req.params.uuid, device.id)
      if (!book) return reply.code(404).send({ error: 'Not found' })
      return reply.send({ ReadingStates: [readingState(book)] })
    }
  )

  app.put<{ Params: TokenParams & { uuid: string } }>(
    '/kobo/:token/v1/library/:uuid/state',
    { schema: { params: { ...tokenSchema, required: ['token', 'uuid'] } } },
    async (req, reply) => {
      const device = authenticate(req, reply, req.params.token)
      if (!device) return reply

      return reply.send({
        RequestResult: 'Success',
        UpdateResults: [
          {
            EntitlementId: req.params.uuid,
            StatusInfoResult: { Result: 'Success' },
            StatisticsResult: { Result: 'Success' },
            CurrentBookmarkResult: { Result: 'Success' },
          },
        ],
      })
    }
  )

  app.delete<{ Params: TokenParams & { uuid: string } }>(
    '/kobo/:token/v1/library/:uuid',
    { schema: { params: { ...tokenSchema, required: ['token', 'uuid'] } } },
    async (req, reply) => {
      const device = authenticate(req, reply, req.params.token)
      if (!device) return reply

      const book = app.deliveries.get(req.params.uuid, device.id)
      if (book) await app.deliveries.remove(book.id)
      app.repos.books.archiveForDevice(req.params.uuid, device.id)
      return reply.code(204).send()
    }
  )

  app.get<{ Params: TokenParams & { uuid: string } }>(
    '/kobo/:token/download/:uuid',
    { schema: { params: { ...tokenSchema, required: ['token', 'uuid'] } } },
    async (req, reply) => {
      const device = authenticate(req, reply, req.params.token)
      if (!device) return reply

      const found = findBook(req.params.uuid, device)
      if (!found) return reply.code(404).send({ error: 'Not found' })
      const { book, fromQueue } = found

      let size: number
      try {
        size = (await stat(book.path)).size
      } catch {
        req.log.error({ bookId: book.id, fromQueue }, 'Book file vanished from disk')
        if (fromQueue) await app.deliveries.remove(book.id)
        return reply.code(404).send({ error: 'Not found' })
      }

      app.repos.devices.recordSeen(device.id)
      req.log.info(
        { deviceId: device.id, bookId: book.id, size, fromQueue },
        fromQueue ? 'Sending queued book' : 'Sending the kept copy again'
      )

      reply.header('Content-Type', contentTypeFor(book.format))
      reply.header('Content-Length', size)
      reply.header('Content-Disposition', `attachment; filename="${book.id}.kepub.epub"`)

      const stream = createReadStream(book.path)
      let complete = false

      stream.on('end', () => {
        complete = true
        app.repos.devices.clearSyncFailure(device.id)
        if (fromQueue) void app.deliveries.delivered(book.id)
      })

      stream.on('close', () => {
        if (complete) return
        app.repos.devices.recordSyncFailure(device.id)
        req.log.warn({ deviceId: device.id, bookId: book.id }, 'Transfer broke off part way')
      })

      return reply.send(stream)
    }
  )

  const coverHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as Record<string, string>
    const device = authenticate(req, reply, params.token ?? '')
    if (!device) return reply

    const book = findBook(params.imageId ?? '', device)?.book
    if (book) {
      const cover = isEpubFamily(book.format) ? await readEpubCover(book.path) : null
      if (!cover) {
        req.log.debug({ bookId: book.id, format: book.format }, 'Queued book has no cover')
        return reply.code(404).send({ error: 'No cover' })
      }
      reply.header('Content-Type', cover.contentType)
      reply.header('Content-Length', cover.data.length)
      reply.header('Cache-Control', 'private, max-age=3600')
      return reply.send(cover.data)
    }

    const url = await app.koboStore.imageUrl(device, {
      ImageId: params.imageId ?? '',
      Width: params.width ?? '',
      Height: params.height ?? '',
      IsGreyscale: params.isGreyscale ?? 'false',
      ...(params.quality === undefined ? {} : { Quality: params.quality }),
    })
    if (!url) return reply.code(404).send({ error: 'Unknown image' })
    return reply.redirect(url, 302)
  }

  const COVERS = '/kobo/:token/v1/books/:imageId/thumbnail/:width/:height'
  app.get(`${COVERS}/:isGreyscale/image.jpg`, coverHandler)
  app.get(`${COVERS}/:quality/:isGreyscale/image.jpg`, coverHandler)

  const proxyHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const { token, '*': rest } = req.params as { token: string; '*'?: string }
    const device = authenticate(req, reply, token)
    if (!device) return reply

    return proxyToStore(req, reply, device, `/${rest ?? ''}`, req.log)
  }

  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const) {
    app.route({ method, url: '/kobo/:token/*', handler: proxyHandler })
  }
}
