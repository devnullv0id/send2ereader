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

const PASSWORD = 'a-perfectly-fine-password'

let app: FastifyInstance
let db: Db
let cookie: string
let adminId: string

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  return (Array.isArray(raw) ? raw : [raw]).map((l) => String(l).split(';')[0]).join('; ')
}

beforeEach(async () => {
  await prepareUploadDir(true)
  db = openDatabase(':memory:')
  app = asBrowser(await buildApp({ tools: noTools, logger: false, accounts: true, db }))
  await app.ready()

  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: 'first@example.com',
      password: PASSWORD,
      firstName: 'Ada',
      lastName: 'Lovelace',
    },
  })
  cookie = cookieFrom(res)
  adminId = app.repos.users.byEmail('first@example.com')!.id
})

afterEach(async () => {
  await app.close()
  db.close()
})

const put = (payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie }, payload })

function giveAPasskey(userId: string, id: string): void {
  app.repos.passkeys.create({
    id,
    userId,
    label: 'A key',
    publicKey: 'not-a-real-key',
    counter: 0,
    transports: [],
  })
}

describe('moving the address when passkeys exist', () => {
  it('refuses until the consequence is acknowledged', async () => {
    giveAPasskey(adminId, 'key-one')

    const res = await put({ key: 'DOMAIN', value: 'books.example.com' })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ needsPasskeyConfirmation: true, passkeysAffected: 1 })
    expect(settings.isOverridden('DOMAIN'), 'and changed nothing').toBe(false)
    expect(app.repos.passkeys.listForUser(adminId), 'and kept the passkey').toHaveLength(1)
  })

  it('goes through once acknowledged, and takes every passkey with it', async () => {
    const other = app.repos.users.create({
      email: 'them@example.com',
      passwordHash: 'x',
      firstName: 'Grace',
      lastName: 'Hopper',
    })
    giveAPasskey(adminId, 'key-one')
    giveAPasskey(other.id, 'key-two')

    const res = await put({ key: 'DOMAIN', value: 'books.example.com', passkeysUnderstood: true })

    expect(res.statusCode).toBe(200)
    expect(settings.str('DOMAIN')).toBe('books.example.com')
    expect(app.repos.passkeys.listForUser(adminId)).toHaveLength(0)
    expect(app.repos.passkeys.listForUser(other.id)).toHaveLength(0)
  })

  it('marks everybody who had one, and nobody who did not', async () => {
    const withOne = app.repos.users.create({
      email: 'them@example.com',
      passwordHash: 'x',
      firstName: 'Grace',
      lastName: 'Hopper',
    })
    const without = app.repos.users.create({
      email: 'nobody@example.com',
      passwordHash: 'x',
      firstName: 'No',
      lastName: 'Keys',
    })
    giveAPasskey(withOne.id, 'key-two')

    await put({ key: 'DOMAIN', value: 'books.example.com', passkeysUnderstood: true })

    expect(app.repos.users.byId(withOne.id)?.passkeysClearedAt).toBeTruthy()
    expect(app.repos.users.byId(withOne.id)?.passkeysClearedFrom).toContain('://')
    expect(
      app.repos.users.byId(without.id)?.passkeysClearedAt,
      'nothing was taken from them, so nothing to explain'
    ).toBeNull()
  })

  it('asks nothing when there are no passkeys to lose', async () => {
    const res = await put({ key: 'DOMAIN', value: 'books.example.com' })

    expect(res.statusCode).toBe(200)
    expect(settings.str('DOMAIN')).toBe('books.example.com')
  })

  it('asks nothing when the value is not actually moving', async () => {
    giveAPasskey(adminId, 'key-one')
    const same = settings.raw('DOMAIN')

    const res = await put({ key: 'DOMAIN', value: same })

    expect(res.statusCode).toBe(200)
    expect(app.repos.passkeys.listForUser(adminId), 'a no-op takes nothing away').toHaveLength(1)
  })

  it('leaves everything that is not a passkey alone', async () => {
    giveAPasskey(adminId, 'key-one')
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run('x', adminId)

    await put({ key: 'DOMAIN', value: 'books.example.com', passkeysUnderstood: true })

    const after = app.repos.users.byId(adminId)!
    expect(after.totpEnabled, 'two-factor survives').toBe(true)
    expect(after.passwordHash, 'so does the password').toBeTruthy()
  })

  it('does not fire for a setting that is not the address', async () => {
    giveAPasskey(adminId, 'key-one')

    const res = await put({ key: 'SESSION_TTL', value: '900' })

    expect(res.statusCode).toBe(200)
    expect(app.repos.passkeys.listForUser(adminId)).toHaveLength(1)
  })
})

describe('telling the person who lost one', () => {
  it('carries the notice on their account until they say they have read it', async () => {
    giveAPasskey(adminId, 'key-one')
    await put({ key: 'DOMAIN', value: 'books.example.com', passkeysUnderstood: true })

    const before = (await app.inject({ url: '/auth/status', headers: { cookie } })).json()
    expect(before.user.passkeysClearedAt).toBeTruthy()
    expect(before.user.passkeysClearedFrom).toContain('://')

    const ack = await app.inject({
      method: 'POST',
      url: '/auth/passkeys/cleared/ack',
      headers: { cookie },
    })
    expect(ack.statusCode).toBe(200)

    const after = (await app.inject({ url: '/auth/status', headers: { cookie } })).json()
    expect(after.user.passkeysClearedAt, 'said once, not on every page').toBeNull()
  })

  it('cannot be acknowledged by somebody signed out', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/passkeys/cleared/ack' })
    expect(res.statusCode).toBe(401)
  })

  it('is drawn by the shared chrome, so it finds you wherever you land', async () => {
    const { readFileSync } = await import('node:fs')
    const shell = readFileSync('static/shell.js', 'utf8')

    expect(shell).toContain('passkeysClearedAt')
    expect(shell, 'and offers the way to fix it').toContain('/settings#security')
    expect(shell, 'and clears it when read').toContain('/auth/passkeys/cleared/ack')
  })
})
