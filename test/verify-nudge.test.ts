import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { prepareUploadDir } from '../src/files.js'
import { settings } from '../src/settings.js'
import { asBrowser } from './helpers.js'

const noTools = {
  kepubify: false,
  calibre: false,
  pdfcropmargins: false,
  kfxInput: false,
  kfxOutput: false,
  layoutFix: false,
}

const EMAIL = 'first@example.com'
const PASSWORD = 'a-perfectly-fine-password'

let app: FastifyInstance
let db: Db
let cookie: string

const cookieFrom = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie']
  return (Array.isArray(raw) ? raw : [raw]).map((l) => String(l).split(';')[0]).join('; ')
}

async function register(email = EMAIL) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
  })
  return { res, cookie: cookieFrom(res) }
}

const status = () => app.inject({ url: '/auth/status', headers: { cookie } }).then((r) => r.json())

const remindLater = () =>
  app.inject({ method: 'POST', url: '/auth/verify/remind-later', headers: { cookie } })

const askToMove = (email: string, password = PASSWORD) =>
  app.inject({
    method: 'POST',
    url: '/auth/email',
    headers: { cookie },
    payload: { email, password },
  })

beforeEach(async () => {
  await prepareUploadDir(true)
  db = openDatabase(':memory:')
  app = asBrowser(await buildApp({ tools: noTools, logger: false, accounts: true, db }))
  await app.ready()

  settings.set('SMTP_ENABLED', 'false', null)
  const made = await register()
  cookie = made.cookie
  settings.set('SMTP_ENABLED', 'true', null)
})

afterEach(async () => {
  await app.close()
  db.close()
})

describe('when the nudge appears', () => {
  it('asks an unverified account once mail works', async () => {
    expect(await status().then((s) => s.verifyNudge)).toMatchObject({ needed: true })
  })

  it('says nothing while the server has no mail, because the link would go to a log', async () => {
    settings.set('SMTP_ENABLED', 'false', null)
    expect((await status()).verifyNudge.needed).toBe(false)
  })

  it('says nothing to an account that has confirmed its address', async () => {
    app.repos.users.markVerified(app.repos.users.byEmail(EMAIL)!.id)
    expect((await status()).verifyNudge.needed).toBe(false)
  })

  it('is nothing at all to somebody signed out', async () => {
    expect((await app.inject({ url: '/auth/status' })).json().verifyNudge).toBeNull()
  })
})

describe('the reminder budget', () => {
  it('starts at the configured limit and counts down', async () => {
    settings.set('VERIFY_REMINDER_LIMIT', '3', null)
    expect((await status()).verifyNudge.remindersLeft).toBe(3)

    expect((await remindLater()).json()).toMatchObject({ ok: true, remindersLeft: 2 })
    expect((await remindLater()).json().remindersLeft).toBe(1)
    expect((await status()).verifyNudge.remindersLeft).toBe(1)
  })

  it('runs out, and then there is no way past it', async () => {
    settings.set('VERIFY_REMINDER_LIMIT', '1', null)

    expect((await remindLater()).statusCode).toBe(200)
    const spent = await remindLater()
    expect(spent.statusCode).toBe(409)
    expect((await status()).verifyNudge.remindersLeft).toBe(0)
  })

  it('has none to give when the limit is zero', async () => {
    settings.set('VERIFY_REMINDER_LIMIT', '0', null)
    expect((await status()).verifyNudge.remindersLeft).toBe(0)
    expect((await remindLater()).statusCode).toBe(409)
  })

  it('does not hand an untouched account a budget the admin has since cut', async () => {
    settings.set('VERIFY_REMINDER_LIMIT', '5', null)
    await remindLater()
    expect((await status()).verifyNudge.remindersLeft).toBe(4)

    settings.set('VERIFY_REMINDER_LIMIT', '2', null)
    expect((await status()).verifyNudge.remindersLeft, 'clamped to the new ceiling').toBe(2)
  })

  it('cannot be spent signed out', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/auth/verify/remind-later' })).statusCode
    ).toBe(401)
  })

  it('is put back when the address is finally confirmed', async () => {
    settings.set('VERIFY_REMINDER_LIMIT', '5', null)
    await remindLater()

    const user = app.repos.users.byEmail(EMAIL)!
    app.repos.users.markVerified(user.id)
    expect(app.repos.users.byId(user.id)!.verifyRemindersLeft).toBeNull()
  })
})

