import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { makeRecoveryPhrase, PHRASE_WORDS, phraseWordCount } from '../src/auth/phrase.js'
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

beforeEach(async () => {
  await prepareUploadDir(true)
  db = openDatabase(':memory:')
  app = asBrowser(await buildApp({ tools: noTools, logger: false, accounts: true, db }))
  await app.ready()
  settings.set('SMTP_ENABLED', 'false', null)
})

afterEach(async () => {
  await app.close()
  db.close()
})

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  return (Array.isArray(raw) ? raw : [raw]).map((l) => String(l).split(';')[0]).join('; ')
}

async function makeAccount(email = EMAIL) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
  })
  return { res, phrase: res.json().recoveryPhrase as string | null, cookie: cookieFrom(res) }
}

const signInWith = (phrase: string, email = EMAIL) =>
  app.inject({ method: 'POST', url: '/auth/login/recovery', payload: { email, phrase } })

describe('the phrase itself', () => {
  it('is six words from a list of two hundred and fifty six', () => {
    expect(phraseWordCount(), 'so each word is exactly a byte').toBe(256)
    expect(PHRASE_WORDS).toBe(6)

    const phrase = makeRecoveryPhrase()
    expect(phrase.split('-')).toHaveLength(6)
    expect(phrase).toMatch(/^[a-z]+(-[a-z]+){5}$/)
  })

  it('is not the same one twice', () => {
    const many = new Set(Array.from({ length: 200 }, () => makeRecoveryPhrase()))
    expect(many.size, 'two hundred draws, no collision').toBe(200)
  })
})

describe('when the server has no mail', () => {
  it('gives a phrase out when the account is made', async () => {
    const { phrase } = await makeAccount()
    expect(phrase).toBeTruthy()
    expect(phrase!.split('-')).toHaveLength(6)
  })

  it('never stores it in a readable form', async () => {
    const { phrase } = await makeAccount()

    const rows = db
      .prepare("SELECT code_hash FROM recovery_codes WHERE purpose = 'account'")
      .all() as { code_hash: string }[]

    expect(rows, 'one phrase, not ten codes').toHaveLength(1)
    expect(rows[0]!.code_hash).not.toContain(phrase!.split('-')[0]!)
  })

  it('gets in with it, without the password and without any mail', async () => {
    const { phrase } = await makeAccount()
    const res = await signInWith(phrase!)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, setAPassword: true })
    expect(res.json().user.email).toBe(EMAIL)
  })

  it('forgives the way a person types it off a piece of paper', async () => {
    const { phrase } = await makeAccount()
    const words = phrase!.split('-')

    for (const typed of [
      phrase!.toUpperCase(),
      words.join(' '),
      `  ${phrase!}  `,
      words.join('   '),
    ]) {
      expect((await signInWith(typed)).statusCode, typed).toBe(200)
    }
  })

  it('keeps working, because a way back that works once is a trapdoor', async () => {
    const { phrase } = await makeAccount()

    expect((await signInWith(phrase!)).statusCode).toBe(200)
    expect((await signInWith(phrase!)).statusCode, 'still there tomorrow').toBe(200)
  })

  it('refuses a phrase belonging to another account', async () => {
    const mine = await makeAccount()
    settings.set('ALLOW_SIGNUP', 'true', null)
    await makeAccount('second@example.com')

    expect((await signInWith(mine.phrase!, 'second@example.com')).statusCode).toBe(401)
  })

  it('says the same thing for a wrong phrase and an unknown address', async () => {
    await makeAccount()
    const wrong = makeRecoveryPhrase()

    const known = await signInWith(wrong)
    const unknown = await signInWith(wrong, 'nobody@example.com')

    expect(unknown.statusCode).toBe(known.statusCode)
    expect(unknown.json()).toEqual(known.json())
  })

  it('still asks for the second factor when there is one', async () => {
    const { phrase } = await makeAccount()
    const user = app.repos.users.byEmail(EMAIL)!
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run('x', user.id)

    const res = await signInWith(phrase!)
    expect(res.json(), 'a lost password is not a lost phone').toMatchObject({ secondFactor: true })
    expect(res.json().user).toBeUndefined()
  })
})

describe('when the server has mail', () => {
  it('issues no phrase, because the address is the way back', async () => {
    settings.set('SMTP_ENABLED', 'true', null)
    const { phrase } = await makeAccount()

    expect(phrase).toBeNull()
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE purpose = 'account'").get()
    ).toMatchObject({ n: 0 })
  })

  it('says so on the status the pages read', async () => {
    settings.set('SMTP_ENABLED', 'true', null)
    expect((await app.inject({ url: '/auth/status' })).json().recoveryPhraseInUse).toBe(false)

    settings.set('SMTP_ENABLED', 'false', null)
    expect((await app.inject({ url: '/auth/status' })).json().recoveryPhraseInUse).toBe(true)
  })

  it('leaves an existing phrase working if mail arrives later', async () => {
    const { phrase } = await makeAccount()
    settings.set('SMTP_ENABLED', 'true', null)

    expect(
      (await signInWith(phrase!)).statusCode,
      'taking away the way back because mail appeared would be a trap'
    ).toBe(200)
  })
})

describe('replacing it', () => {
  it('issues a new one and retires the old', async () => {
    const { phrase, cookie } = await makeAccount()

    const made = await app.inject({
      method: 'POST',
      url: '/auth/recovery-phrase',
      headers: { cookie },
      payload: { password: PASSWORD },
    })
    expect(made.statusCode).toBe(200)

    const fresh = made.json().phrase as string
    expect(fresh).not.toBe(phrase)
    expect((await signInWith(phrase!)).statusCode, 'the old one is dead').toBe(401)
    expect((await signInWith(fresh)).statusCode).toBe(200)
  })

  it('will not do it without confirming who you are', async () => {
    const { cookie } = await makeAccount()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/recovery-phrase',
      headers: { cookie },
      payload: { password: 'not-the-password' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('cannot be reached signed out', async () => {
    await makeAccount()
    expect((await app.inject({ method: 'POST', url: '/auth/recovery-phrase' })).statusCode).toBe(
      401
    )
    expect((await app.inject({ url: '/auth/recovery-phrase' })).statusCode).toBe(401)
  })

  it('reports that one exists without ever showing it', async () => {
    const { phrase, cookie } = await makeAccount()
    const res = await app.inject({ url: '/auth/recovery-phrase', headers: { cookie } })

    expect(res.json()).toMatchObject({ has: true, needed: true })
    expect(JSON.stringify(res.json())).not.toContain(phrase!.split('-')[0]!)
  })
})

describe('the two pools stay apart', () => {
  it('turning two-factor off does not take the phrase with it', async () => {
    await makeAccount()
    const user = app.repos.users.byEmail(EMAIL)!

    app.auth.issueRecoveryCodes(user.id)
    app.auth.disableTotp(user.id)

    expect(app.auth.recoveryCodeCounts(user.id).total, 'two-factor codes go').toBe(0)
    expect(app.auth.hasRecoveryPhrase(user.id), 'the phrase stays').toBe(true)
  })

  it('the phrase is no use as a second factor', async () => {
    const { phrase } = await makeAccount()
    const user = app.repos.users.byEmail(EMAIL)!
    app.auth.issueRecoveryCodes(user.id)

    expect(app.auth.verifySecondFactor(user.id, phrase!)).toBeNull()
  })
})
