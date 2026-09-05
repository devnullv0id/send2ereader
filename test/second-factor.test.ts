import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { totpAt } from '../src/auth/totp.js'
import { type Db, openDatabase } from '../src/db/index.js'
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

const EMAIL = 'owner@example.com'
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

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const all = Array.isArray(raw) ? raw : [raw]
  return (
    all
      .map(String)
      .find((c) => c.startsWith('s2e_session='))
      ?.split(';')[0] ?? ''
  )
}

async function signedIn(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email: EMAIL, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
  })
  const cookie = cookieFrom(res)
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL) as { id: string }
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id)
  return cookie
}

const post = (url: string, cookie: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url, headers: { cookie }, payload })

async function beginAndConfirm(cookie: string) {
  const begin = await app.inject({
    method: 'POST',
    url: '/auth/tfa/begin',
    headers: { cookie },
  })
  const typed = begin.json().typed as string
  const secret = typed.replace(/\s/g, '')
  const confirm = await post('/auth/tfa/confirm', cookie, { code: totpAt(secret, Date.now()) })
  return { secret, begin, confirm }
}

describe('turning two-factor on', () => {
  it('hands back a secret, a QR and the same secret typed out', async () => {
    const cookie = await signedIn()
    const res = await post('/auth/tfa/begin', cookie)

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.typed).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/)
    expect(body.uri).toContain('otpauth://totp/')
    expect(body.uri).toContain(encodeURIComponent(EMAIL))
    expect(body.svg.startsWith('<svg')).toBe(true)
  })

  it('leaves it off until a code from that secret is proved', async () => {
    const cookie = await signedIn()
    await post('/auth/tfa/begin', cookie)

    const before = await app.inject({
      url: '/auth/tfa',
      headers: { cookie },
    })
    expect(before.json().enabled).toBe(false)
  })

  it('refuses a code that is not the one the secret makes', async () => {
    const cookie = await signedIn()
    await post('/auth/tfa/begin', cookie)

    const res = await post('/auth/tfa/confirm', cookie, { code: '000000' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/did not match/)
  })

  it('turns it on and issues ten recovery codes when the code checks out', async () => {
    const cookie = await signedIn()
    const { confirm } = await beginAndConfirm(cookie)

    expect(confirm.statusCode).toBe(200)
    const codes = confirm.json().codes as string[]
    expect(codes).toHaveLength(10)
    for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/)
    expect(new Set(codes).size).toBe(10)

    const after = await app.inject({
      url: '/auth/tfa',
      headers: { cookie },
    })
    expect(after.json()).toMatchObject({ enabled: true, recoveryCodes: { unused: 10, total: 10 } })
  })

  it('refuses to start again while it is already on', async () => {
    const cookie = await signedIn()
    await beginAndConfirm(cookie)
    const again = await post('/auth/tfa/begin', cookie)
    expect(again.statusCode).toBe(409)
  })

  it('never stores the secret in the clear', async () => {
    const cookie = await signedIn()
    const { secret } = await beginAndConfirm(cookie)
    const row = db.prepare('SELECT totp_secret FROM users WHERE email = ?').get(EMAIL) as {
      totp_secret: string
    }
    expect(row.totp_secret).not.toBe(secret)
    expect(row.totp_secret).not.toContain(secret)
  })

  it('never stores a recovery code in the clear', async () => {
    const cookie = await signedIn()
    const { confirm } = await beginAndConfirm(cookie)
    const first = (confirm.json().codes as string[])[0]!
    const rows = db
      .prepare("SELECT code_hash FROM recovery_codes WHERE purpose = 'second_factor'")
      .all() as { code_hash: string }[]
    expect(rows).toHaveLength(10)
    for (const row of rows) expect(row.code_hash).not.toContain(first.replace('-', ''))
  })
})

