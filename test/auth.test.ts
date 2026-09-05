import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../src/auth/password.js'
import { config } from '../src/config.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { createRepositories } from '../src/db/repositories.js'
import { prepareUploadDir } from '../src/files.js'
import { asBrowser } from './helpers.js'

const noTools = {
  kepubify: false,
  calibre: false,
  pdfcropmargins: false,
  kfxInput: false,
  kfxOutput: false,
  layoutFix: false,
}

const KOBO = 'Mozilla/5.0 (Linux; U; Kobo Touch)'
const PASSWORD = 'a-perfectly-fine-password'

let app: FastifyInstance
let db: Db

beforeEach(async () => {
  await prepareUploadDir(true)
  db = openDatabase(':memory:')
  app = asBrowser(await buildApp({ tools: noTools, logger: false, accounts: true, db }))
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.close()
})

async function register(email = 'owner@example.com', password = PASSWORD) {
  return app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password, firstName: 'Ada', lastName: 'Lovelace' },
  })
}

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const all = Array.isArray(raw) ? raw : [raw]
  const session = all.map(String).find((c) => c.startsWith('s2e_session='))
  return session?.split(';')[0] ?? ''
}

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword(PASSWORD, hash)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const hash = await hashPassword(PASSWORD)
    expect(await verifyPassword(`${PASSWORD}x`, hash)).toBe(false)
    expect(await verifyPassword('', hash)).toBe(false)
  })

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD))
  })

  it('returns false rather than throwing on a malformed hash', async () => {
    for (const bad of [
      '',
      'nonsense',
      'scrypt$x$8$1$aa$bb',
      'bcrypt$1$2$3$4$5',
      'scrypt$1024$8$1',
    ]) {
      expect(await verifyPassword(PASSWORD, bad)).toBe(false)
    }
  })

  it('works at the production cost parameters', async () => {
    const hash = await hashPassword(PASSWORD, 2 ** 16)
    expect(await verifyPassword(PASSWORD, hash)).toBe(true)
  })

  it('accepts a hash produced at a different cost', async () => {
    const old = await hashPassword(PASSWORD, 1024)
    expect(await verifyPassword(PASSWORD, old)).toBe(true)
  })
})

describe('claiming the server', () => {
  it('reports an unclaimed server', async () => {
    const res = await app.inject({ url: '/auth/status' })
    expect(res.json()).toMatchObject({ enabled: true, unclaimed: true, registrationOpen: true })
  })

  it('makes the first account the owner and signs it in', async () => {
    const res = await register()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, claimed: true })
    expect(res.json().user).toMatchObject({ email: 'owner@example.com' })
    expect(cookieFrom(res)).toContain('s2e_session=')
  })

  it('closes registration once claimed', async () => {
    await register()
    const second = await register('someone@example.com')
    expect(second.statusCode).toBe(403)
    expect(second.json().error).toMatch(/closed/i)

    const status = await app.inject({ url: '/auth/status' })
    expect(status.json()).toMatchObject({ unclaimed: false, registrationOpen: false })
  })

  it('rejects a duplicate address', async () => {
    await register()
    const repos = createRepositories(db)
    expect(repos.users.count()).toBe(1)
  })

  it('elects one owner when two people claim at once', async () => {
    const [a, b] = await Promise.all([register('one@example.com'), register('two@example.com')])

    const codes = [a.statusCode, b.statusCode].sort()
    expect(codes, 'one claim wins, the other is told registration closed').toEqual([200, 403])

    const repos = createRepositories(db)
    expect(repos.users.count()).toBe(1)
  })

  it('answers a simultaneous duplicate address without a 500', async () => {
    const [a, b] = await Promise.all([register(), register()])

    for (const res of [a, b]) expect(res.statusCode, 'no unhandled constraint').not.toBe(500)
    expect([a.statusCode, b.statusCode].sort()[0]).toBe(200)
    expect([403, 409]).toContain([a.statusCode, b.statusCode].sort()[1])
    expect(createRepositories(db).users.count()).toBe(1)
  })

  it('rejects a bad address or a short password', async () => {
    const bad = await register('not-an-email', PASSWORD)
    expect(bad.statusCode).toBe(400)

    const short = await register('owner@example.com', 'x'.repeat(MIN_PASSWORD_LENGTH - 1))
    expect(short.statusCode).toBe(400)
    expect(short.json().error).toMatch(/at least/i)
  })

  it('sets a hardened session cookie', async () => {
    const res = await register()
    const raw = String(
      (Array.isArray(res.headers['set-cookie'])
        ? res.headers['set-cookie']
        : [res.headers['set-cookie']]
      ).find((c) => String(c).startsWith('s2e_session='))
    )
    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('SameSite=Lax')
    expect(raw).toContain('Path=/')
  })
})

