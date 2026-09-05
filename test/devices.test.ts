import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { hashToken } from '../src/db/repositories.js'
import { decryptSecret } from '../src/db/secretbox.js'
import { prepareUploadDir } from '../src/files.js'
import { settings } from '../src/settings.js'
import { asBrowser, COVER_PNG } from './helpers.js'

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

async function signedIn(email = 'owner@example.com'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
  })
  const user = app.repos.users.byEmail(email)!
  app.repos.users.markVerified(user.id)
  return cookieFrom(res)
}

async function createDevice(cookie: string, body: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/api/devices', headers: { cookie }, payload: body })
}

describe('access control', () => {
  it('refuses an anonymous caller', async () => {
    for (const [method, url] of [
      ['GET', '/api/devices'],
      ['POST', '/api/devices'],
      ['PATCH', '/api/devices/x'],
      ['DELETE', '/api/devices/x'],
      ['GET', '/api/waiting'],
      ['GET', '/api/waiting/count'],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
    }
  })

  it('lets an unconfirmed account through when no mail can confirm it', async () => {
    settings.set('SMTP_ENABLED', 'false', null)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'owner@example.com',
        password: PASSWORD,
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
    })
    const cookie = cookieFrom(res)
    expect(app.repos.users.byEmail('owner@example.com')?.emailVerified).toBe(false)

    const listed = await app.inject({ url: '/api/devices', headers: { cookie } })
    expect(listed.statusCode, 'a confirmation nobody can send is not a bar to clear').toBe(200)
  })

  it('starts asking again the moment mail is configured', async () => {
    settings.set('SMTP_ENABLED', 'false', null)
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'owner@example.com',
        password: PASSWORD,
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
    })
    const cookie = cookieFrom(res)
    expect((await app.inject({ url: '/api/devices', headers: { cookie } })).statusCode).toBe(200)

    settings.set('SMTP_ENABLED', 'true', null)
    expect((await app.inject({ url: '/api/devices', headers: { cookie } })).statusCode).toBe(403)
  })

  it('refuses a signed-in account whose address is unconfirmed', async () => {
    settings.set('SMTP_ENABLED', 'true', null)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'owner@example.com',
        password: PASSWORD,
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
    })
    const cookie = cookieFrom(res)

    const listed = await app.inject({ url: '/api/devices', headers: { cookie } })
    expect(listed.statusCode).toBe(403)
    expect(listed.json().error).toMatch(/confirm/i)
  })

  it('allows a verified account', async () => {
    const cookie = await signedIn()
    const res = await app.inject({ url: '/api/devices', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ devices: [], storeEndpoint: config.kobo.storeUrl })
  })
})

describe('registering a device', () => {
  it('returns the token once, with the endpoint to paste into the Kobo', async () => {
    const cookie = await signedIn()
    const res = await createDevice(cookie, { label: 'Clara BW' })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.token).toMatch(/^[\w-]{20,}$/)
    expect(body.endpoint).toContain(`/kobo/${body.token}`)
    expect(body.device).toMatchObject({ label: 'Clara BW', proxyStore: true, paired: false })
  })

  it('never writes the token in the clear', async () => {
    const cookie = await signedIn()
    const token = (await createDevice(cookie)).json().token

    const row = db.prepare('SELECT token_hash, token_enc FROM devices').get() as {
      token_hash: string
      token_enc: string
    }
    expect(row.token_hash).toBe(hashToken(token))
    expect(row.token_hash).not.toBe(token)
    expect(row.token_enc, 'the stored copy is ciphertext, not the token').not.toContain(token)
    expect(decryptSecret(row.token_enc), 'and the server can read it back').toBe(token)
  })

  it('shows the endpoint again on a later visit', async () => {
    const cookie = await signedIn()
    const created = (await createDevice(cookie)).json()

    const listed = await app.inject({ url: '/api/devices', headers: { cookie } })
    expect(listed.json().devices[0].endpoint).toBe(created.endpoint)
  })

  it('looks the device up by its token', async () => {
    const cookie = await signedIn()
    const token = (await createDevice(cookie)).json().token
    expect(app.repos.devices.byToken(token)).not.toBeNull()
    expect(app.repos.devices.byToken('not-a-real-token')).toBeNull()
  })

  it('issues a different token every time', async () => {
    const cookie = await signedIn()
    const a = (await createDevice(cookie)).json().token
    const b = (await createDevice(cookie)).json().token
    expect(a).not.toBe(b)
  })

  it('names an unnamed device and tidies whitespace', async () => {
    const cookie = await signedIn()
    expect((await createDevice(cookie)).json().device.label).toBe('My Kobo')
    expect((await createDevice(cookie, { label: '  Kobo   Libra  ' })).json().device.label).toBe(
      'Kobo Libra'
    )
  })

  it('defaults the store proxy on', async () => {
    const cookie = await signedIn()
    expect((await createDevice(cookie)).json().device.proxyStore).toBe(true)
    expect((await createDevice(cookie, { proxyStore: false })).json().device.proxyStore).toBe(false)
  })
})

