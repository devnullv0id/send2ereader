import fastifyHelmet from '@fastify/helmet'
import fastifyMultipart from '@fastify/multipart'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'
import { accounts } from './auth/plugin.js'
import { AuthError } from './auth/service.js'
import { accountsEnabled, config, publicUrl } from './config.js'
import { detectTools, type ToolAvailability } from './convert/index.js'
import { ConversionResults } from './convert/results.js'
import type { Db } from './db/index.js'
import { KeyStore } from './keystore.js'
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
}

export interface BuildOptions {
  tools?: ToolAvailability
  logger?: FastifyServerOptions['logger']
  accounts?: boolean
  db?: Db
}

// A Kobo carries its bearer token in the path because its firmware gives us
// nowhere else to put it, so the one thing we can do is keep it out of the log.
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

function defaultLogger(): FastifyServerOptions['logger'] {
  const base = { level: config.logLevel, serializers }
  if (!config.logPretty) return base
  return {
    ...base,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
    },
  }
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? defaultLogger(),
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  })

  app.setErrorHandler(async (err: FastifyError, req, reply) => {
    if (err instanceof AuthError) {
      req.log.warn({ err: err.message }, 'Auth request rejected')
      return reply.code(err.statusCode).send({ ok: false, error: err.message })
    }
    const status = err.statusCode ?? 500
    if (status >= 500) req.log.error({ err }, 'Request failed')
    else req.log.warn({ err: err.message }, 'Request rejected')
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

  // Both of these are conditional on actually being served over https, and for
  // the same reason. HSTS from a plain-http instance would strand whoever
  // visited it. upgrade-insecure-requests is worse: helmet turns it on by
  // default, and it rewrites every stylesheet, script and font request to
  // https://, so on a plain-http instance nothing loads at all. It is a no-op on
  // localhost, which is a trustworthy origin, so it hides from local testing and
  // only shows up once the app is reached by IP or hostname — which is how a
  // self-hosted app is actually used.
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

  // Pages are rendered rather than sent from disk, so every asset they name can
  // carry a hash of its own contents. In development nothing is cached, because
  // tsx does not restart for a stylesheet and a stale page is how an afternoon
  // goes missing.
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
    // Helmet has no opinion on this one, and an ebook sender has no business
    // asking for any of them.
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