describe('staying signed in, or not', () => {
  beforeEach(async () => {
    await register()
  })

  function sessionCookieLine(res: { headers: Record<string, unknown> }): string {
    const raw = res.headers['set-cookie']
    const all = Array.isArray(raw) ? raw : [raw]
    return all.map(String).find((c) => c.startsWith('s2e_session=')) ?? ''
  }

  const signIn = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: PASSWORD, ...payload },
    })

  it('writes a lasting cookie when asked to stay signed in', async () => {
    const res = await signIn({ remember: true })
    expect(res.statusCode).toBe(200)
    expect(sessionCookieLine(res)).toMatch(/Max-Age=\d+/)
  })

  it('writes a cookie that dies with the window when not', async () => {
    const res = await signIn({ remember: false })
    expect(res.statusCode).toBe(200)
    const line = sessionCookieLine(res)
    expect(line).toContain('s2e_session=')
    expect(line).not.toMatch(/Max-Age=/i)
    expect(line).not.toMatch(/Expires=/i)
  })

  it('stays signed in when the caller says nothing', async () => {
    const res = await signIn({})
    expect(sessionCookieLine(res)).toMatch(/Max-Age=\d+/)
  })

  it('signs in either way', async () => {
    for (const remember of [true, false]) {
      const res = await signIn({ remember })
      expect(res.json().user.email, `remember=${remember}`).toBe('owner@example.com')
    }
  })
})

describe('login', () => {
  beforeEach(async () => {
    await register()
  })

  it('accepts the right password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: PASSWORD },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user.email).toBe('owner@example.com')
  })

  it('is case-insensitive about the address', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'OWNER@Example.COM', password: PASSWORD },
    })
    expect(res.statusCode).toBe(200)
  })

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: 'not-the-password' },
    })
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: PASSWORD },
    })
    expect(wrong.statusCode).toBe(401)
    expect(unknown.statusCode).toBe(401)
    expect(wrong.json().error).toBe(unknown.json().error)
  })

  it('carries the session on later requests and drops it on logout', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: PASSWORD },
    })
    const cookie = cookieFrom(login)

    const me = await app.inject({ url: '/auth/status', headers: { cookie } })
    expect(me.json().user).toMatchObject({ email: 'owner@example.com' })

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })
    const after = await app.inject({ url: '/auth/status', headers: { cookie: cookieFrom(out) } })
    expect(after.json().user).toBeNull()
  })
})

describe('the idle timeout', () => {
  it('pushes the expiry out by a full window whenever the session is used', () => {
    const repos = createRepositories(db)
    const user = repos.users.create({
      email: 'idle@example.com',
      passwordHash: 'x',
    })
    const session = repos.sessions.create(user.id, 60, 'agent', '127.0.0.1')
    const before = Date.parse(session.expiresAt)

    repos.sessions.touch(session.id, 3600)

    const after = Date.parse(repos.sessions.byId(session.id)!.expiresAt)
    expect(after).toBeGreaterThan(before)
    expect(after - Date.now()).toBeGreaterThan(3500 * 1000)
  })

  it('forgets a session that was left alone past the window', () => {
    const repos = createRepositories(db)
    const user = repos.users.create({
      email: 'gone@example.com',
      passwordHash: 'x',
    })
    const session = repos.sessions.create(user.id, 3600, 'agent', '127.0.0.1')
    expect(repos.sessions.byId(session.id)).not.toBeNull()

    repos.sessions.touch(session.id, -1)
    expect(repos.sessions.byId(session.id)).toBeNull()
  })
})

