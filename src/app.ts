import fastifyHelmet from '@fastify/helmet'
import fastifyMultipart from '@fastify/multipart'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'
import { watchExtensionRuns } from './admin/extensions.js'
import { accounts } from './auth/plugin.js'
import { AuthError } from './auth/service.js'
import { accountsEnabled, config, publicUrl } from './config.js'
import { detectTools, type ToolAvailability } from './convert/index.js'
import { ConversionResults } from './convert/results.js'
import type { Db } from './db/index.js'
import { KeyStore } from './keystore.js'
import { createLogger, newId, resolveLogOptions } from './logging/index.js'
import { Pages } from './pages.js'
import { PendingDeliveries } from './pending.js'
import { convertRoutes } from './routes/convert.js'
import { downloadRoutes } from './routes/download.js'
import { pairRoutes } from './routes/pair.js'
import { uploadRoutes } from './routes/upload.js'

declare module 'fastify' {
  interface FastifyInstance {
    keystore: KeyStore
    conversions: ConversionResults
    pending: PendingDeliveries
    tools: ToolAvailability
  }
  interface FastifyReply {
    page(name: string): FastifyReply
  }
  interface FastifyRequest {
    job?: string
    failure?: string
  }
}

export interface BuildOptions {
  tools?: ToolAvailability
  logger?: FastifyServerOptions['logger']
  accounts?: boolean
  db?: Db
}

export function redactKoboToken(url: string): string {
  return url.replace(/^\/kobo\/[^/?#]+/, '/kobo/[redacted]')
}

const serializers = {
  req(req: FastifyRequest) {
    return {
      method: req.method,
      url: redactKoboToken(req.url),
      host: req.headers.host,
      remoteAddress: req.ip,
    }
  },
}

function defaultLogger(): FastifyBaseLogger {
  return createLogger(resolveLogOptions(), serializers) as unknown as FastifyBaseLogger
}

const HEALTH_PATHS = new Set(['/healthz', '/health', '/readyz'])

function levelFor(status: number): 'error' | 'warn' | 'info' {
  if (status >= 500) return 'error'
  if (status >= 400) return 'warn'
  return 'info'
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    ...(options.logger === undefined
      ? { loggerInstance: defaultLogger() }
      : { logger: options.logger }),
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: true,
    genReqId(req) {
      const given = req.headers['x-request-id']
      if (typeof given === 'string' && given.length > 0 && given.length <= 128) return given
      return newId()
    },
  })

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? redactKoboToken(req.url)
    const status = reply.statusCode
    const level = HEALTH_PATHS.has(route) && status < 400 ? 'debug' : levelFor(status)
    req.log[level](
      {
        scope: 'http',
        job: req.job,
        err: req.failure,
        took: Math.round(reply.elapsedTime * 100) / 100,
        ip: req.ip,
      },
      `${req.method} ${route} ${status}`
    )
  })

  app.setErrorHandler(async (err: FastifyError, req, reply) => {
    if (err instanceof AuthError) {
      req.failure = err.message
      return reply.code(err.statusCode).send({ ok: false, error: err.message })
    }
    const status = err.statusCode ?? 500
    if (status >= 500) req.log.error({ scope: 'server', err }, 'request failed')
    else req.failure = err.message
    return reply
      .code(status)
      .send({ ok: false, error: status >= 500 ? 'Internal error' : err.message })
  })

  app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: 'Not found' }))

  const tools = options.tools ?? (await detectTools())
  app.decorate('tools', tools)
  app.decorate('keystore', new KeyStore(app.log))
  app.decorate('conversions', new ConversionResults(app.log))
  app.decorate('pending', new PendingDeliveries())

  const overHttps = publicUrl().startsWith('https://')

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        ...(overHttps ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    referrerPolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false,
    hsts: overHttps ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  })

  await app.register(fastifyRateLimit, {
    global: false,
  })

  await app.register(fastifyMultipart, {
    throwFileSizeLimit: false,
    limits: {
      fileSize: config.maxFileSize,
      files: 1,
      fields: 16,
      fieldSize: 8 * 1024,
    },
  })

  await app.register(fastifyStatic, {
    root: config.staticDir,
    index: false,
    cacheControl: true,
    maxAge: '5m',
  })

  const pages = new Pages(config.staticDir, process.env.NODE_ENV === 'production')
  app.decorateReply('page', function (this: FastifyReply, name: string) {
    const html = pages.html(name)
    if (html === null) {
      this.callNotFound()
      return this
    }
    return this.type('text/html; charset=utf-8').send(html)
  })

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.split('?')[0]?.endsWith('.html')) return reply.callNotFound()
  })

  app.addHook('onSend', async (_req, reply) => {
    const type = reply.getHeader('content-type')
    if (typeof type === 'string' && type.includes('text/html')) {
      reply.header('Cache-Control', 'no-cache')
    }
    reply.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'
    )
  })

  app.addContentTypeParser('*', { bodyLimit: 1024 }, (_req, payload, done) => {
    payload.resume()
    payload.on('end', () => done(null, undefined))
    payload.on('error', done)
  })

  const withAccounts = options.accounts ?? accountsEnabled()
  if (withAccounts) {
    await app.register(accounts, options.db ? { db: options.db } : {})
  }

  watchExtensionRuns(app)

  await app.register(pairRoutes)
  await app.register(uploadRoutes)
  await app.register(convertRoutes)
  await app.register(downloadRoutes)

  app.addHook('onClose', async () => {
    await app.keystore.clear()
    await app.conversions.clear()
  })

  return app
}