describe('signing in once two-factor is on', () => {
  it('stops at the code step instead of handing over a session', async () => {
    const cookie = await signedIn()
    await beginAndConfirm(cookie)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, secondFactor: true })
    expect(res.json().user).toBeUndefined()

    const status = await app.inject({
      url: '/auth/status',
      headers: { cookie: cookieFrom(res) },
    })
    expect(status.json().user, 'the half-done sign-in is not a session').toBeNull()
  })

  it('finishes on the right code', async () => {
    const setup = await signedIn()
    const { secret } = await beginAndConfirm(setup)

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    })
    const res = await post('/auth/login/second-factor', cookieFrom(login), {
      code: totpAt(secret, Date.now()),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().user.email).toBe(EMAIL)
    expect(res.json().usedRecoveryCode).toBe(false)

    const status = await app.inject({
      url: '/auth/status',
      headers: { cookie: cookieFrom(res) },
    })
    expect(status.json().user.email).toBe(EMAIL)
  })

  it('refuses the wrong code and hands over nothing', async () => {
    const setup = await signedIn()
    await beginAndConfirm(setup)

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    })
    const res = await post('/auth/login/second-factor', cookieFrom(login), { code: '000000' })

    expect(res.statusCode).toBe(401)
    expect(res.json().ok).toBe(false)
  })

  it('takes a recovery code, and only once', async () => {
    const setup = await signedIn()
    const { confirm } = await beginAndConfirm(setup)
    const code = (confirm.json().codes as string[])[0]!

    const first = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    })
    const used = await post('/auth/login/second-factor', cookieFrom(first), { code })
    expect(used.statusCode).toBe(200)
    expect(used.json().usedRecoveryCode).toBe(true)
    expect(used.json().recoveryCodesLeft).toBe(9)

    const second = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    })
    const again = await post('/auth/login/second-factor', cookieFrom(second), { code })
    expect(again.statusCode, 'a recovery code is spent once').toBe(401)
  })

  it('forgives the dash and the case in a recovery code', async () => {
    const setup = await signedIn()
    const { confirm } = await beginAndConfirm(setup)
    const code = (confirm.json().codes as string[])[0]!

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    })
    const res = await post('/auth/login/second-factor', cookieFrom(login), {
      code: code.replace('-', '').toLowerCase(),
    })
    expect(res.statusCode).toBe(200)
  })

  it('refuses a code when no sign-in is waiting for one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login/second-factor',
      payload: { code: '000000' },
    })
    expect(res.statusCode).toBe(440)
  })

  it('leaves an account without two-factor signing in as it always did', async () => {
    await signedIn()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    })
    expect(res.json().user.email).toBe(EMAIL)
    expect(res.json().secondFactor).toBeUndefined()
  })
})

describe('proving it is you before a factor is taken away', () => {
  it('will not turn two-factor off on the strength of a cookie alone', async () => {
    const cookie = await signedIn()
    await beginAndConfirm(cookie)

    const res = await post('/auth/tfa/disable', cookie)

    expect(res.statusCode).toBe(403)
    expect(res.json().needs, 'the page is told what to ask for').toMatchObject({
      password: true,
      code: true,
    })
    const row = db.prepare('SELECT totp_enabled FROM users WHERE email = ?').get(EMAIL)
    expect(row, 'still on').toMatchObject({ totp_enabled: 1 })
  })

  it('refuses the wrong password and accepts the right one', async () => {
    const cookie = await signedIn()
    await beginAndConfirm(cookie)

    const wrong = await post('/auth/tfa/disable', cookie, { password: 'not-the-password' })
    expect(wrong.statusCode).toBe(403)

    const right = await post('/auth/tfa/disable', cookie, { password: PASSWORD })
    expect(right.statusCode).toBe(200)
  })

  it('takes a live code instead of the password', async () => {
    const cookie = await signedIn()
    const { secret } = await beginAndConfirm(cookie)

    const res = await post('/auth/tfa/disable', cookie, { code: totpAt(secret, Date.now())! })
    expect(res.statusCode).toBe(200)
  })

  it('asks nothing of an account that has neither a password nor a code', async () => {
    const cookie = await signedIn()
    db.prepare('UPDATE users SET password_hash = NULL WHERE email = ?').run(EMAIL)

    const res = await post('/auth/tfa/codes', cookie)
    expect(res.statusCode, 'no factor exists to prove, so nothing is demanded').toBe(409)
  })
})

