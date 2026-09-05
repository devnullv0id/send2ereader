import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { issuerFromConfigUrl, REDIRECT_PATH } from '../auth/oidc.js'
import { publicUrl } from '../config.js'
import { requestLanguage, say } from '../language.js'
import { smtpProblem } from '../mail/index.js'
import { setupTestEmail } from '../mail/template.js'
import { settings } from '../settings.js'
import { restarter } from './restart.js'

const SETUP_DONE = 'setup_done'

const DISCOVERY_TIMEOUT_MS = 8000

function requireSetupAdmin(req: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  const user = req.user
  if (!user) {
    const wantsHtml = (req.headers.accept ?? '').includes('text/html')
    if (wantsHtml) return reply.redirect('/login?next=%2Fsetup%2Fstart')
    return reply.code(401).send({ ok: false, error: say(req, 'Not signed in') })
  }
  if (!req.server.repos.users.canAdmin(user.id)) {
    return reply.code(404).send({ ok: false, error: say(req, 'Not found') })
  }
  return undefined
}

function setupDone(app: FastifyInstance): boolean {
  return app.repos.meta.flag(SETUP_DONE)
}

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/setup/start', async (req, reply) => {
    const refused = requireSetupAdmin(req, reply)
    if (refused) return refused
    return reply.page('setup-wizard.html')
  })

  app.get('/api/setup', async (req, reply) => {
    const refused = requireSetupAdmin(req, reply)
    if (refused) return refused

    return reply.send({
      ok: true,
      done: setupDone(app),
      canRestart: restarter.canRestart,
      runningAddress: publicUrl(),
      mailEnabled: settings.bool('SMTP_ENABLED'),
    })
  })

  app.post('/api/setup/complete', async (req, reply) => {
    const refused = requireSetupAdmin(req, reply)
    if (refused) return refused

    app.repos.meta.set(SETUP_DONE, '1')
    req.log.info({ by: req.user!.id }, 'First-run setup was completed')
    return reply.send({ ok: true, done: true })
  })

  app.post('/api/setup/sso/test', async (req, reply) => {
    const refused = requireSetupAdmin(req, reply)
    if (refused) return refused

    const configUrl = settings.str('OIDC_CONFIG_URL').trim()
    if (!configUrl) {
      return reply.code(409).send({
        ok: false,
        error: say(req, 'There is no discovery document to ask. Fill that in first.'),
      })
    }

    const url = `${issuerFromConfigUrl(configUrl)}/.well-known/openid-configuration`
    let doc: Record<string, unknown>
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      })
      if (!res.ok) {
        return reply.code(502).send({
          ok: false,
          error: say(req, '{url} answered {status}, not a discovery document', {
            url,
            status: res.status,
          }),
        })
      }
      doc = (await res.json()) as Record<string, unknown>
    } catch (err) {
      req.log.warn({ err, url }, 'The provider did not answer')
      return reply.code(502).send({
        ok: false,
        error: say(req, 'Could not reach {url}: {message}', {
          url,
          message: (err as Error).message,
        }),
      })
    }

    const missing = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'].filter(
      (key) => typeof doc[key] !== 'string'
    )
    if (missing.length > 0) {
      return reply.code(502).send({
        ok: false,
        error: say(req, 'That answered, but it is not a complete provider: no {missing}.', {
          missing: missing.join(', '),
        }),
      })
    }

    return reply.send({
      ok: true,
      issuer: String(doc.issuer),
      redirect: publicUrl() + REDIRECT_PATH,
      clientIdSet: settings.str('OIDC_CLIENT_ID').length > 0,
    })
  })

  app.post('/api/setup/mail/test', async (req, reply) => {
    const refused = requireSetupAdmin(req, reply)
    if (refused) return refused

    if (!settings.bool('SMTP_ENABLED')) {
      return reply.code(409).send({
        ok: false,
        error: say(req, 'Mail is off, so there is nothing to test. Turn it on first.'),
      })
    }

    const missing = smtpProblem()
    if (missing) return reply.code(409).send({ ok: false, error: say(req, missing) })

    const to = req.user!.email
    try {
      await app.mailer.send({ to, ...setupTestEmail(publicUrl(), requestLanguage(req)) })
    } catch (err) {
      req.log.warn({ err }, 'The test message did not go out')
      return reply.code(502).send({
        ok: false,
        error: (err as Error).message || say(req, 'The mail server would not take it'),
      })
    }
    return reply.send({ ok: true, to })
  })
}
