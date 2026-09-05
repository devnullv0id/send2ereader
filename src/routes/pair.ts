import type { FastifyInstance } from 'fastify'
import { detectDevice, deviceLabel } from '../device.js'
import { KeyOverflowError, silentAfterSeconds } from '../keystore.js'
import { say } from '../language.js'
import { settings } from '../settings.js'

interface KeyParams {
  key: string
}

const keyParamsSchema = {
  type: 'object',
  required: ['key'],
  properties: {
    key: { type: 'string', minLength: 1, maxLength: 16 },
  },
} as const

function msLeft(deadline: number | null): number {
  if (deadline === null) return 0
  return Math.max(0, deadline - Date.now())
}

export async function pairRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/generate',
    {
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const agent = req.headers['user-agent'] ?? ''
      try {
        const info = app.keystore.create(agent, detectDevice(agent))
        return await reply.type('text/plain; charset=utf-8').send(info.key)
      } catch (err) {
        if (err instanceof KeyOverflowError) {
          req.log.error({ keys: app.keystore.size }, 'Key space exhausted')
          return reply.code(503).type('text/plain; charset=utf-8').send('error')
        }
        throw err
      }
    }
  )

  app.get<{ Params: KeyParams }>(
    '/status/:key',
    { schema: { params: keyParamsSchema } },
    async (req, reply) => {
      const key = req.params.key.toUpperCase()
      const info = app.keystore.get(key)
      if (!info) return reply.code(404).send({ error: say(req, 'Unknown key') })

      if (info.agent !== (req.headers['user-agent'] ?? '')) {
        req.log.warn({ key }, 'User-agent mismatch on status')
        return reply.code(404).send({ error: say(req, 'Unknown key') })
      }

      app.keystore.heard(key)
      return reply.send({
        alive: info.alive,
        expiresIn: settings.int('EXPIRE_SECONDS'),
        file: info.file ? { name: info.file.name, size: info.file.size } : null,
        urls: info.urls,
      })
    }
  )

  app.get<{ Params: KeyParams }>(
    '/key/:key',
    {
      schema: { params: keyParamsSchema },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const info = app.keystore.get(req.params.key.toUpperCase())
      if (!info) return reply.code(404).send({ error: say(req, 'Unknown key') })

      const idleMs = Date.now() - info.alive.getTime()
      const silentFor = Math.floor(idleMs / 1000)
      return reply.send({
        device: info.device,
        label: deviceLabel(info.device),
        hasFile: info.file !== null,
        connected: idleMs < silentAfterSeconds() * 1000,
        silentFor,
        expiresInMs: msLeft(app.keystore.expiresAt(req.params.key.toUpperCase())),
      })
    }
  )

  app.post<{ Params: KeyParams }>(
    '/key/:key/extend',
    {
      schema: { params: keyParamsSchema },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const key = req.params.key.toUpperCase()
      if (!app.keystore.get(key)) return reply.code(404).send({ error: say(req, 'Unknown key') })
      app.keystore.renew(key)
      return reply.send({ ok: true, expiresInMs: msLeft(app.keystore.expiresAt(key)) })
    }
  )

  app.delete<{ Params: KeyParams }>(
    '/file/:key',
    { schema: { params: keyParamsSchema } },
    async (req, reply) => {
      const key = req.params.key.toUpperCase()
      const info = app.keystore.get(key)
      if (!info) return reply.code(404).send({ error: say(req, 'Unknown key') })
      if (info.agent !== (req.headers['user-agent'] ?? '')) {
        return reply.code(404).send({ error: say(req, 'Unknown key') })
      }
      await app.keystore.clearFile(key)
      app.keystore.heard(key)
      return reply.send({ ok: true })
    }
  )
}
