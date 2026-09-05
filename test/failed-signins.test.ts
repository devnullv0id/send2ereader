import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
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
let sent: { to: string; subject: string; text: string }[]

beforeEach(async () => {
  await prepareUploadDir(true)
  db = openDatabase(':memory:')
  app = asBrowser(await buildApp({ tools: noTools, logger: false, accounts: true, db }))
  await app.ready()

  sent = []
  const mailer = app.mailer as unknown as {
    send: (m: { to: string; subject: string; text: string }) => Promise<void>
  }
  mailer.send = async (message) => {
    sent.push(message)
  }

  await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email: EMAIL, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
  })
  sent.length = 0
})

afterEach(async () => {
  await app.close()
  db.close()
})

const wrong = (email = EMAIL) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'not-it' } })

const right = () =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD } })

const notices = () => sent.filter((m) => m.subject === 'Someone is guessing at your password')

const threshold = config.auth.failedSignInsBeforeAlert

describe('someone guessing at a password', () => {
  it('says nothing while the misses are few', async () => {
    for (let i = 0; i < threshold - 1; i++) await wrong()
    expect(notices()).toHaveLength(0)
  })

  it('writes once the run reaches the threshold', async () => {
    for (let i = 0; i < threshold; i++) await wrong()

    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.to).toBe(EMAIL)
    expect(notices()[0]!.text).toContain(String(threshold))
  })

  it('tells the reader where it came from and what to do', async () => {
    for (let i = 0; i < threshold; i++) await wrong()
    const body = notices()[0]!.text

    expect(body).toContain('/auth/forgot')
    expect(body.toLowerCase()).toContain('change the password')
    expect(body, 'the reader is told nobody got in').toMatch(/nobody got in/i)
  })

  it('writes once, not once per attempt after that', async () => {
    const codes: number[] = []
    for (let i = 0; i < threshold + 3; i++) codes.push((await wrong()).statusCode)

    expect(
      codes.every((c) => c === 401),
      'every attempt really reached the check'
    ).toBe(true)
    expect(notices(), 'a sustained guess is not a mail flood').toHaveLength(1)
  })

  it('fires below the rate limit, or it would never fire at all', () => {
    expect(
      threshold,
      'the limiter turns attempts away after ten, so the threshold has to be under that'
    ).toBeLessThan(10)
  })

  it('forgets the run as soon as the right password arrives', async () => {
    for (let i = 0; i < threshold - 1; i++) await wrong()
    expect((await right()).statusCode).toBe(200)

    for (let i = 0; i < threshold - 1; i++) await wrong()
    expect(notices(), 'the count started again from nothing').toHaveLength(0)

    await wrong()
    expect(notices()).toHaveLength(1)
  })

  it('never writes to an address that has no account here', async () => {
    for (let i = 0; i < threshold + 3; i++) await wrong('nobody@example.com')
    expect(sent).toHaveLength(0)
  })

  it('counts each account separately', async () => {
    db.prepare(
      `INSERT INTO users (id, email, email_verified, password_hash, created_at)
       VALUES ('them', 'them@example.com', 1, NULL, '2026-01-01T00:00:00.000Z')`
    ).run()

    for (let i = 0; i < threshold - 1; i++) await wrong()
    for (let i = 0; i < threshold - 1; i++) await wrong('them@example.com')
    expect(notices()).toHaveLength(0)
  })

  it('answers the guesser exactly as it always did', async () => {
    const first = await wrong()
    for (let i = 0; i < threshold + 2; i++) await wrong()
    const later = await wrong()

    expect(later.statusCode, 'the reply never hints that a notice went out').toBe(first.statusCode)
    expect(later.json()).toEqual(first.json())
  })

  it('does not stop the right password working afterwards', async () => {
    for (let i = 0; i < threshold + 2; i++) await wrong()
    const res = await right()

    expect(res.statusCode, 'this notifies, it does not lock').toBe(200)
    expect(res.json().user.email).toBe(EMAIL)
  })

  it('carries on quietly when the mail cannot be sent', async () => {
    const mailer = app.mailer as unknown as { send: () => Promise<void> }
    mailer.send = async () => {
      throw new Error('no mail today')
    }

    for (let i = 0; i < threshold; i++) await wrong()
    expect((await right()).statusCode, 'a broken mailer is not a broken sign-in').toBe(200)
  })
})