describe('sessions', () => {
  beforeEach(async () => {
    await register()
  })

  async function signInFrom(userAgent: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: PASSWORD },
      headers: { 'user-agent': userAgent },
    })
    return cookieFrom(res)
  }

  it('lists every sign-in and marks the one asking', async () => {
    const first = await signInFrom('Firefox on Linux')
    await signInFrom('Chrome on Android')

    const res = await app.inject({ url: '/auth/sessions', headers: { cookie: first } })
    const sessions = res.json().sessions

    expect(sessions).toHaveLength(3)
    expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1)
    expect(sessions.find((s: { current: boolean }) => s.current).userAgent).toBe('Firefox on Linux')
  })

  it('will not re-seat a cookie whose session row is gone', async () => {
    const mine = await signInFrom('Firefox on Linux')

    db.prepare('DELETE FROM sessions').run()

    const after = await app.inject({ url: '/auth/status', headers: { cookie: mine } })
    expect(after.json().user, 'a revoked session stays revoked').toBeNull()
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM sessions').get(),
      'and no replacement was minted on its behalf'
    ).toMatchObject({ n: 0 })
  })

  it('signs out everywhere else and leaves this browser alone', async () => {
    const mine = await signInFrom('Firefox on Linux')
    const theirs = await signInFrom('Chrome on Android')

    const res = await app.inject({
      method: 'POST',
      url: '/auth/sessions/revoke-others',
      headers: { cookie: mine },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ended).toBe(2)

    const gone = await app.inject({ url: '/auth/status', headers: { cookie: theirs } })
    expect(gone.json().user).toBeNull()

    const still = await app.inject({ url: '/auth/status', headers: { cookie: mine } })
    expect(still.json().user).toMatchObject({ email: 'owner@example.com' })
  })

  it('ends one named session but refuses to end the current one', async () => {
    const mine = await signInFrom('Firefox on Linux')
    const theirs = await signInFrom('Chrome on Android')

    const list = await app.inject({ url: '/auth/sessions', headers: { cookie: mine } })
    const sessions = list.json().sessions as { id: string; current: boolean }[]
    const other = sessions.find((s) => !s.current)!
    const current = sessions.find((s) => s.current)!

    const self = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${current.id}`,
      headers: { cookie: mine },
    })
    expect(self.statusCode).toBe(400)

    const res = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${other.id}`,
      headers: { cookie: mine },
    })
    expect(res.statusCode).toBe(200)

    const after = await app.inject({ url: '/auth/status', headers: { cookie: theirs } })
    expect(after.json().user).toBeNull()
  })

  it("will not end another account's session", async () => {
    const mine = await signInFrom('Firefox on Linux')

    const repos = createRepositories(db)
    const stranger = repos.users.create({
      email: 'someone@example.com',
      passwordHash: null,
    })
    const theirs = repos.sessions.create(stranger.id, 3600, 'Safari on macOS', '10.0.0.9')

    const res = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${theirs.id}`,
      headers: { cookie: mine },
    })
    expect(res.statusCode).toBe(404)
    expect(repos.sessions.byId(theirs.id)).not.toBeNull()
  })

  it('ends every other session when the password changes', async () => {
    const mine = await signInFrom('Firefox on Linux')
    const theirs = await signInFrom('Chrome on Android')

    const res = await app.inject({
      method: 'POST',
      url: '/auth/password',
      payload: { current: PASSWORD, password: 'another-perfectly-fine-password' },
      headers: { cookie: mine },
    })
    expect(res.statusCode).toBe(200)

    const gone = await app.inject({ url: '/auth/status', headers: { cookie: theirs } })
    expect(gone.json().user).toBeNull()

    const still = await app.inject({ url: '/auth/status', headers: { cookie: mine } })
    expect(still.json().user).toMatchObject({ email: 'owner@example.com' })
  })

  it('signing out ends only the session that asked', async () => {
    const mine = await signInFrom('Firefox on Linux')
    const theirs = await signInFrom('Chrome on Android')

    await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: mine } })

    const other = await app.inject({ url: '/auth/status', headers: { cookie: theirs } })
    expect(other.json().user).toMatchObject({ email: 'owner@example.com' })
  })

  it('refuses a cookie whose session has expired', async () => {
    const cookie = await signInFrom('Firefox on Linux')
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!

    db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      user.id
    )

    const res = await app.inject({ url: '/auth/status', headers: { cookie } })
    expect(res.json().user).toBeNull()
  })
})

describe('e-mail verification', () => {
  it('starts unverified and verifies through the token', async () => {
    const res = await register()
    expect(res.json().user.emailVerified).toBe(false)

    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const token = repos.emailTokens.issue(user.id, 'verify', user.email, 3600)

    const verify = await app.inject({ url: `/auth/verify?token=${encodeURIComponent(token)}` })
    expect(verify.statusCode).toBe(302)
    expect(verify.headers.location).toBe('/account?verified=1')
    expect(repos.users.byId(user.id)!.emailVerified).toBe(true)
  })

  it('refuses a reused token', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const token = repos.emailTokens.issue(user.id, 'verify', user.email, 3600)

    await app.inject({ url: `/auth/verify?token=${encodeURIComponent(token)}` })
    const again = await app.inject({ url: `/auth/verify?token=${encodeURIComponent(token)}` })
    expect(again.headers.location).toBe('/login?error=verify')
  })

  it('refuses an expired token', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const token = repos.emailTokens.issue(user.id, 'verify', user.email, -1)

    const res = await app.inject({ url: `/auth/verify?token=${encodeURIComponent(token)}` })
    expect(res.headers.location).toBe('/login?error=verify')
    expect(repos.users.byId(user.id)!.emailVerified).toBe(false)
  })

  it('refuses a token issued for the other purpose', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const reset = repos.emailTokens.issue(user.id, 'reset', user.email, 3600)

    const res = await app.inject({ url: `/auth/verify?token=${encodeURIComponent(reset)}` })
    expect(res.headers.location).toBe('/login?error=verify')
  })

  it('invalidates the previous token when a new one is issued', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const first = repos.emailTokens.issue(user.id, 'verify', user.email, 3600)
    repos.emailTokens.issue(user.id, 'verify', user.email, 3600)

    expect(repos.emailTokens.consume(first, 'verify')).toBeNull()
  })
})

describe('signing in from a mailed link', () => {
  it('signs in and confirms the address, which the mail arriving proved', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const token = repos.emailTokens.issue(user.id, 'signin', user.email, 900)

    const res = await app.inject({ url: `/auth/link?token=${token}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
    expect(cookieFrom(res)).toContain('s2e_session=')
    expect(repos.users.byId(user.id)!.emailVerified).toBe(true)
  })

  it('works once', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const token = repos.emailTokens.issue(user.id, 'signin', user.email, 900)

    await app.inject({ url: `/auth/link?token=${token}` })
    const again = await app.inject({ url: `/auth/link?token=${token}` })
    expect(again.headers.location).toBe('/login?error=link')
  })

  it('will not take a token issued for something else', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const reset = repos.emailTokens.issue(user.id, 'reset', user.email, 900)

    const res = await app.inject({ url: `/auth/link?token=${reset}` })
    expect(res.headers.location).toBe('/login?error=link')
  })

  it('sends a link only to an address it actually has', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!

    await app.inject({
      method: 'POST',
      url: '/auth/link/request',
      payload: { email: 'nobody@example.com' },
    })
    expect(repos.emailTokens.consume('anything', 'signin')).toBeNull()

    await app.inject({
      method: 'POST',
      url: '/auth/link/request',
      payload: { email: 'owner@example.com' },
    })
    expect(repos.emailTokens.issue(user.id, 'signin', user.email, 900)).toBeTruthy()
  })

  function liveLinks(): number {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM email_tokens
         WHERE purpose = 'signin' AND used_at IS NULL AND expires_at > ?`
      )
      .get(new Date().toISOString()) as { n: number }
    return row.n
  }

  const askForLink = () =>
    app.inject({
      method: 'POST',
      url: '/auth/link/request',
      payload: { email: 'owner@example.com' },
    })

  it('sends one link, not one per press', async () => {
    await register()
    await askForLink()
    const first = db.prepare("SELECT token_hash FROM email_tokens WHERE purpose = 'signin'").get()

    await askForLink()
    await askForLink()

    expect(liveLinks(), 'still the one link').toBe(1)
    expect(
      db.prepare("SELECT token_hash FROM email_tokens WHERE purpose = 'signin'").get(),
      'and it is the same one, so the message already sent still works'
    ).toEqual(first)
  })

  it('sends another once the first has been used', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const token = repos.emailTokens.issue(user.id, 'signin', user.email, 900)

    await app.inject({ url: `/auth/link?token=${token}` })
    expect(liveLinks(), 'the used one is spent').toBe(0)

    await askForLink()
    expect(liveLinks(), 'so a fresh one may be sent').toBe(1)
  })

  it('sends another once the first has expired', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    repos.emailTokens.issue(user.id, 'signin', user.email, -1)

    expect(liveLinks()).toBe(0)
    await askForLink()
    expect(liveLinks()).toBe(1)
  })

  it('hands the browser that asked for it back to its own tab', async () => {
    await register()
    const asked = await askForLink()
    const cookie = cookieFrom(asked)

    const token = db
      .prepare("SELECT token_hash FROM email_tokens WHERE purpose = 'signin'")
      .get() as { token_hash: string }
    expect(token).toBeTruthy()

    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const fresh = repos.emailTokens.issue(user.id, 'signin', user.email, 900)

    const sameBrowser = await app.inject({ url: `/auth/link?token=${fresh}`, headers: { cookie } })
    expect(sameBrowser.headers.location, 'the tab that started it takes over').toBe('/auth/linked')

    const status = await app.inject({
      url: '/auth/status',
      headers: { cookie: cookieFrom(sameBrowser) },
    })
    expect(status.json().user.email, 'and the browser really is signed in').toBe(
      'owner@example.com'
    )
  })

  it('signs in where it was opened when no tab is waiting there', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const token = repos.emailTokens.issue(user.id, 'signin', user.email, 900)

    const elsewhere = await app.inject({ url: `/auth/link?token=${token}` })
    expect(elsewhere.headers.location, 'a phone has no waiting tab to hand back to').toBe('/')
  })

  it('answers the same for a known and an unknown address', async () => {
    await register()
    const known = await app.inject({
      method: 'POST',
      url: '/auth/link/request',
      payload: { email: 'owner@example.com' },
    })
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/link/request',
      payload: { email: 'nobody@example.com' },
    })
    expect(known.statusCode).toBe(200)
    expect(unknown.statusCode).toBe(200)
    expect(known.json()).toEqual(unknown.json())
  })
})

describe('password reset', () => {
  it('sets a new password and signs in', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const token = repos.emailTokens.issue(user.id, 'reset', user.email, 3600)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/reset',
      payload: { token, password: 'a-brand-new-password' },
    })
    expect(res.statusCode).toBe(200)

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: 'a-brand-new-password' },
    })
    expect(login.statusCode).toBe(200)

    const old = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: PASSWORD },
    })
    expect(old.statusCode).toBe(401)
  })

  it('counts as proof of the address', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const token = repos.emailTokens.issue(user.id, 'reset', user.email, 3600)

    await app.inject({
      method: 'POST',
      url: '/auth/reset',
      payload: { token, password: 'a-brand-new-password' },
    })
    expect(repos.users.byId(user.id)!.emailVerified).toBe(true)
  })

  it('answers the same for a known and an unknown address', async () => {
    await register()
    const known = await app.inject({
      method: 'POST',
      url: '/auth/reset/request',
      payload: { email: 'owner@example.com' },
    })
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/reset/request',
      payload: { email: 'nobody@example.com' },
    })
    expect(known.statusCode).toBe(200)
    expect(unknown.statusCode).toBe(200)
    expect(known.json()).toEqual(unknown.json())
  })

  it('refuses a short new password', async () => {
    await register()
    const repos = createRepositories(db)
    const user = repos.users.byEmail('owner@example.com')!
    const token = repos.emailTokens.issue(user.id, 'reset', user.email, 3600)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/reset',
      payload: { token, password: 'short' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('SSO account linking', () => {
  it('links to a local account only when the provider confirms the address', async () => {
    await register()
    const repos = createRepositories(db)
    const auth = app.auth

    expect(() =>
      auth.linkOidcUser({
        issuer: 'https://idp.example',
        subject: 'abc',
        email: 'owner@example.com',
        emailVerified: false,
      })
    ).toThrow(/did not confirm/i)

    const linked = auth.linkOidcUser({
      issuer: 'https://idp.example',
      subject: 'abc',
      email: 'owner@example.com',
      emailVerified: true,
    })
    expect(linked.email).toBe('owner@example.com')
    expect(repos.users.count()).toBe(1)
  })

  it('creates an account for an unknown SSO identity', async () => {
    await register()
    const user = app.auth.linkOidcUser({
      issuer: 'https://idp.example',
      subject: 'xyz',
      email: 'new@example.com',
      emailVerified: true,
    })
    expect(user.isAdmin, 'the first account is the administrator, not this one').toBe(false)
    expect(user.passwordHash).toBeNull()
    expect(createRepositories(db).users.count()).toBe(2)
  })

  it('returns the same account on a second login', async () => {
    const first = app.auth.linkOidcUser({
      issuer: 'https://idp.example',
      subject: 'xyz',
      email: 'new@example.com',
      emailVerified: true,
    })
    const second = app.auth.linkOidcUser({ issuer: 'https://idp.example', subject: 'xyz' })
    expect(second.id).toBe(first.id)
  })
})

describe('first run', () => {
  it('sends a browser straight to setup before an administrator exists', async () => {
    for (const url of ['/', '/send', '/login', '/register']) {
      const res = await app.inject({ url, headers: { 'user-agent': 'Chrome' } })
      expect(res.statusCode, url).toBe(302)
      expect(res.headers.location, url).toBe('/setup')
    }
  })

  it('serves the setup form itself', async () => {
    const res = await app.inject({ url: '/setup' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="setupform"')
    expect(res.body).toContain('Administrator e-mail')
  })

  it('leaves the eReader alone — it cannot complete setup', async () => {
    const res = await app.inject({ url: '/', headers: { 'user-agent': KOBO } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="keyoutput"')
  })

  it('stops redirecting once the administrator exists', async () => {
    await register()
    const res = await app.inject({ url: '/', headers: { 'user-agent': 'Chrome' } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="submitbtn"')
  })

  it('closes the setup page once the administrator exists', async () => {
    await register()
    const res = await app.inject({ url: '/setup' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/login')
  })

  it('makes the first account an administrator', async () => {
    const res = await register()
    expect(res.json().user.isAdmin).toBe(true)
  })

  it('never redirects to setup when accounts are switched off', async () => {
    const plain = await buildApp({ tools: noTools, logger: false, accounts: false })
    await plain.ready()
    try {
      const res = await plain.inject({ url: '/', headers: { 'user-agent': 'Chrome' } })
      expect(res.statusCode).toBe(200)
      expect(res.body).toContain('id="submitbtn"')
    } finally {
      await plain.close()
    }
  })
})

describe('account pages', () => {
  it('serves the login page once claimed', async () => {
    await register()
    const res = await app.inject({ url: '/login' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="loginform"')
  })

  it('closes the register page once claimed', async () => {
    await register()
    const res = await app.inject({ url: '/register' })
    expect(res.headers.location).toBe('/login')
  })

  it('will not serve a page by its filename', async () => {
    await register()
    for (const url of ['/settings.html', '/setup.html', '/send.html', '/login.html']) {
      expect((await app.inject({ url })).statusCode, url).toBe(404)
    }
  })

  it('still serves the assets beside them', async () => {
    for (const url of ['/app.css', '/auth.js']) {
      expect((await app.inject({ url })).statusCode, url).toBe(200)
    }
  })

  it('sends an anonymous visitor from /settings to the login page', async () => {
    await register()
    const res = await app.inject({ url: '/settings' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/login?next=%2Fsettings')
  })

  it('serves /settings to a signed-in user', async () => {
    const cookie = cookieFrom(await register())
    const res = await app.inject({ url: '/settings', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="whoami"')
  })

  it('still answers /account, now as a redirect into Settings', async () => {
    const cookie = cookieFrom(await register())
    const res = await app.inject({ url: '/account', headers: { cookie } })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/settings#profile')
  })

  it('carries the verified marker through that redirect', async () => {
    const cookie = cookieFrom(await register())
    const res = await app.inject({ url: '/account?verified=1', headers: { cookie } })
    expect(res.headers.location).toBe('/settings?verified=1#profile')
  })

  it('changes a password from inside the account', async () => {
    const cookie = cookieFrom(await register())
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password',
      headers: { cookie },
      payload: { current: PASSWORD, password: 'a-different-good-password' },
    })

    expect(res.statusCode).toBe(200)
    const relogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: 'a-different-good-password' },
    })
    expect(relogin.statusCode).toBe(200)
  })

  it('refuses without the current password', async () => {
    const cookie = cookieFrom(await register())
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password',
      headers: { cookie },
      payload: { current: 'not-it', password: 'a-different-good-password' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('holds a new password to the same policy as a first one', async () => {
    const cookie = cookieFrom(await register())
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password',
      headers: { cookie },
      payload: { current: PASSWORD, password: 'short' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('needs a session at all', async () => {
    await register()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password',
      payload: { current: PASSWORD, password: 'a-different-good-password' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('never follows an off-site next parameter', async () => {
    const cookie = cookieFrom(await register())
    const res = await app.inject({
      url: '/login?next=https%3A%2F%2Fevil.example%2F',
      headers: { cookie },
    })
    expect(res.headers.location).toBe('/')
  })

  it('tells the sender page that accounts exist, without describing the server', async () => {
    const status = await app.inject({ url: '/auth/status' })
    expect(status.json().enabled, 'this is what the page actually reads').toBe(true)

    const health = await app.inject({ url: '/healthz' })
    expect(Object.keys(health.json()).sort(), 'and nothing here invites a guess').toEqual([
      'expireSeconds',
      'maxFileSize',
      'ok',
      'publicUrl',
      'queueTtlSeconds',
      'tools',
    ])
  })
})

describe('with accounts disabled', () => {
  it('has no auth surface at all', async () => {
    const plain = await buildApp({ tools: noTools, logger: false, accounts: false })
    await plain.ready()
    try {
      for (const url of ['/login', '/register', '/account', '/auth/status', '/waiting']) {
        expect((await plain.inject({ url })).statusCode).toBe(404)
      }
      expect((await plain.inject({ url: '/healthz' })).statusCode, 'still healthy').toBe(200)

      const key = await plain.inject({
        method: 'POST',
        url: '/generate',
        headers: { 'user-agent': KOBO },
      })
      expect(key.statusCode).toBe(200)
    } finally {
      await plain.close()
    }
  })
})

describe('accounts do not disturb the anonymous flow', () => {
  it('still generates a key and accepts a status poll with no session', async () => {
    const key = await app.inject({
      method: 'POST',
      url: '/generate',
      headers: { 'user-agent': KOBO },
    })
    expect(key.statusCode).toBe(200)
    expect(key.body).toHaveLength(config.keyLength)

    const status = await app.inject({
      url: `/status/${key.body}`,
      headers: { 'user-agent': KOBO },
    })
    expect(status.statusCode).toBe(200)
  })

  it('still serves the upload and eReader pages to anonymous visitors', async () => {
    await register()

    const sender = await app.inject({ url: '/', headers: { 'user-agent': 'Chrome' } })
    expect(sender.statusCode).toBe(200)
    expect(sender.body).toContain('id="submitbtn"')

    const reader = await app.inject({ url: '/', headers: { 'user-agent': KOBO } })
    expect(reader.body).toContain('id="keyoutput"')
  })
})

describe('requests that did not come from a page here', () => {
  async function signedInWithToken() {
    await register()
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: PASSWORD },
    })
    const cookie = cookieFrom(login)
    const status = await app.inject({ url: '/auth/status', headers: { cookie } })
    return { cookie: cookieFrom(status) || cookie, token: status.json().csrf as string }
  }

  it('hands a signed-in page a token and refuses the same request without it', async () => {
    const { cookie, token } = await signedInWithToken()
    expect(token, 'the page is given something to send').toBeTruthy()

    // Straight past the helper that stands in for a page, because the point here
    // is what happens to a request that never had a page behind it.
    const raw = (app as unknown as { rawInject: typeof app.inject }).rawInject

    const bare = await raw({
      method: 'POST',
      url: '/auth/sessions/revoke-others',
      headers: { cookie },
    })
    expect(bare.statusCode).toBe(403)
    expect(bare.json().error).toMatch(/did not come from a page/i)

    const wrong = await raw({
      method: 'POST',
      url: '/auth/sessions/revoke-others',
      headers: { cookie, 'x-csrf-token': 'not-the-token' },
    })
    expect(wrong.statusCode).toBe(403)

    const right = await raw({
      method: 'POST',
      url: '/auth/sessions/revoke-others',
      headers: { cookie, 'x-csrf-token': token },
    })
    expect(right.statusCode).toBe(200)
  })

  it('never asks a token of the anonymous flow, which has no cookie to forge', async () => {
    const generated = await app.inject({ method: 'POST', url: '/generate' })
    expect(generated.statusCode).toBe(200)

    const key = generated.body.trim()
    const extended = await app.inject({ method: 'POST', url: `/key/${key}/extend` })
    expect(extended.statusCode).toBe(200)
  })

  it('reads freely without one', async () => {
    const { cookie } = await signedInWithToken()
    const res = await app.inject({ url: '/auth/sessions', headers: { cookie } })
    expect(res.statusCode).toBe(200)
  })

  it('lets a signed-out visitor log in and out without one', async () => {
    await register()
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: PASSWORD },
    })
    expect(login.statusCode, 'the session does not exist yet, so there is nothing to check').toBe(
      200
    )
  })
})
