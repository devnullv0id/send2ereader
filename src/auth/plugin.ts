import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { adminRoutes } from '../admin/routes.js'
import { setupRoutes } from '../admin/setup.js'
import { fixPublicUrl } from '../config.js'
import { type Db, openDatabase } from '../db/index.js'
import { createRepositories, type Repositories, type User } from '../db/repositories.js'
import { DeliveryQueue } from '../kobo/queue.js'
import { koboRoutes } from '../kobo/routes.js'
import { KoboStore } from '../kobo/store.js'
import { Library } from '../library.js'
import { createMailer, type Mailer } from '../mail/index.js'
import { deviceRoutes } from '../routes/devices.js'
import { settings } from '../settings.js'
import { OidcService } from './oidc.js'
import { authRoutes } from './routes.js'
import { AuthService } from './service.js'
import { csrfRefusal, registerSession, renewSessionCookie } from './session.js'
import { ssoRoutes } from './sso.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Db
    repos: Repositories
    auth: AuthService
    mailer: Mailer
    deliveries: DeliveryQueue
    library: Library
    koboStore: KoboStore
    oidc: OidcService
    oidcEnabled: boolean
  }
  interface FastifyRequest {
    user: User | null
  }
}

export interface AccountsOptions {
  db?: Db
}

const TOUCH_AFTER_MS = 60_000

async function accountsPlugin(app: FastifyInstance, options: AccountsOptions): Promise<void> {
  const db = options.db ?? openDatabase()
  settings.attach(db)
  fixPublicUrl(settings.str('PROTOCOL'), settings.str('DOMAIN'))
  const repos = createRepositories(db)
  const mailer = createMailer(app.log)

  app.decorate('db', db)
  app.decorate('repos', repos)
  app.decorate('mailer', mailer)
  app.decorate('deliveries', new DeliveryQueue(app.log))
  app.decorate('library', new Library(repos.books, app.log))
  app.decorate('koboStore', new KoboStore(app.log))
  app.decorate('auth', new AuthService(repos, mailer, app.log))

  const oidc = new OidcService(app.log)
  const oidcProblem = OidcService.problem()
  if (oidcProblem) {
    app.log.error({ problem: oidcProblem }, 'SSO is enabled but incomplete — leaving it off')
  }
  app.decorate('oidc', oidc)
  app.decorate('oidcEnabled', oidc.enabled && !oidcProblem)
  app.decorateRequest('user', null)

  await registerSession(app)

  app.addHook('onRequest', async (req, reply) => {
    const refusal = csrfRefusal(req)
    if (refusal) {
      req.log.warn({ url: req.url, method: req.method }, 'Refused a request with no matching token')
      return reply.code(403).send({ ok: false, error: refusal })
    }
  })

  app.addHook('onRequest', async (req) => {
    const userId = req.session.get('userId')
    if (!userId) return
    const user = repos.users.byId(userId)
    if (!user) {
      req.session.delete()
      return
    }

    const sid = req.session.get('sid')
    if (!sid) {
      req.session.delete()
      return
    }

    const session = repos.sessions.byId(sid)
    if (!session) {
      req.session.delete()
      return
    }
    if (Date.now() - Date.parse(session.lastSeenAt) > TOUCH_AFTER_MS) {
      repos.sessions.touch(sid, settings.int('SESSION_TTL'))
      renewSessionCookie(req)
    }

    req.user = user
  })

  await app.register(authRoutes)
  if (app.oidcEnabled) await app.register(ssoRoutes)
  await app.register(adminRoutes)
  await app.register(setupRoutes)
  await app.register(deviceRoutes)
  await app.register(koboRoutes)

  if (!options.db) {
    app.addHook('onClose', async () => {
      db.close()
    })
  }

  app.addHook('onClose', async () => {
    settings.detach()
    await app.mailer.close()
    await app.deliveries.clear()
  })

  const purged = repos.emailTokens.purgeExpired()
  if (purged > 0) app.log.info({ purged }, 'Removed expired e-mail tokens')

  const staleSessions = repos.sessions.purgeExpired()
  if (staleSessions > 0) app.log.info({ purged: staleSessions }, 'Removed expired sessions')

  await app.library.purgeExpired()
  await app.library.sweepOrphans()

  const sweeper = setInterval(
    () => {
      void app.library.purgeExpired()
    },
    60 * 60 * 1000
  )
  sweeper.unref()
  app.addHook('onClose', async () => {
    clearInterval(sweeper)
  })
}

export const accounts = fp(accountsPlugin, { name: 'accounts' })