describe('confirming the address', () => {
  it('takes the recovery phrase with it, because the address is the better way back', async () => {
    const user = app.repos.users.byEmail(EMAIL)!
    expect(app.auth.hasRecoveryPhrase(user.id), 'the account was made without mail').toBe(true)

    const token = app.repos.emailTokens.issue(user.id, 'verify', user.email, 3600)
    app.auth.verify(token)

    expect(app.repos.users.byId(user.id)!.emailVerified).toBe(true)
    expect(app.auth.hasRecoveryPhrase(user.id)).toBe(false)
  })
})

describe('changing the address', () => {
  it('asks the new one to confirm itself and leaves the old one signing in', async () => {
    const res = await askToMove('second@example.com')
    expect(res.statusCode).toBe(200)
    expect(res.json().pendingEmail).toBe('second@example.com')

    expect(app.repos.users.byEmail(EMAIL), 'not moved yet').toBeTruthy()
    expect((await status()).pendingEmail).toBe('second@example.com')
  })

  it('moves the account once the link is opened, and confirms it on the way', async () => {
    await askToMove('second@example.com')
    const user = app.repos.users.byEmail(EMAIL)!

    const token = app.repos.emailTokens.issue(user.id, 'email_change', 'second@example.com', 3600)
    const moved = app.auth.confirmEmailChange(token)

    expect(moved.email).toBe('second@example.com')
    expect(moved.emailVerified, 'opening the link is the confirmation').toBe(true)
    expect(app.repos.users.byEmail(EMAIL)).toBeNull()
    expect(app.auth.hasRecoveryPhrase(user.id), 'and the phrase goes too').toBe(false)
  })

  it('refuses an address another account already holds', async () => {
    settings.set('ALLOW_SIGNUP', 'true', null)
    await register('taken@example.com')

    const res = await askToMove('taken@example.com')
    expect(res.statusCode).toBe(409)
    expect((await status()).pendingEmail).toBeNull()
    settings.clear('ALLOW_SIGNUP')
  })

  it('refuses the address it already has', async () => {
    expect((await askToMove(EMAIL)).statusCode).toBe(409)
  })

  it('refuses something that is not an address', async () => {
    expect((await askToMove('not-an-address')).statusCode).toBe(400)
  })

  it('will not do it without confirming who is asking', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/email',
      headers: { cookie },
      payload: { email: 'second@example.com', password: 'not-the-password' },
    })
    expect(res.statusCode).toBe(403)
    expect((await status()).pendingEmail).toBeNull()
  })

  it('cannot be started signed out', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/email',
      payload: { email: 'second@example.com', password: PASSWORD },
    })
    expect(res.statusCode).toBe(401)
  })

  it('can be called off before the link is opened', async () => {
    await askToMove('second@example.com')

    const off = await app.inject({ method: 'POST', url: '/auth/email/cancel', headers: { cookie } })
    expect(off.json()).toMatchObject({ ok: true, dropped: true })
    expect((await status()).pendingEmail).toBeNull()
  })

  it('refuses a link for an address somebody else took in the meantime', async () => {
    const user = app.repos.users.byEmail(EMAIL)!
    const token = app.repos.emailTokens.issue(user.id, 'email_change', 'race@example.com', 3600)

    settings.set('ALLOW_SIGNUP', 'true', null)
    await register('race@example.com')
    settings.clear('ALLOW_SIGNUP')

    expect(() => app.auth.confirmEmailChange(token)).toThrow()
    expect(app.repos.users.byId(user.id)!.email).toBe(EMAIL)
  })

  it('refuses a link that was already used', async () => {
    const user = app.repos.users.byEmail(EMAIL)!
    const token = app.repos.emailTokens.issue(user.id, 'email_change', 'second@example.com', 3600)

    app.auth.confirmEmailChange(token)
    expect(() => app.auth.confirmEmailChange(token)).toThrow()
  })

  it('sends whoever opens it somewhere that says what happened', async () => {
    const user = app.repos.users.byEmail(EMAIL)!
    const token = app.repos.emailTokens.issue(user.id, 'email_change', 'second@example.com', 3600)

    const res = await app.inject({ url: `/auth/email/confirm?token=${token}`, headers: { cookie } })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/settings?moved=1#profile')
  })

  it('sends a stranger to the sign-in page instead of a page they cannot see', async () => {
    const user = app.repos.users.byEmail(EMAIL)!
    const token = app.repos.emailTokens.issue(user.id, 'email_change', 'second@example.com', 3600)

    const res = await app.inject({ url: `/auth/email/confirm?token=${token}` })
    expect(res.headers.location).toBe('/login?moved=1')
  })

  it('says so plainly when the link is nonsense', async () => {
    const res = await app.inject({ url: '/auth/email/confirm?token=nonsense' })
    expect(res.headers.location).toBe('/login?error=email')
  })
})