describe('listing and editing', () => {
  it("lists only the caller's own devices", async () => {
    const mine = await signedIn('owner@example.com')

    const other = app.repos.users.create({
      email: 'other@example.com',
      passwordHash: null,
      emailVerified: true,
    })
    app.repos.devices.create(other.id, "Someone else's Kobo", true)
    await createDevice(mine, { label: 'Mine' })

    const listed = await app.inject({ url: '/api/devices', headers: { cookie: mine } })
    expect(listed.json().devices).toHaveLength(1)
    expect(listed.json().devices[0].label).toBe('Mine')
  })

  it('renames and toggles the proxy', async () => {
    const cookie = await signedIn()
    const id = (await createDevice(cookie)).json().device.id

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/devices/${id}`,
      headers: { cookie },
      payload: { label: 'Renamed', proxyStore: false },
    })
    expect(res.json().device).toMatchObject({ label: 'Renamed', proxyStore: false })
  })

  it('refuses an empty name', async () => {
    const cookie = await signedIn()
    const id = (await createDevice(cookie)).json().device.id
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/devices/${id}`,
      headers: { cookie },
      payload: { label: '   ' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('removes a device', async () => {
    const cookie = await signedIn()
    const created = await createDevice(cookie)
    const { id } = created.json().device
    const token = created.json().token

    expect(
      (await app.inject({ method: 'DELETE', url: `/api/devices/${id}`, headers: { cookie } }))
        .statusCode
    ).toBe(200)

    expect(app.repos.devices.byToken(token)).toBeNull()
    expect((await app.inject({ url: '/api/devices', headers: { cookie } })).json().devices).toEqual(
      []
    )
  })

  it("reports someone else's device as missing, not forbidden", async () => {
    const mine = await signedIn('owner@example.com')
    const other = app.repos.users.create({
      email: 'other@example.com',
      passwordHash: null,
      emailVerified: true,
    })
    const { device } = app.repos.devices.create(other.id, 'Theirs', true)

    for (const method of ['PATCH', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: `/api/devices/${device.id}`,
        headers: { cookie: mine },
        payload: { label: 'hijacked' },
      })
      expect(res.statusCode, method).toBe(404)
    }
    expect(app.repos.devices.byId(device.id)!.label).toBe('Theirs')
  })
})

describe('pairing state', () => {
  it('reports a device as unpaired until it checks in', async () => {
    const cookie = await signedIn()
    const id = (await createDevice(cookie)).json().device.id

    app.repos.devices.recordSeen(id, 'kobo-device-1', 'kobo-user-1')

    const listed = await app.inject({ url: '/api/devices', headers: { cookie } })
    const device = listed.json().devices[0]
    expect(device.paired).toBe(true)
    expect(device.lastSeenAt).not.toBeNull()
  })

  it('removes a user and their devices together', async () => {
    const cookie = await signedIn()
    await createDevice(cookie)
    const user = app.repos.users.byEmail('owner@example.com')!

    db.prepare('DELETE FROM users WHERE id = ?').run(user.id)
    expect(app.repos.devices.listForUser(user.id)).toEqual([])
    const count = db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }
    expect(count.n).toBe(0)
  })
})

describe('the books a reader is keeping', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 's2e-books-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const BOOK = Buffer.from('a book, as far as these routes are concerned')

  async function shelve(
    userId: string,
    over: { id?: string; title?: string; cover?: boolean; createdAt?: string } = {}
  ) {
    const id = over.id ?? 'book-1'
    const path = join(dir, `${id}.epub`)
    await writeFile(path, BOOK)

    let coverPath: string | null = null
    if (over.cover !== false) {
      coverPath = join(dir, `${id}.cover`)
      await writeFile(coverPath, COVER_PNG)
    }

    return app.repos.books.create({
      id,
      userId,
      name: `${over.title ?? 'A Book'}.epub`,
      title: over.title ?? 'A Book',
      authors: ['Someone Else'],
      format: 'epub',
      size: BOOK.length,
      path,
      coverPath,
      coverType: coverPath ? 'image/png' : null,
      source: 'convert',
      createdAt: over.createdAt,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
  }

  it('refuses an anonymous caller', async () => {
    for (const [method, url] of [
      ['GET', '/api/library/books'],
      ['GET', '/api/library/x/cover'],
      ['GET', '/api/library/x/download'],
      ['DELETE', '/api/library/x'],
    ] as const) {
      const res = await app.inject({ method, url })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
    }
  })

  it('lists them newest first, without saying where they live', async () => {
    const cookie = await signedIn()
    const user = app.repos.users.byEmail('owner@example.com')!
    await shelve(user.id, { id: 'old', title: 'Older', createdAt: '2020-01-01T00:00:00.000Z' })
    await shelve(user.id, { id: 'new', title: 'Newer', createdAt: '2024-01-01T00:00:00.000Z' })

    const res = await app.inject({ url: '/api/library/books', headers: { cookie } })
    expect(res.statusCode).toBe(200)

    const { books } = res.json()
    expect(books.map((b: { title: string }) => b.title)).toEqual(['Newer', 'Older'])
    expect(books[0]).toMatchObject({
      title: 'Newer',
      authors: ['Someone Else'],
      source: 'convert',
      hasCover: true,
    })
    expect(Object.keys(books[0])).not.toContain('path')
    expect(Object.keys(books[0])).not.toContain('coverPath')
  })

  it('leaves a lapsed book out without waiting for the purge', async () => {
    const cookie = await signedIn()
    const user = app.repos.users.byEmail('owner@example.com')!
    await shelve(user.id)
    db.prepare("UPDATE books SET expires_at = '2000-01-01T00:00:00.000Z'").run()

    expect(
      (await app.inject({ url: '/api/library/books', headers: { cookie } })).json().books
    ).toEqual([])
    for (const url of ['/api/library/book-1/download', '/api/library/book-1/cover']) {
      expect((await app.inject({ url, headers: { cookie } })).statusCode, url).toBe(404)
    }
  })

  it('serves the cover, and 404s for a book that has none', async () => {
    const cookie = await signedIn()
    const user = app.repos.users.byEmail('owner@example.com')!
    await shelve(user.id, { id: 'with' })
    await shelve(user.id, { id: 'without', cover: false })

    const res = await app.inject({ url: '/api/library/with/cover', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.rawPayload.equals(COVER_PNG)).toBe(true)

    expect(
      (await app.inject({ url: '/api/library/without/cover', headers: { cookie } })).statusCode
    ).toBe(404)
  })

  it('hands over a copy and keeps the book', async () => {
    const cookie = await signedIn()
    const user = app.repos.users.byEmail('owner@example.com')!
    await shelve(user.id)

    const res = await app.inject({ url: '/api/library/book-1/download', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.equals(BOOK)).toBe(true)
    expect(res.headers['content-type']).toBe('application/epub+zip')
    expect(res.headers['content-disposition']).toContain('attachment')

    const after = await app.inject({ url: '/api/library/books', headers: { cookie } })
    expect(after.json().books).toHaveLength(1)
  })

  it('deletes the row and both files together', async () => {
    const cookie = await signedIn()
    const user = app.repos.users.byEmail('owner@example.com')!
    const book = await shelve(user.id)

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/library/book-1',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)

    expect(app.repos.books.listForUser(user.id)).toEqual([])
    expect(existsSync(book.path), 'the book').toBe(false)
    expect(existsSync(book.coverPath!), 'the cover beside it').toBe(false)
  })

  it("reports someone else's book as missing, not forbidden", async () => {
    const mine = await signedIn('owner@example.com')
    const other = app.repos.users.create({
      email: 'other@example.com',
      passwordHash: null,
      emailVerified: true,
    })
    const book = await shelve(other.id, { id: 'theirs' })

    for (const [method, url] of [
      ['GET', '/api/library/theirs/cover'],
      ['GET', '/api/library/theirs/download'],
      ['DELETE', '/api/library/theirs'],
    ] as const) {
      const res = await app.inject({ method, url, headers: { cookie: mine } })
      expect(res.statusCode, `${method} ${url}`).toBe(404)
    }
    expect(app.repos.books.byId(book.id)).not.toBeNull()
    expect(existsSync(book.path)).toBe(true)
  })
})
