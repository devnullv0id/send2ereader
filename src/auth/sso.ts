import type { FastifyInstance } from 'fastify'
import { publicUrlFor, safeNext } from '../config.js'
import { settings } from '../settings.js'
import { REDIRECT_PATH } from './oidc.js'
import { AuthError } from './service.js'
import { holdForSecondFactor, startSession } from './session.js'

const AFTER_SSO = '/account'

export async function ssoRoutes(app: FastifyInstance): Promise<void> {
  const oidc = app.oidc

  app.get<{ Querystring: { next?: string } }>('/auth/sso', async (req, reply) => {
    if (req.user) return reply.redirect(safeNext(req.query.next, AFTER_SSO))

    try {
      const request = await oidc.startLogin()
      req.session.set('oidc', {
        state: request.state,
        nonce: request.nonce,
        verifier: request.codeVerifier,
        returnTo: safeNext(req.query.next, AFTER_SSO),
      })
      return await reply.redirect(request.url)
    } catch (err) {
      req.log.error({ err: (err as Error).message }, 'Could not start SSO login')
      return reply.redirect('/login?error=sso')
    }
  })

  app.get(REDIRECT_PATH, async (req, reply) => {
    const pending = req.session.get('oidc')
    req.session.set('oidc', undefined)

    if (!pending) {
      req.log.warn('SSO callback with no pending login in session')
      return reply.redirect('/login?error=sso')
    }

    try {
      const currentUrl = new URL(publicUrlFor(req.url))
      const identity = await oidc.completeLogin(currentUrl, {
        state: pending.state,
        nonce: pending.nonce,
        codeVerifier: pending.verifier,
      })

      const user = app.auth.linkOidcUser({
        issuer: identity.issuer,
        subject: identity.subject,
        email: identity.email,
        emailVerified: identity.emailVerified,
      })

      if (settings.str('OIDC_ADMIN_GROUP')) {
        const grants = oidc.grantsAdmin(identity)
        app.repos.users.setAdmin(user.id, grants)
      }

      if (user.totpEnabled) {
        holdForSecondFactor(req, user, true)
        req.log.info({ userId: user.id }, 'SSO sign-in is waiting on the second factor')
        return await reply.redirect('/login?step=code')
      }

      startSession(req, user)
      req.log.info({ userId: user.id, issuer: identity.issuer }, 'Signed in through SSO')
      return await reply.redirect(pending.returnTo || '/account')
    } catch (err) {
      const message = err instanceof AuthError ? err.message : (err as Error).message
      req.log.error({ err: message }, 'SSO login failed')
      return reply.redirect('/login?error=sso')
    }
  })
}
