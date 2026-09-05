import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import fastifySecureSession from '@fastify/secure-session'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { publicUrl, sessionSecret } from '../config.js'
import type { User } from '../db/repositories.js'
import { say } from '../language.js'
import { settings } from '../settings.js'

declare module '@fastify/secure-session' {
  interface SessionData {
    userId: string
    sid: string
    persist: boolean
    oidc: { state: string; nonce: string; verifier: string; returnTo: string }
    pending: { userId: string; remember: boolean; at: number }
    linkWatch: number
    challenge: { value: string; at: number }
  }
}

const PENDING_TTL_MS = 10 * 60 * 1000
const CHALLENGE_TTL_MS = 5 * 60 * 1000

export async function registerSession(app: FastifyInstance): Promise<void> {
  await app.register(fastifySecureSession, {
    key: createHash('sha256').update(sessionSecret()).digest(),
    cookieName: 's2e_session',
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: publicUrl().startsWith('https://'),
    },
  })
}

export function startSession(req: FastifyRequest, user: User, wanted = true): void {
  const persist = settings.bool('ALLOW_STAY_SIGNED_IN') && wanted
  req.session.regenerate()
  const session = req.server.repos.sessions.create(
    user.id,
    settings.int('SESSION_TTL'),
    req.headers['user-agent'] ?? '',
    req.ip
  )
  req.session.set('userId', user.id)
  req.session.set('sid', session.id)
  req.session.set('persist', persist)
  if (persist) req.session.options({ maxAge: settings.int('SESSION_TTL') })
}

export function holdForSecondFactor(req: FastifyRequest, user: User, remember: boolean): void {
  req.session.regenerate()
  req.session.set('pending', { userId: user.id, remember, at: Date.now() })
}

export function pendingSignIn(req: FastifyRequest): { userId: string; remember: boolean } | null {
  const pending = req.session.get('pending')
  if (!pending) return null
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    req.session.set('pending', undefined)
    return null
  }
  return { userId: pending.userId, remember: pending.remember }
}

export function clearPending(req: FastifyRequest): void {
  req.session.set('pending', undefined)
}

export function rememberChallenge(req: FastifyRequest, value: string): void {
  req.session.set('challenge', { value, at: Date.now() })
}

export function takeChallenge(req: FastifyRequest): string | null {
  const held = req.session.get('challenge')
  req.session.set('challenge', undefined)
  if (!held) return null
  return Date.now() - held.at > CHALLENGE_TTL_MS ? null : held.value
}

export function renewSessionCookie(req: FastifyRequest): void {
  if (req.session.get('persist') === false) return
  req.session.options({ maxAge: settings.int('SESSION_TTL') })
  req.session.touch()
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function csrfToken(req: FastifyRequest): string | null {
  const sid = req.session.get('sid')
  if (!sid) return null
  return createHmac('sha256', sessionSecret()).update(`csrf:${sid}`).digest('base64url')
}

function sameToken(a: string, b: string): boolean {
  const mine = Buffer.from(a)
  const theirs = Buffer.from(b)
  return mine.length === theirs.length && timingSafeEqual(mine, theirs)
}

export function csrfRefusal(req: FastifyRequest): string | null {
  if (SAFE_METHODS.has(req.method)) return null

  if (req.url.startsWith('/kobo/')) return null

  if (!req.session.get('userId')) return null

  const expected = csrfToken(req)
  if (!expected) return null

  const offered = req.headers['x-csrf-token']
  if (typeof offered !== 'string' || !sameToken(expected, offered)) {
    return 'That request did not come from a page on this site'
  }
  return null
}

export function endSession(req: FastifyRequest): void {
  const sid = req.session.get('sid')
  if (sid) req.server.repos.sessions.revoke(sid)
  req.session.delete()
}

export function rejectUnauthenticated(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const wantsHtml = (req.headers.accept ?? '').includes('text/html')
  if (!wantsHtml) return reply.code(401).send({ ok: false, error: say(req, 'Not signed in') })
  const returnTo = encodeURIComponent(req.url)
  return reply.redirect(`/login?next=${returnTo}`)
}
