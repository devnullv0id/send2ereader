import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { type Confirmation, confirm, requireUser, requireVerifiedUser } from '../auth/routes.js'
import { endSession } from '../auth/session.js'
import { config, publicUrlFor } from '../config.js'
import type { Book, Device } from '../db/repositories.js'
import { contentTypeFor, formatFromName } from '../files.js'
import type { QueuedBook } from '../kobo/queue.js'
import { settings } from '../settings.js'

interface IdParams {
  id: string
}

const MAX_LABEL = 64

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const

function publicDevice(device: Device) {
  return {
    id: device.id,
    label: device.label,
    proxyStore: device.proxyStore,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    paired: device.lastSeenAt !== null,
    endpoint: device.token ? endpointFor(device.token) : null,
    lastSyncFailedAt: device.lastSyncFailedAt,
  }
}

function endpointFor(token: string): string {
  return publicUrlFor(`/kobo/${token}`)
}

function cleanLabel(raw: unknown): string {
  const label = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  return label.slice(0, MAX_LABEL)
}

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  function ownedBy(req: FastifyRequest, id: string): Device | null {
    const device = app.repos.devices.byId(id)
    return device && device.userId === req.user?.id ? device : null
  }

  app.get('/api/devices', { preHandler: requireVerifiedUser }, async (req, reply) => {
    const devices = app.repos.devices.listForUser(req.user!.id)
    return reply.send({ devices: devices.map(publicDevice), storeEndpoint: config.kobo.storeUrl })
  })

  app.post<{ Body: { label?: string; proxyStore?: boolean } }>(
    '/api/devices',
    {
      preHandler: requireVerifiedUser,
      schema: {
        body: {
          type: 'object',
          properties: {
            label: { type: 'string', maxLength: MAX_LABEL },
            proxyStore: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const label = cleanLabel(req.body?.label) || 'My Kobo'
      const proxyStore = req.body?.proxyStore ?? true

      const { device, token } = app.repos.devices.create(req.user!.id, label, proxyStore)
      req.log.info({ deviceId: device.id, userId: req.user!.id }, 'Registered device')

      return reply.code(201).send({
        ok: true,
        device: publicDevice(device),
        token,
        endpoint: endpointFor(token),
      })
    }
  )

  app.patch<{ Params: IdParams; Body: { label?: string; proxyStore?: boolean } }>(
    '/api/devices/:id',
    {
      preHandler: requireVerifiedUser,
      schema: {
        params: idParamsSchema,
        body: {
          type: 'object',
          properties: {
            label: { type: 'string', maxLength: MAX_LABEL },
            proxyStore: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const device = ownedBy(req, req.params.id)
      if (!device) return reply.code(404).send({ ok: false, error: 'Unknown device' })

      if (req.body?.label !== undefined) {
        const label = cleanLabel(req.body.label)
        if (!label) return reply.code(400).send({ ok: false, error: 'A name is required' })
        app.repos.devices.rename(device.id, label)
      }
      if (req.body?.proxyStore !== undefined) {
        app.repos.devices.setProxyStore(device.id, req.body.proxyStore)
      }

      return reply.send({ ok: true, device: publicDevice(app.repos.devices.byId(device.id)!) })
    }
  )

  app.get('/api/waiting', { preHandler: requireVerifiedUser }, async (req, reply) => {
    const devices = app.repos.devices.listForUser(req.user!.id)
    const ttlMs = config.kobo.queueTtlSeconds * 1000
    const now = Date.now()

    const books = devices.flatMap((device) =>
      app.deliveries.listFor(device.id).map((book) => ({
        id: book.id,
        deviceId: device.id,
        deviceLabel: device.label,
        title: book.title,
        name: book.name,
        size: book.size,
        queuedAt: book.queuedAt.toISOString(),
        expiresIn: Math.max(0, Math.round((book.queuedAt.getTime() + ttlMs - now) / 1000)),
      }))
    )

    books.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
    return reply.send({ books, ttlSeconds: config.kobo.queueTtlSeconds })
  })

  app.get('/api/waiting/count', { preHandler: requireVerifiedUser }, async (req, reply) => {
    const count = app.repos.devices
      .listForUser(req.user!.id)
      .reduce((total, device) => total + app.deliveries.listFor(device.id).length, 0)
    return reply.send({ count })
  })

  app.post<{ Params: IdParams }>(
    '/api/devices/:id/token',
    { preHandler: requireVerifiedUser, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const device = ownedBy(req, req.params.id)
      if (!device) return reply.code(404).send({ ok: false, error: 'Unknown device' })

      const token = app.repos.devices.rotateToken(device.id)
      req.log.info({ deviceId: device.id }, 'Rotated device token')

      return reply.send({ ok: true, token, endpoint: endpointFor(token) })
    }
  )

  function queuedFor(req: FastifyRequest, bookId: string): QueuedBook | null {
    for (const device of app.repos.devices.listForUser(req.user!.id)) {
      const book = app.deliveries.get(bookId, device.id)
      if (book) return book
    }
    return null
  }

  app.delete<{ Params: IdParams }>(
    '/api/waiting/:id',
    { preHandler: requireVerifiedUser, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const book = queuedFor(req, req.params.id)
      if (!book) return reply.code(404).send({ ok: false, error: 'Nothing queued under that id' })

      await app.deliveries.remove(book.id)
      req.log.info({ bookId: book.id }, 'Cancelled a queued book')
      return reply.send({ ok: true })
    }
  )

  app.get<{ Params: IdParams }>(
    '/api/waiting/:id/download',
    { preHandler: requireVerifiedUser, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const book = queuedFor(req, req.params.id)
      if (!book) return reply.code(404).send({ ok: false, error: 'Nothing queued under that id' })

      let size: number
      try {
        size = (await stat(book.path)).size
      } catch {
        req.log.error({ bookId: book.id }, 'Queued file vanished from disk')
        await app.deliveries.remove(book.id)
        return reply.code(404).send({ ok: false, error: 'Nothing queued under that id' })
      }

      reply.header('Content-Type', contentTypeFor(book.format))
      reply.header('Content-Length', size)
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(book.name)}"`)
      return reply.send(createReadStream(book.path))
    }
  )

  app.get('/api/library', { preHandler: requireUser }, async (req, reply) => {
    const user = req.user!
    return reply.send({
      ceilingMinutes: settings.int('RETAIN_DAYS') * 24 * 60,
      chosenMinutes: user.retainMinutes,
      effectiveMinutes: app.library.retainMinutesFor(user.retainMinutes),
      usedBytes: app.repos.books.bytesForUser(user.id),
      limitBytes: settings.int('STORAGE_PER_USER'),
      serverUsedBytes: app.repos.books.bytesTotal(),
      serverLimitBytes: settings.int('STORAGE_TOTAL'),
      books: app.repos.books.listForUser(user.id).length,
    })
  })

  app.patch<{ Body: { minutes?: number | null } }>(
    '/api/library',
    {
      preHandler: requireUser,
      schema: {
        body: {
          type: 'object',
          required: ['minutes'],
          properties: {
            minutes: { type: ['integer', 'null'], minimum: 0, maximum: 3650 * 24 * 60 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.user!
      const asked = req.body.minutes
      const minutes =
        asked === null || asked === undefined
          ? null
          : Math.max(0, Math.min(asked, settings.int('RETAIN_DAYS') * 24 * 60))
      app.repos.users.setRetainMinutes(user.id, minutes)
      req.log.info({ userId: user.id, minutes }, 'Changed how long books are kept')
      return reply.send({
        ok: true,
        chosenMinutes: minutes,
        effectiveMinutes: app.library.retainMinutesFor(minutes),
      })
    }
  )

  function keptBy(req: FastifyRequest, bookId: string): Book | null {
    const book = app.repos.books.byId(bookId)
    return book && book.userId === req.user!.id ? book : null
  }

  app.get('/api/library/books', { preHandler: requireUser }, async (req, reply) => {
    const books = app.repos.books.listForUser(req.user!.id).map((book) => ({
      id: book.id,
      name: book.name,
      title: book.title,
      authors: book.authors,
      format: book.format,
      size: book.size,
      source: book.source,
      createdAt: book.createdAt,
      expiresAt: book.expiresAt,
      hasCover: book.coverPath !== null,
    }))
    return reply.send({
      books,
      retainMinutes: app.library.retainMinutesFor(req.user!.retainMinutes),
    })
  })

  app.get<{ Params: IdParams }>(
    '/api/library/:id/cover',
    { preHandler: requireUser, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const book = keptBy(req, req.params.id)
      if (!book?.coverPath) return reply.code(404).send({ ok: false, error: 'No cover' })

      let size: number
      try {
        size = (await stat(book.coverPath)).size
      } catch {
        req.log.warn({ bookId: book.id }, 'A kept cover vanished from disk')
        return reply.code(404).send({ ok: false, error: 'No cover' })
      }

      reply.header('Content-Type', book.coverType ?? 'application/octet-stream')
      reply.header('Content-Length', size)
      reply.header('Cache-Control', 'private, max-age=86400')
      return reply.send(createReadStream(book.coverPath))
    }
  )

  app.get<{ Params: IdParams }>(
    '/api/library/:id/download',
    { preHandler: requireUser, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const book = keptBy(req, req.params.id)
      if (!book) return reply.code(404).send({ ok: false, error: 'No such book' })

      let size: number
      try {
        size = (await stat(book.path)).size
      } catch {
        req.log.error({ bookId: book.id }, 'A kept book vanished from disk')
        await app.library.forget(book)
        return reply.code(404).send({ ok: false, error: 'No such book' })
      }

      const format = formatFromName(book.name)
      reply.header('Content-Type', format ? contentTypeFor(format) : 'application/octet-stream')
      reply.header('Content-Length', size)
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(book.name)}"`)
      return reply.send(createReadStream(book.path))
    }
  )

  app.delete<{ Params: IdParams }>(
    '/api/library/:id',
    { preHandler: requireUser, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const book = keptBy(req, req.params.id)
      if (!book) return reply.code(404).send({ ok: false, error: 'No such book' })

      await app.library.forget(book)
      req.log.info({ bookId: book.id, userId: req.user!.id }, 'Deleted a kept book')
      return reply.send({ ok: true })
    }
  )

  app.delete<{ Body: Confirmation }>(
    '/api/account',
    { preHandler: requireUser },
    async (req, reply) => {
      const user = req.user!

      if (app.repos.users.isFounder(user.id) && app.repos.users.count() > 1) {
        return reply.code(409).send({
          ok: false,
          error: 'Hand the first account to someone else before deleting it',
        })
      }

      const confirmed = await confirm(req, reply)
      if (!confirmed) return reply

      for (const device of app.repos.devices.listForUser(user.id)) {
        await app.deliveries.removeForDevice(device.id)
      }

      const forgotten = await app.library.forgetUser(user.id)
      if (forgotten > 0) req.log.info({ userId: user.id, books: forgotten }, 'Cleared a library')

      const promoted = app.repos.users.remove(user.id)
      endSession(req)
      req.log.warn({ userId: user.id }, 'Deleted account')
      if (promoted) {
        req.log.warn({ userId: promoted }, 'No admin was left, so the oldest account became one')
      }

      return reply.send({ ok: true, unclaimed: app.auth.unclaimed })
    }
  )

  app.delete<{ Params: IdParams }>(
    '/api/devices/:id',
    { preHandler: requireVerifiedUser, schema: { params: idParamsSchema } },
    async (req, reply) => {
      const device = ownedBy(req, req.params.id)
      if (!device) return reply.code(404).send({ ok: false, error: 'Unknown device' })

      app.repos.devices.remove(device.id)
      req.log.info({ deviceId: device.id }, 'Removed device')
      return reply.send({ ok: true })
    }
  )
}