describe('turning two-factor off', () => {
  it('clears the secret and the recovery codes with it', async () => {
    const cookie = await signedIn()
    await beginAndConfirm(cookie)

    const res = await post('/auth/tfa/disable', cookie, { password: PASSWORD })
    expect(res.statusCode).toBe(200)

    const row = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE email = ?').get(EMAIL)
    expect(row).toMatchObject({ totp_secret: null, totp_enabled: 0 })
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE purpose = 'second_factor'").get(),
      'the account pool is a different thing and stays'
    ).toMatchObject({ n: 0 })

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    })
    expect(login.json().secondFactor, 'sign-in stops asking').toBeUndefined()
  })
})

describe('a fresh set of recovery codes', () => {
  it('replaces the old set rather than adding to it', async () => {
    const cookie = await signedIn()
    const { confirm } = await beginAndConfirm(cookie)
    const old = (confirm.json().codes as string[])[0]!

    const res = await post('/auth/tfa/codes', cookie, { password: PASSWORD })
    expect(res.statusCode).toBe(200)
    const fresh = res.json().codes as string[]
    expect(fresh).toHaveLength(10)
    expect(fresh).not.toContain(old)
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE purpose = 'second_factor'").get()
    ).toMatchObject({ n: 10 })

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    })
    const spent = await post('/auth/login/second-factor', cookieFrom(login), { code: old })
    expect(spent.statusCode, 'the old set stops working').toBe(401)
  })

  it('refuses when two-factor is not on, so there is nothing to recover into', async () => {
    const cookie = await signedIn()
    const res = await post('/auth/tfa/codes', cookie, { password: PASSWORD })
    expect(res.statusCode).toBe(409)
  })
})

describe('who may touch any of this', () => {
  const guarded: [string, string][] = [
    ['POST', '/auth/tfa/begin'],
    ['POST', '/auth/tfa/confirm'],
    ['POST', '/auth/tfa/disable'],
    ['POST', '/auth/tfa/codes'],
    ['POST', '/auth/passkeys/options'],
    ['POST', '/auth/passkeys'],
  ]

  it.each(guarded)('turns away %s %s when nobody is signed in', async (method, url) => {
    const res = await app.inject({ method: method as 'POST', url, payload: { code: '000000' } })
    expect(res.statusCode).toBe(401)
  })

  it('will not let one account remove another account’s passkey', async () => {
    const mine = await signedIn()
    db.prepare(
      `INSERT INTO users (id, email, email_verified, password_hash, created_at)
       VALUES ('someone-else', 'them@example.com', 1, NULL, '2026-01-01T00:00:00.000Z')`
    ).run()
    db.prepare(
      `INSERT INTO passkeys (id, user_id, label, public_key, counter, transports, created_at)
       VALUES ('theirs', 'someone-else', 'Their laptop', 'x', 0, '', '2026-01-01T00:00:00.000Z')`
    ).run()

    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/passkeys/theirs',
      headers: { cookie: mine },
    })
    expect(res.statusCode).toBe(404)
    expect(db.prepare('SELECT COUNT(*) AS n FROM passkeys').get()).toMatchObject({ n: 1 })
  })
})

