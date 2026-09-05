import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config, safeNext } from '../config.js'
import type { Passkey, Session, User } from '../db/repositories.js'
import { duration } from '../mail/template.js'
import { settings } from '../settings.js'
import { passwordRules } from './password.js'
import { NAME_MAX, nameProblem } from './service.js'
import {
  clearPending,
  csrfToken,
  endSession,
  holdForSecondFactor,
  pendingSignIn,
  rejectUnauthenticated,
  rememberChallenge,
  startSession,
  takeChallenge,
} from './session.js'
import {
  authenticationOptions,
  isSecureContext,
  registrationOptions,
  userHandleOf,
  verifyAuthentication,
  verifyRegistration,
} from './webauthn.js'

interface Credentials {
  email?: string
  password?: string
  remember?: boolean
  firstName?: string
  lastName?: string
}

const rememberProperty = { remember: { type: 'boolean' } } as const

const credentialsSchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 320 },
    password: { type: 'string', minLength: 1, maxLength: 1024 },
    ...rememberProperty,
  },
} as const

const registrationSchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 320 },
    password: { type: 'string', minLength: 1, maxLength: 1024 },
    firstName: { type: 'string', maxLength: NAME_MAX },
    lastName: { type: 'string', maxLength: NAME_MAX },
    ...rememberProperty,
  },
} as const

const slowLimit = { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }

const LINK_WATCH_TTL_MS = 30 * 60 * 1000

function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    emailVerified: user.emailVerified,
    isAdmin: user.isAdmin,
    createdAt: user.createdAt,
    hasPassword: user.passwordHash !== null,
    totpEnabled: user.totpEnabled,
    passkeysClearedAt: user.passkeysClearedAt,
    passkeysClearedFrom: user.passkeysClearedFrom,
  }
}

export interface Confirmation {
  password?: string
  code?: string
}