describe('what the passkey endpoints say before any passkey exists', () => {
  it('lists none, and says whether this origin could hold one', async () => {
    const cookie = await signedIn()
    const res = await app.inject({
      url: '/auth/passkeys',
      headers: { cookie },
    })
    expect(res.json()).toMatchObject({ ok: true, passkeys: [] })
    expect(typeof res.json().supported).toBe('boolean')
  })

  it('refuses an assertion that carries no challenge', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/passkey/login',
      payload: { response: { id: 'nope' } },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('every other way in also stops at the second factor', () => {
  async function linkFor(email: string): Promise<string> {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string }
    const token = 'a-token-for-the-test'
    db.prepare(
      `INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at, created_at, persist)
       VALUES (?, ?, 'signin', ?, ?, ?, 1)`
    ).run(
      createHash('sha256').update(token).digest('hex'),
      user.id,
      email,
      new Date(Date.now() + 900_000).toISOString(),
      new Date().toISOString()
    )
    return token
  }

  it('refuses to sign in from an emailed link without the code', async () => {
    const cookie = await signedIn()
    await beginAndConfirm(cookie)

    const token = await linkFor(EMAIL)
    const res = await app.inject({ url: `/auth/link?token=${token}` })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location, 'sent to the code step, not the site').toBe('/login?step=code')

    const status = await app.inject({
      url: '/auth/status',
      headers: { cookie: cookieFrom(res) },
    })
    expect(status.json().user, 'the link alone is not a session').toBeNull()
    expect(status.json().awaitingSecondFactor).toBe(true)
  })

  it('finishes that link once the code is given', async () => {
    const setup = await signedIn()
    const { secret } = await beginAndConfirm(setup)

    const token = await linkFor(EMAIL)
    const opened = await app.inject({ url: `/auth/link?token=${token}` })
    const res = await post('/auth/login/second-factor', cookieFrom(opened), {
      code: totpAt(secret, Date.now())!,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().user.email).toBe(EMAIL)
  })

  it('still signs straight in from a link when two-factor is off', async () => {
    await signedIn()
    const token = await linkFor(EMAIL)
    const res = await app.inject({ url: `/auth/link?token=${token}` })

    expect(res.headers.location).toBe('/')
    const status = await app.inject({
      url: '/auth/status',
      headers: { cookie: cookieFrom(res) },
    })
    expect(status.json().user.email).toBe(EMAIL)
  })

  it('refuses to sign in from a password reset without the code', async () => {
    const cookie = await signedIn()
    await beginAndConfirm(cookie)

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL) as { id: string }
    const token = 'a-reset-token-for-the-test'
    db.prepare(
      `INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at, created_at, persist)
       VALUES (?, ?, 'reset', ?, ?, ?, 1)`
    ).run(
      createHash('sha256').update(token).digest('hex'),
      user.id,
      EMAIL,
      new Date(Date.now() + 900_000).toISOString(),
      new Date().toISOString()
    )

    const res = await app.inject({
      method: 'POST',
      url: '/auth/reset',
      payload: { token, password: 'a-brand-new-password' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, secondFactor: true })

    const status = await app.inject({
      url: '/auth/status',
      headers: { cookie: cookieFrom(res) },
    })
    expect(status.json().user, 'a new password alone is not a session').toBeNull()
  })

  it('says nothing is pending when nothing is', async () => {
    const res = await app.inject({ url: '/auth/status' })
    expect(res.json().awaitingSecondFactor).toBe(false)
  })

  it('forgets a half-finished sign-in when the page backs out of it', async () => {
    const cookie = await signedIn()
    await beginAndConfirm(cookie)

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    })
    const held = cookieFrom(login)

    const before = await app.inject({ url: '/auth/status', headers: { cookie: held } })
    expect(before.json().awaitingSecondFactor).toBe(true)

    const cancelled = await post('/auth/login/cancel', held)
    expect(cancelled.statusCode).toBe(200)

    const after = await app.inject({
      url: '/auth/status',
      headers: { cookie: cookieFrom(cancelled) },
    })
    expect(after.json().awaitingSecondFactor, 'backing out clears it').toBe(false)

    const code = await post('/auth/login/second-factor', cookieFrom(cancelled), { code: '000000' })
    expect(code.statusCode, 'and the code step is no longer accepting anything').toBe(440)
  })
})

describe('recovery codes belong to an account, not to the server', () => {
  it('lets two accounts hold the same code without one refusing to save', () => {
    const first = app.repos.users.create({
      email: 'one@example.com',
      passwordHash: 'x',
    })
    const second = app.repos.users.create({
      email: 'two@example.com',
      passwordHash: 'x',
    })

    app.repos.recoveryCodes.replaceAll(first.id, ['SAME1-SAME2'])
    expect(() => app.repos.recoveryCodes.replaceAll(second.id, ['SAME1-SAME2'])).not.toThrow()

    expect(app.repos.recoveryCodes.counts(first.id).unused).toBe(1)
    expect(app.repos.recoveryCodes.counts(second.id).unused).toBe(1)
  })

  it('still refuses one account the other account’s code', () => {
    const mine = app.repos.users.create({
      email: 'mine@example.com',
      passwordHash: 'x',
    })
    const theirs = app.repos.users.create({
      email: 'theirs@example.com',
      passwordHash: 'x',
    })

    app.repos.recoveryCodes.replaceAll(theirs.id, ['ONLY1-THEIR2'])

    expect(app.repos.recoveryCodes.consume(mine.id, 'ONLY1-THEIR2')).toBe(false)
    expect(app.repos.recoveryCodes.consume(theirs.id, 'ONLY1-THEIR2')).toBe(true)
  })
})