function offered(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

export async function confirm(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const body = (req.body ?? {}) as Confirmation
  const userId = req.user!.id
  const password = offered(body.password, 1024)
  const code = offered(body.code, 64)

  if (await req.server.auth.reauthenticate(userId, password, code)) return true

  await reply.code(403).send({
    ok: false,
    error: 'Confirm it is you first',
    needs: req.server.auth.reauthenticationNeeds(userId),
  })
  return false
}

function isPrefetch(req: FastifyRequest): boolean {
  const headers = req.headers
  const purpose = String(headers['sec-purpose'] ?? headers.purpose ?? headers['x-purpose'] ?? '')
  return purpose.includes('prefetch') || headers['x-moz'] === 'prefetch'
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const auth = app.auth

  app.get('/setup', async (_req, reply) =>
    auth.unclaimed ? reply.page('setup.html') : reply.redirect('/login')
  )

  app.get<{ Querystring: { next?: string } }>('/login', async (req, reply) => {
    if (req.user) return reply.redirect(safeNext(req.query.next))
    return auth.unclaimed ? reply.redirect('/setup') : reply.page('login.html')
  })

  app.get('/register', async (_req, reply) => {
    if (auth.unclaimed) return reply.redirect('/setup')
    return auth.registrationOpen ? reply.page('register.html') : reply.redirect('/login')
  })

  app.get('/settings', async (req, reply) => {
    if (!req.user) return reply.redirect('/login?next=%2Fsettings')
    return reply.page('settings.html')
  })

  app.get('/account', async (req, reply) => {
    const verified = req.query && (req.query as { verified?: string }).verified ? '?verified=1' : ''
    const target = `/settings${verified}#profile`
    if (!req.user) return reply.redirect(`/login?next=${encodeURIComponent(target)}`)
    return reply.redirect(target)
  })

  app.get('/auth/reset', async (_req, reply) => reply.page('reset.html'))
  app.get('/auth/forgot', async (_req, reply) => reply.page('forgot.html'))

  app.get('/auth/status', async (req, reply) => {
    const user = req.user
    return reply.send({
      enabled: true,
      unclaimed: auth.unclaimed,
      registrationOpen: auth.registrationOpen,
      ssoEnabled: app.oidcEnabled,
      ssoProvider: config.oidc.providerName,
      mailEnabled: app.mailer.enabled,
      verificationNeeded: verificationIsPossible(),
      recoveryPhraseInUse: !settings.bool('SMTP_ENABLED'),
      minPasswordLength: settings.int('MIN_PASSWORD_LENGTH'),
      passwordRules: passwordRules(),
      signInLinkLasts: duration(settings.int('SIGNIN_LINK_TTL')),
      emailTokenLasts: duration(settings.int('EMAIL_TOKEN_TTL')),
      user: user ? publicUser(user) : null,
      csrf: csrfToken(req),
      setupPending:
        user !== null && app.repos.users.canAdmin(user.id) && !app.repos.meta.flag('setup_done'),
      verifyNudge: user ? auth.verifyNudge(user) : null,
      pendingEmail: user ? auth.pendingEmail(user.id) : null,
      hasRecoveryPhrase: user ? auth.hasRecoveryPhrase(user.id) : null,
      awaitingSecondFactor: !user && pendingSignIn(req) !== null,
      passkeysPossible: isSecureContext(),
      staySignedIn: settings.bool('ALLOW_STAY_SIGNED_IN'),
      soleAccount: user ? app.repos.users.count() === 1 : null,
    })
  })

  app.post<{ Body: Credentials }>(
    '/auth/register',
    { schema: { body: registrationSchema }, ...slowLimit },
    async (req, reply) => {
      if (req.user) {
        return reply.code(409).send({
          ok: false,
          error: 'Sign out first — creating an account here would sign you into it',
        })
      }

      const claiming = auth.unclaimed
      const user = await auth.register(req.body.email!, req.body.password!, {
        firstName: req.body.firstName,
        lastName: req.body.lastName,
      })
      const recoveryPhrase = auth.recoveryPhraseNeeded ? auth.issueRecoveryPhrase(user.id) : null
      startSession(req, user, req.body.remember !== false)
      return reply.send({
        ok: true,
        claimed: claiming,
        mailEnabled: app.mailer.enabled,
        user: publicUser(user),
        recoveryPhrase,
      })
    }
  )

  app.post<{ Body: Credentials }>(
    '/auth/login',
    { schema: { body: credentialsSchema }, ...slowLimit },
    async (req, reply) => {
      const user = await auth.login(req.body.email!, req.body.password!, {
        when: new Date().toUTCString(),
        where: `${req.ip} — ${req.headers['user-agent'] ?? 'an unknown browser'}`,
      })
      const remember = req.body.remember !== false

      if (user.totpEnabled) {
        holdForSecondFactor(req, user, remember)
        return reply.send({ ok: true, secondFactor: true })
      }

      startSession(req, user, remember)
      return reply.send({ ok: true, user: publicUser(user) })
    }
  )

  app.post<{ Body: { email?: string; phrase?: string; remember?: boolean } }>(
    '/auth/login/recovery',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'phrase'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 320 },
            phrase: { type: 'string', minLength: 1, maxLength: 200 },
            ...rememberProperty,
          },
        },
      },
      ...slowLimit,
    },
    async (req, reply) => {
      const user = await auth.signInWithPhrase(req.body.email!, req.body.phrase!, {
        when: new Date().toUTCString(),
        where: `${req.ip} — ${req.headers['user-agent'] ?? 'an unknown browser'}`,
      })
      const remember = req.body.remember !== false

      if (user.totpEnabled) {
        holdForSecondFactor(req, user, remember)
        return reply.send({ ok: true, secondFactor: true })
      }

      startSession(req, user, remember)
      return reply.send({ ok: true, user: publicUser(user), setAPassword: true })
    }
  )

  app.get('/auth/recovery-phrase', { preHandler: requireUser }, async (req, reply) =>
    reply.send({
      ok: true,
      has: auth.hasRecoveryPhrase(req.user!.id),
      needed: auth.recoveryPhraseNeeded,
    })
  )

  app.post('/auth/recovery-phrase', { preHandler: requireUser }, async (req, reply) => {
    if (!(await confirm(req, reply))) return reply
    return reply.send({ ok: true, phrase: auth.issueRecoveryPhrase(req.user!.id) })
  })

  app.post<{ Body: { code?: string } }>(
    '/auth/login/second-factor',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
      ...slowLimit,
    },
    async (req, reply) => {
      const pending = pendingSignIn(req)
      if (!pending) {
        return reply.code(440).send({ ok: false, error: 'That sign-in timed out. Start again.' })
      }

      const used = auth.verifySecondFactor(pending.userId, req.body.code!)
      if (!used) return reply.code(401).send({ ok: false, error: 'That code did not match' })

      const user = app.repos.users.byId(pending.userId)
      if (!user) return reply.code(401).send({ ok: false, error: 'That code did not match' })

      clearPending(req)
      app.repos.users.touchLogin(user.id)
      startSession(req, user, pending.remember)
      const left = auth.recoveryCodeCounts(user.id)
      return reply.send({
        ok: true,
        user: publicUser(user),
        usedRecoveryCode: used === 'recovery',
        recoveryCodesLeft: left.unused,
      })
    }
  )

  app.post('/auth/passkey/login/options', slowLimit, async (req, reply) => {
    const options = await authenticationOptions()
    rememberChallenge(req, options.challenge)
    return reply.send({ ok: true, options })
  })

  app.post<{ Body: { response?: AuthenticationResponseJSON; remember?: boolean } }>(
    '/auth/passkey/login',
    slowLimit,
    async (req, reply) => {
      const challenge = takeChallenge(req)
      const response = req.body?.response
      if (!challenge || !response) {
        return reply.code(400).send({ ok: false, error: 'Start the sign-in again' })
      }

      const stored = app.repos.passkeys.byId(response.id)
      const handle = userHandleOf(response)
      if (!stored || (handle && handle !== stored.userId)) {
        return reply.code(401).send({ ok: false, error: 'That passkey is not known here' })
      }

      const result = await verifyAuthentication(response, challenge, stored)
      if (!result) {
        req.log.warn({ userId: stored.userId }, 'A passkey assertion did not verify')
        return reply.code(401).send({ ok: false, error: 'That passkey did not check out' })
      }

      const user = app.repos.users.byId(stored.userId)
      if (!user) return reply.code(401).send({ ok: false, error: 'That passkey is not known here' })

      app.repos.passkeys.recordUse(stored.id, result.counter)
      const remember = req.body?.remember !== false

      if (user.totpEnabled) {
        holdForSecondFactor(req, user, remember)
        req.log.info({ userId: user.id }, 'A passkey is waiting on the second factor')
        return reply.send({ ok: true, secondFactor: true })
      }

      app.repos.users.touchLogin(user.id)
      startSession(req, user, remember)
      req.log.info({ userId: user.id }, 'Signed in with a passkey')
      return reply.send({ ok: true, user: publicUser(user) })
    }
  )

  app.get('/auth/passkeys', { preHandler: requireUser }, async (req, reply) =>
    reply.send({
      ok: true,
      supported: isSecureContext(),
      passkeys: app.repos.passkeys.listForUser(req.user!.id).map(publicPasskey),
    })
  )

  app.post('/auth/passkeys/options', { preHandler: requireUser }, async (req, reply) => {
    const existing = app.repos.passkeys.listForUser(req.user!.id)
    const options = await registrationOptions(req.user!, existing)
    rememberChallenge(req, options.challenge)
    return reply.send({ ok: true, options })
  })

  app.post<{ Body: { response?: RegistrationResponseJSON; label?: string } }>(
    '/auth/passkeys',
    { preHandler: requireUser },
    async (req, reply) => {
      const challenge = takeChallenge(req)
      const response = req.body?.response
      if (!challenge || !response) {
        return reply.code(400).send({ ok: false, error: 'Start again — that attempt expired' })
      }

      const credential = await verifyRegistration(response, challenge)
      if (!credential) {
        return reply.code(400).send({ ok: false, error: 'That passkey did not check out' })
      }
      if (app.repos.passkeys.byId(credential.id)) {
        return reply.code(409).send({ ok: false, error: 'That passkey is already registered' })
      }

      const label = (req.body.label ?? '').trim().slice(0, 60) || 'Unnamed passkey'
      const saved = app.repos.passkeys.create({ ...credential, userId: req.user!.id, label })
      req.log.info({ userId: req.user!.id }, 'Registered a passkey')
      return reply.send({ ok: true, passkey: publicPasskey(saved) })
    }
  )

  app.delete<{ Params: { id: string }; Body: Confirmation }>(
    '/auth/passkeys/:id',
    { preHandler: requireUser, ...slowLimit },
    async (req, reply) => {
      const key = app.repos.passkeys.byId(req.params.id)
      if (!key || key.userId !== req.user!.id) {
        return reply.code(404).send({ ok: false, error: 'Unknown passkey' })
      }
      const confirmed = await confirm(req, reply)
      if (!confirmed) return reply

      app.repos.passkeys.remove(key.id)
      req.log.info({ userId: req.user!.id }, 'Removed a passkey')
      return reply.send({ ok: true })
    }
  )

  app.get('/auth/tfa', { preHandler: requireUser }, async (req, reply) =>
    reply.send({
      ok: true,
      enabled: req.user!.totpEnabled,
      recoveryCodes: auth.recoveryCodeCounts(req.user!.id),
    })
  )

  app.post('/auth/tfa/begin', { preHandler: requireVerifiedUser }, async (req, reply) => {
    const setup = auth.beginTotp(req.user!.id)
    return reply.send({ ok: true, typed: setup.typed, uri: setup.uri, svg: setup.svg })
  })

  app.post<{ Body: { code?: string } }>(
    '/auth/tfa/confirm',
    {
      preHandler: requireVerifiedUser,
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 16 } },
        },
      },
      ...slowLimit,
    },
    async (req, reply) => {
      const codes = auth.confirmTotp(req.user!.id, req.body.code!)
      return reply.send({ ok: true, codes })
    }
  )

  app.post<{ Body: Confirmation }>(
    '/auth/tfa/disable',
    { preHandler: requireUser, ...slowLimit },
    async (req, reply) => {
      const confirmed = await confirm(req, reply)
      if (!confirmed) return reply

      auth.disableTotp(req.user!.id)
      return reply.send({ ok: true })
    }
  )

  app.post<{ Body: Confirmation }>(
    '/auth/tfa/codes',
    { preHandler: requireUser, ...slowLimit },
    async (req, reply) => {
      if (!req.user!.totpEnabled) {
        return reply.code(409).send({ ok: false, error: 'Two-factor is not on for this account' })
      }
      const confirmed = await confirm(req, reply)
      if (!confirmed) return reply

      return reply.send({ ok: true, codes: auth.issueRecoveryCodes(req.user!.id) })
    }
  )

  app.post('/auth/login/cancel', async (req, reply) => {
    clearPending(req)
    return reply.send({ ok: true })
  })

  app.post('/auth/logout', async (req, reply) => {
    endSession(req)
    return reply.send({ ok: true })
  })

  app.get<{ Querystring: { token?: string } }>('/auth/verify', slowLimit, async (req, reply) => {
    if (isPrefetch(req)) return reply.code(204).send()
    try {
      auth.verify(req.query.token ?? '')
      return reply.redirect('/account?verified=1')
    } catch {
      return reply.redirect('/login?error=verify')
    }
  })

  app.post('/auth/verify/resend', slowLimit, async (req, reply) => {
    const user = req.user
    if (!user) return rejectUnauthenticated(req, reply)
    await auth.sendVerification(user)
    return reply.send({ ok: true, mailEnabled: app.mailer.enabled })
  })

  app.post('/auth/verify/remind-later', { preHandler: requireUser }, async (req, reply) => {
    const left = auth.remindLater(req.user!.id)
    return reply.send({ ok: true, remindersLeft: left })
  })

  app.post<{ Body: { email?: string } & Confirmation }>(
    '/auth/email',
    {
      preHandler: requireUser,
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 320 },
            password: { type: 'string', maxLength: 1024 },
            code: { type: 'string', maxLength: 64 },
          },
        },
      },
      ...slowLimit,
    },
    async (req, reply) => {
      if (!(await confirm(req, reply))) return reply
      const pending = await auth.requestEmailChange(req.user!.id, req.body.email!)
      return reply.send({ ok: true, pendingEmail: pending, mailEnabled: app.mailer.enabled })
    }
  )

  app.post('/auth/email/cancel', { preHandler: requireUser }, async (req, reply) =>
    reply.send({ ok: true, dropped: auth.cancelEmailChange(req.user!.id) })
  )

  app.get<{ Querystring: { token?: string } }>(
    '/auth/email/confirm',
    slowLimit,
    async (req, reply) => {
      if (isPrefetch(req)) return reply.code(204).send()
      try {
        const user = auth.confirmEmailChange(req.query.token ?? '')
        if (req.user?.id === user.id) return reply.redirect('/settings?moved=1#profile')
        return reply.redirect('/login?moved=1')
      } catch {
        return reply.redirect('/login?error=email')
      }
    }
  )

  app.post<{ Body: { email?: string; remember?: boolean } }>(
    '/auth/link/request',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 320 },
            ...rememberProperty,
          },
        },
      },
      ...slowLimit,
    },
    async (req, reply) => {
      await auth.requestSignInLink(req.body.email!, req.body.remember !== false)
      req.session.set('linkWatch', Date.now())
      return reply.send({ ok: true })
    }
  )

  app.get('/auth/linked', async (_req, reply) => reply.page('linked.html'))

  app.get<{ Querystring: { token?: string } }>('/auth/link', slowLimit, async (req, reply) => {
    if (isPrefetch(req)) return reply.code(204).send()
    try {
      const started = req.session.get('linkWatch')
      const waiting = typeof started === 'number' && Date.now() - started < LINK_WATCH_TTL_MS

      const { user, persist } = auth.consumeSignInLink(req.query.token ?? '')
      if (user.totpEnabled) {
        holdForSecondFactor(req, user, persist)
        return reply.redirect(waiting ? '/auth/linked' : '/login?step=code')
      }
      startSession(req, user, persist)
      return reply.redirect(waiting ? '/auth/linked' : '/')
    } catch {
      return reply.redirect('/login?error=link')
    }
  })

  app.post<{ Body: { email?: string } }>(
    '/auth/reset/request',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', minLength: 3, maxLength: 320 } },
        },
      },
      ...slowLimit,
    },
    async (req, reply) => {
      await auth.requestReset(req.body.email!)
      return reply.send({ ok: true })
    }
  )

  app.post<{ Body: { token?: string; password?: string; remember?: boolean } }>(
    '/auth/reset',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          properties: {
            token: { type: 'string', minLength: 1, maxLength: 512 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
            ...rememberProperty,
          },
        },
      },
      ...slowLimit,
    },
    async (req, reply) => {
      const user = await auth.resetPassword(req.body.token!, req.body.password!)
      const remember = req.body.remember !== false

      if (user.totpEnabled) {
        holdForSecondFactor(req, user, remember)
        return reply.send({ ok: true, secondFactor: true })
      }

      startSession(req, user, remember)
      return reply.send({ ok: true, user: publicUser(user) })
    }
  )

  app.post('/auth/passkeys/cleared/ack', { preHandler: requireUser }, async (req, reply) => {
    app.repos.users.acknowledgePasskeysCleared(req.user!.id)
    return reply.send({ ok: true })
  })

  app.post<{ Body: { firstName?: string; lastName?: string } }>(
    '/auth/name',
    {
      preHandler: requireUser,
      schema: {
        body: {
          type: 'object',
          required: ['firstName', 'lastName'],
          properties: {
            firstName: { type: 'string', maxLength: NAME_MAX },
            lastName: { type: 'string', maxLength: NAME_MAX },
          },
        },
      },
    },
    async (req, reply) => {
      const firstName = (req.body.firstName ?? '').trim()
      const lastName = (req.body.lastName ?? '').trim()

      const problem = nameProblem(firstName, lastName)
      if (problem) return reply.code(400).send({ ok: false, error: problem })

      app.repos.users.setName(req.user!.id, firstName, lastName)
      return reply.send({ ok: true, user: publicUser(app.repos.users.byId(req.user!.id)!) })
    }
  )

  app.post<{ Body: { current?: string; password?: string } }>(
    '/auth/password',
    {
      preHandler: requireUser,
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          properties: {
            current: { type: 'string', maxLength: 1024 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
      ...slowLimit,
    },
    async (req, reply) => {
      await auth.changePassword(req.user!.id, req.body.current ?? '', req.body.password!, {
        when: new Date().toUTCString(),
        where: `${req.ip} — ${req.headers['user-agent'] ?? 'an unknown browser'}`,
      })

      const sid = req.session.get('sid')
      const ended = sid ? app.repos.sessions.revokeOthers(req.user!.id, sid) : 0
      if (ended > 0) req.log.info({ userId: req.user!.id, ended }, 'Password change ended sessions')

      return reply.send({ ok: true, ended })
    }
  )

  app.get('/auth/sessions', { preHandler: requireUser }, async (req, reply) => {
    const current = req.session.get('sid') ?? ''
    const sessions = app.repos.sessions
      .listForUser(req.user!.id)
      .map((session) => publicSession(session, current))
    return reply.send({ ok: true, sessions })
  })

  app.delete<{ Params: { id: string } }>(
    '/auth/sessions/:id',
    { preHandler: requireUser },
    async (req, reply) => {
      const session = app.repos.sessions.byId(req.params.id)
      if (!session || session.userId !== req.user!.id) {
        return reply.code(404).send({ ok: false, error: 'Unknown session' })
      }
      if (session.id === req.session.get('sid')) {
        return reply.code(400).send({ ok: false, error: 'Use sign out for this browser' })
      }
      app.repos.sessions.revoke(session.id)
      req.log.info({ userId: req.user!.id }, 'Ended another session')
      return reply.send({ ok: true })
    }
  )

  app.post('/auth/sessions/revoke-others', { preHandler: requireUser }, async (req, reply) => {
    const sid = req.session.get('sid')
    if (!sid) return reply.code(409).send({ ok: false, error: 'This session has no record' })
    const ended = app.repos.sessions.revokeOthers(req.user!.id, sid)
    req.log.info({ userId: req.user!.id, ended }, 'Signed out everywhere else')
    return reply.send({ ok: true, ended })
  })
}

function publicPasskey(key: Passkey) {
  return {
    id: key.id,
    label: key.label,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
  }
}

function publicSession(session: Session, currentId: string) {
  return {
    id: session.id,
    current: session.id === currentId,
    userAgent: session.userAgent,
    ip: session.ip,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
  }
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  if (!req.user) return rejectUnauthenticated(req, reply)
  return undefined
}

export function verificationIsPossible(): boolean {
  return settings.bool('SMTP_ENABLED')
}

export async function requireVerifiedUser(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  if (!req.user) return rejectUnauthenticated(req, reply)
  if (!req.user.emailVerified && verificationIsPossible()) {
    return reply.code(403).send({ ok: false, error: 'Confirm your e-mail address first' })
  }
  return undefined
}
