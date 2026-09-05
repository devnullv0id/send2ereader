import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { prepareUploadDir } from '../src/files.js'
import { DeliveryQueue, titleFromName } from '../src/kobo/queue.js'
import {
  nextSyncToken,
  parseSyncToken,
  SYNC_TOKEN_HEADER,
  serialiseSyncToken,
} from '../src/kobo/synctoken.js'
import {
  asBrowser,
  COVER_PNG,
  contentsOf,
  epubWithCover,
  multipart,
  multipartHeaders,
  sampleEpub,
} from './helpers.js'

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
  await DeliveryQueue.prepare()
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

async function ownerCookie(): Promise<string> {
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
  app.repos.users.markVerified(app.repos.users.byEmail('owner@example.com')!.id)
  return cookieFrom(res)
}

async function registerDevice(cookie: string, body: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/devices',
    headers: { cookie },
    payload: { label: 'Clara', ...body },
  })
  return { id: res.json().device.id as string, token: res.json().token as string }
}

async function sendBook(
  cookie: string,
  deviceId: string,
  filename = 'My Book.epub',
  body: Buffer = sampleEpub()
) {
  return app.inject({
    method: 'POST',
    url: '/upload',
    headers: { ...multipartHeaders, cookie },
    payload: multipart([
      { name: 'deviceId', value: deviceId },
      { name: 'file', value: body, filename },
    ]),
  })
}

describe('sync token', () => {
  it('round-trips', () => {
    const token = { koboToken: 'abc', lastSync: '2026-01-01T00:00:00.000Z' }
    expect(parseSyncToken(serialiseSyncToken(token))).toEqual(token)
  })

  it('treats anything unreadable as a first sync', () => {
    for (const bad of [undefined, '', 'not-base64!!', Buffer.from('{').toString('base64')]) {
      expect(parseSyncToken(bad)).toEqual({})
    }
  })

  it('carries what the device sent and stamps this sync', () => {
    const previous = { koboToken: 'keep-me' }
    const next = parseSyncToken(nextSyncToken(previous, new Date('2026-02-03T04:05:06Z')))
    expect(next.koboToken).toBe('keep-me')
    expect(next.lastSync).toBe('2026-02-03T04:05:06.000Z')
  })
})

describe('title from filename', () => {
  it.each([
    ['My Book.kepub.epub', 'My Book'],
    ['My Book.epub', 'My Book'],
    ['Some_Book_Name.azw3', 'Some Book Name'],
    ['book.kfx-zip', 'book'],
    ['noextension', 'noextension'],
  ])('%s -> %s', (name, expected) => {
    expect(titleFromName(name)).toBe(expected)
  })
})

describe('device token guard', () => {
  it('refuses every endpoint without a known token', async () => {
    const bogus = 'x'.repeat(32)
    for (const url of [
      `/kobo/${bogus}/v1/initialization`,
      `/kobo/${bogus}/v1/library/sync`,
      `/kobo/${bogus}/download/abc`,
    ]) {
      expect((await app.inject({ url })).statusCode, url).toBe(401)
    }
  })

  it('stops working the moment the device is revoked', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)

    expect((await app.inject({ url: `/kobo/${token}/v1/library/sync` })).statusCode).toBe(200)
    await app.inject({ method: 'DELETE', url: `/api/devices/${id}`, headers: { cookie } })
    expect((await app.inject({ url: `/kobo/${token}/v1/library/sync` })).statusCode).toBe(401)
  })
})

describe('sending to a registered device', () => {
  it('refuses an anonymous sender', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)

    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'deviceId', value: id },
        { name: 'file', value: sampleEpub(), filename: 'book.epub' },
      ]),
    })
    expect(res.statusCode).toBe(401)
  })

  it("refuses someone else's device as missing", async () => {
    const mine = await ownerCookie()
    const other = app.repos.users.create({
      email: 'other@example.com',
      passwordHash: null,
      emailVerified: true,
    })
    const { device } = app.repos.devices.create(other.id, 'Theirs', true)

    const res = await sendBook(mine, device.id)
    expect(res.statusCode).toBe(404)
  })

  it('queues the book and reports it', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)

    const res = await sendBook(cookie, id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, deviceId: id, filename: 'My Book.epub' })
    expect(res.json().book.title).toBe('My Book')
    expect(app.deliveries.listFor(id)).toHaveLength(1)
  })

  it('leaves the upload directory clean, staging into the queue instead', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    await sendBook(cookie, id)

    expect(await contentsOf(config.uploadDir)).toHaveLength(0)
    expect(await contentsOf(config.kobo.queueDir)).toHaveLength(1)
  })

  async function sendHeld(cookie: string, deviceId: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { ...multipartHeaders, cookie },
      payload: multipart([
        { name: 'deviceId', value: deviceId },
        { name: 'hold', value: 'on' },
        { name: 'file', value: sampleEpub(), filename: 'Held Book.epub' },
      ]),
    })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  it('holds the book out of the queue until the sender says so', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)

    const body = await sendHeld(cookie, id)
    expect(body.pending).toEqual(expect.any(String))
    expect(app.deliveries.listFor(id), 'the Kobo has nothing to collect yet').toHaveLength(0)
  })

  it('queues it on commit', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    const body = await sendHeld(cookie, id)

    const commit = await app.inject({
      method: 'POST',
      url: '/upload/commit',
      headers: { cookie },
      payload: { deviceId: id, token: body.pending },
    })
    expect(commit.statusCode).toBe(200)
    expect(app.deliveries.listFor(id)).toHaveLength(1)
  })

  it('deletes it on discard, and the queue stays empty', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    const body = await sendHeld(cookie, id)

    const discard = await app.inject({
      method: 'POST',
      url: '/upload/discard',
      headers: { cookie },
      payload: { deviceId: id, token: body.pending },
    })
    expect(discard.json()).toMatchObject({ ok: true, discarded: true })
    expect(app.deliveries.listFor(id)).toHaveLength(0)
    expect(await contentsOf(config.kobo.queueDir), 'the staged file is gone').toHaveLength(0)
  })

  it('will not hand a held book to a stranger, or to the wrong device', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    const other = await registerDevice(cookie, { label: 'The other one' })
    const body = await sendHeld(cookie, id)

    const anonymous = await app.inject({
      method: 'POST',
      url: '/upload/commit',
      payload: { deviceId: id, token: body.pending },
    })
    expect(anonymous.statusCode, 'signed out').toBe(401)

    const wrongDevice = await app.inject({
      method: 'POST',
      url: '/upload/commit',
      headers: { cookie },
      payload: { deviceId: other.id, token: body.pending },
    })
    expect(wrongDevice.statusCode, 'a device the book was never meant for').toBe(404)

    expect(app.deliveries.listFor(id), 'still waiting for its own device').toHaveLength(0)
    expect(app.deliveries.listFor(other.id)).toHaveLength(0)
  })
})

describe('what the Waiting screen sees', () => {
  it('lists a queued book with the device that is waiting for it', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    await sendBook(cookie, id, 'Illustrated.epub', epubWithCover('meta'))

    const res = await app.inject({ url: '/api/waiting', headers: { cookie } })
    expect(res.statusCode).toBe(200)

    const [book] = res.json().books
    expect(book.title).toBe('A Book')
    expect(book.deviceLabel).toBe('Clara')
    expect(book.expiresIn).toBeGreaterThan(0)
    expect(book.expiresIn).toBeLessThanOrEqual(res.json().ttlSeconds)
  })

  it('counts across every device the account owns', async () => {
    const cookie = await ownerCookie()
    const first = await registerDevice(cookie)
    const second = await registerDevice(cookie)
    await sendBook(cookie, first.id)
    await sendBook(cookie, second.id)

    expect(
      (await app.inject({ url: '/api/waiting/count', headers: { cookie } })).json().count
    ).toBe(2)
  })

  it('empties as soon as the device collects the book', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id)
    const bookId = app.deliveries.listFor(id)[0]!.id

    await app.inject({ url: `/kobo/${token}/download/${bookId}` })

    expect((await app.inject({ url: '/api/waiting', headers: { cookie } })).json().books).toEqual(
      []
    )
    expect(
      (await app.inject({ url: '/api/waiting/count', headers: { cookie } })).json().count
    ).toBe(0)
  })

  it("never shows another account's queue", async () => {
    const mine = await ownerCookie()
    const other = app.repos.users.create({
      email: 'other@example.com',
      passwordHash: null,
      emailVerified: true,
    })
    const { device } = app.repos.devices.create(other.id, 'Theirs', true)
    app.deliveries.add({
      id: 'not-mine',
      deviceId: device.id,
      name: 'Secret.epub',
      path: 'nowhere',
      format: 'epub',
      size: 1,
    })

    expect(
      (await app.inject({ url: '/api/waiting', headers: { cookie: mine } })).json().books
    ).toEqual([])
  })
})

describe('deleting an account', () => {
  it('takes its devices and their queued books with it', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id)
    expect(await contentsOf(config.kobo.queueDir)).toHaveLength(1)

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/account',
      headers: { cookie },
      payload: { password: PASSWORD },
    })
    expect(res.statusCode).toBe(200)

    expect(app.repos.devices.byId(id)).toBeNull()
    expect(await contentsOf(config.kobo.queueDir), 'no orphaned files').toEqual([])
    expect((await app.inject({ url: `/kobo/${token}/v1/library/sync` })).statusCode).toBe(401)
  })

  it('ends the session, so the browser is anonymous again', async () => {
    const cookie = await ownerCookie()
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/account',
      headers: { cookie },
      payload: { password: PASSWORD },
    })

    const after = await app.inject({ url: '/auth/status', headers: { cookie: cookieFrom(res) } })
    expect(after.json().user).toBeNull()
  })

  it('leaves the server unclaimed when it was the only account, and says so', async () => {
    const cookie = await ownerCookie()
    expect(
      (await app.inject({ url: '/auth/status', headers: { cookie } })).json().soleAccount
    ).toBe(true)

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/account',
      headers: { cookie },
      payload: { password: PASSWORD },
    })
    expect(res.json().unclaimed).toBe(true)
    expect((await app.inject({ url: '/auth/status' })).json().unclaimed).toBe(true)
  })

  it('needs a session', async () => {
    await ownerCookie()
    expect((await app.inject({ method: 'DELETE', url: '/api/account' })).statusCode).toBe(401)
  })

  it("never touches another account's devices", async () => {
    const mine = await ownerCookie()
    const other = app.repos.users.create({
      email: 'other@example.com',
      passwordHash: null,
      emailVerified: true,
    })
    const { device } = app.repos.devices.create(other.id, 'Theirs', true)

    await app.inject({
      method: 'DELETE',
      url: '/api/account',
      headers: { cookie: mine },
      payload: { password: PASSWORD },
    })
    expect(app.repos.devices.byId(device.id)).not.toBeNull()
    expect(app.repos.users.byId(other.id)).not.toBeNull()
  })

  it('tells a second account that it is not the only one', async () => {
    const cookie = await ownerCookie()
    app.repos.users.create({
      email: 'other@example.com',
      passwordHash: null,
      emailVerified: true,
    })
    expect(
      (await app.inject({ url: '/auth/status', headers: { cookie } })).json().soleAccount
    ).toBe(false)
  })

  it('does not say how many accounts exist to someone signed out', async () => {
    await ownerCookie()
    expect((await app.inject({ url: '/auth/status' })).json().soleAccount).toBeNull()
  })
})

describe('rotating a device token', () => {
  it('issues a new one and stops the old one working', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)

    const res = await app.inject({
      method: 'POST',
      url: `/api/devices/${id}/token`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)

    const fresh = res.json().token as string
    expect(fresh).not.toBe(token)
    expect((await app.inject({ url: `/kobo/${fresh}/v1/library/sync` })).statusCode).toBe(200)
    expect((await app.inject({ url: `/kobo/${token}/v1/library/sync` })).statusCode).toBe(401)
  })

  it('keeps the device and whatever is queued for it', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    await sendBook(cookie, id)

    await app.inject({ method: 'POST', url: `/api/devices/${id}/token`, headers: { cookie } })
    expect(app.deliveries.listFor(id)).toHaveLength(1)
  })

  it("will not rotate another account's device", async () => {
    const mine = await ownerCookie()
    const other = app.repos.users.create({
      email: 'other@example.com',
      passwordHash: null,
      emailVerified: true,
    })
    const { device } = app.repos.devices.create(other.id, 'Theirs', true)

    const res = await app.inject({
      method: 'POST',
      url: `/api/devices/${device.id}/token`,
      headers: { cookie: mine },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('taking a queued book back', () => {
  it('deletes the file straight away, which is what the page promises', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    await sendBook(cookie, id)
    const bookId = app.deliveries.listFor(id)[0]!.id

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/waiting/${bookId}`,
      headers: { cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(app.deliveries.listFor(id)).toHaveLength(0)
    expect(await contentsOf(config.kobo.queueDir), 'nothing left on disk').toEqual([])
  })

  it('will not cancel a book queued for another account', async () => {
    const mine = await ownerCookie()
    const other = app.repos.users.create({
      email: 'other@example.com',
      passwordHash: null,
      emailVerified: true,
    })
    const { device } = app.repos.devices.create(other.id, 'Theirs', true)
    app.deliveries.add({
      id: 'not-mine',
      deviceId: device.id,
      name: 'Secret.epub',
      path: 'nowhere',
      format: 'epub',
      size: 1,
    })

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/waiting/not-mine',
      headers: { cookie: mine },
    })
    expect(res.statusCode).toBe(404)
    expect(app.deliveries.listFor(device.id)).toHaveLength(1)
  })
})

describe('collecting a queued book in the browser', () => {
  it('serves the bytes as an attachment', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    await sendBook(cookie, id)
    const bookId = app.deliveries.listFor(id)[0]!.id

    const res = await app.inject({ url: `/api/waiting/${bookId}/download`, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.rawPayload.length).toBeGreaterThan(0)
  })

  it('leaves the book queued, because a desktop copy is not a delivery', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    await sendBook(cookie, id)
    const bookId = app.deliveries.listFor(id)[0]!.id

    await app.inject({ url: `/api/waiting/${bookId}/download`, headers: { cookie } })
    expect(app.deliveries.listFor(id)).toHaveLength(1)
  })

  it('needs an account, like everything else about a registered device', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    await sendBook(cookie, id)
    const bookId = app.deliveries.listFor(id)[0]!.id

    expect((await app.inject({ url: `/api/waiting/${bookId}/download` })).statusCode).toBe(401)
  })
})

describe('the device collecting a book', () => {
  it('reports it as a new entitlement, then serves and deletes it', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id)

    const sync = await app.inject({ url: `/kobo/${token}/v1/library/sync` })
    expect(sync.statusCode).toBe(200)
    expect(sync.headers[SYNC_TOKEN_HEADER]).toBeTruthy()

    const entitlements = sync.json()
    expect(entitlements).toHaveLength(1)
    const entry = entitlements[0].NewEntitlement
    expect(entry.BookEntitlement.Status).toBe('Active')
    expect(entry.BookEntitlement.OriginCategory).toBe('Imported')
    expect(entry.BookMetadata.Title).toBe('My Book')

    const download = entry.BookMetadata.DownloadUrls[0]
    expect(download.DrmType).toBe('None')
    expect(download.Url).toContain(`/kobo/${token}/download/`)

    const bookId = entry.BookEntitlement.Id
    const file = await app.inject({ url: `/kobo/${token}/download/${bookId}` })
    expect(file.statusCode).toBe(200)
    expect(file.rawPayload.equals(sampleEpub())).toBe(true)

    expect(app.deliveries.listFor(id)).toHaveLength(0)
    expect(await contentsOf(config.kobo.queueDir)).toHaveLength(0)

    expect((await app.inject({ url: `/kobo/${token}/v1/library/sync` })).json()).toEqual([])
  })

  it('keeps the book queued until it is actually collected', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id)

    await app.inject({ url: `/kobo/${token}/v1/library/sync` })
    expect((await app.inject({ url: `/kobo/${token}/v1/library/sync` })).json()).toHaveLength(1)
    expect(app.deliveries.listFor(id)).toHaveLength(1)
  })

  it('serves per-book metadata and accepts reading state', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id)
    const bookId = app.deliveries.listFor(id)[0]!.id

    const meta = await app.inject({ url: `/kobo/${token}/v1/library/${bookId}/metadata` })
    expect(meta.statusCode).toBe(200)
    expect(meta.json()[0].Title).toBe('My Book')

    const put = await app.inject({
      method: 'PUT',
      url: `/kobo/${token}/v1/library/${bookId}/state`,
      payload: { ReadingStates: [] },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().RequestResult).toBe('Success')
  })

  it('serves the cover out of the queued book itself', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id, 'Illustrated.epub', epubWithCover('meta'))
    const bookId = app.deliveries.listFor(id)[0]!.id

    const res = await app.inject({
      url: `/kobo/${token}/v1/books/${bookId}/thumbnail/300/400/false/image.jpg`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.rawPayload.equals(COVER_PNG)).toBe(true)
  })

  it('advertises that cover id on the entitlement', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id, 'Illustrated.epub', epubWithCover('meta'))

    const sync = await app.inject({ url: `/kobo/${token}/v1/library/sync` })
    const metadata = sync.json()[0].NewEntitlement.BookMetadata
    const res = await app.inject({
      url: `/kobo/${token}/v1/books/${metadata.CoverImageId}/thumbnail/300/400/false/image.jpg`,
    })
    expect(res.statusCode).toBe(200)
  })

  it('reads the cover without disturbing the queued file', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id, 'Illustrated.epub', epubWithCover('meta'))
    const bookId = app.deliveries.listFor(id)[0]!.id

    await app.inject({ url: `/kobo/${token}/v1/books/${bookId}/thumbnail/300/400/false/image.jpg` })

    expect(app.deliveries.listFor(id)).toHaveLength(1)
    const file = await app.inject({ url: `/kobo/${token}/download/${bookId}` })
    expect(file.statusCode).toBe(200)
    expect(file.rawPayload.equals(epubWithCover('meta'))).toBe(true)
  })

  it('404s for a book with no cover rather than failing the sync', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id)
    const bookId = app.deliveries.listFor(id)[0]!.id

    const res = await app.inject({
      url: `/kobo/${token}/v1/books/${bookId}/thumbnail/300/400/false/image.jpg`,
    })
    expect(res.statusCode).toBe(404)
  })

  it('hands a store cover back to Kobo even when the store cannot be reached', async () => {
    const cookie = await ownerCookie()
    const { token } = await registerDevice(cookie)

    const res = await app.inject({
      url: `/kobo/${token}/v1/books/a-store-id/thumbnail/300/400/false/image.jpg`,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(
      'https://cdn.kobo.com/book-images/a-store-id/300/400/false/image.jpg'
    )
  })

  it("never serves one device the cover of another device's book", async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    const other = await registerDevice(cookie)
    await sendBook(cookie, id, 'Illustrated.epub', epubWithCover('meta'))
    const bookId = app.deliveries.listFor(id)[0]!.id

    const res = await app.inject({
      url: `/kobo/${other.token}/v1/books/${bookId}/thumbnail/300/400/false/image.jpg`,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('kobo.com')
    expect(res.rawPayload.equals(COVER_PNG)).toBe(false)
  })

  it('shows the book its own title and author, not the filename', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id, 'some_download_name.epub', epubWithCover('meta'))

    const metadata = (await app.inject({ url: `/kobo/${token}/v1/library/sync` })).json()[0]
      .NewEntitlement.BookMetadata

    expect(metadata.Title).toBe('A Book')
    expect(metadata.Contributors).toEqual(['Ursula Wright'])
    expect(metadata.Language).toBe('de')
  })

  it('falls back to the filename when the book declares nothing', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id, 'My_Book.epub')

    const metadata = (await app.inject({ url: `/kobo/${token}/v1/library/sync` })).json()[0]
      .NewEntitlement.BookMetadata

    expect(metadata.Title).toBe('My Book')
    expect(metadata.Contributors).toEqual(['send2ereader'])
    expect(metadata.Language).toBe('en')
  })

  it('reports the same title on the per-book metadata endpoint', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id, 'irrelevant.epub', epubWithCover('meta'))
    const bookId = app.deliveries.listFor(id)[0]!.id

    const meta = await app.inject({ url: `/kobo/${token}/v1/library/${bookId}/metadata` })
    expect(meta.json()[0].Title).toBe('A Book')
  })

  it('drops a book the device archives', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id)
    const bookId = app.deliveries.listFor(id)[0]!.id

    const res = await app.inject({ method: 'DELETE', url: `/kobo/${token}/v1/library/${bookId}` })
    expect(res.statusCode).toBe(204)
    expect(app.deliveries.listFor(id)).toHaveLength(0)
    expect(await contentsOf(config.kobo.queueDir)).toHaveLength(0)
  })

  it("never shows one device another device's book", async () => {
    const cookie = await ownerCookie()
    const first = await registerDevice(cookie)
    const second = await registerDevice(cookie)
    await sendBook(cookie, first.id)

    expect((await app.inject({ url: `/kobo/${second.token}/v1/library/sync` })).json()).toEqual([])

    const bookId = app.deliveries.listFor(first.id)[0]!.id
    const stolen = await app.inject({ url: `/kobo/${second.token}/download/${bookId}` })
    expect(stolen.statusCode).toBe(404)
  })
})

describe('check-in', () => {
  it('marks the device paired once it announces itself', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    expect(app.repos.devices.byId(id)!.lastSeenAt).toBeNull()

    const res = await app.inject({
      method: 'POST',
      url: `/kobo/${token}/v1/auth/device`,
      payload: { DeviceId: 'kobo-abc', UserKey: 'user-xyz' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().AccessToken).toBeTruthy()

    const device = app.repos.devices.byId(id)!
    expect(device.lastSeenAt).not.toBeNull()
    expect(device.koboDeviceId).toBe('kobo-abc')
  })

  it('points the device at this server for what it serves', async () => {
    const cookie = await ownerCookie()
    const { token } = await registerDevice(cookie)

    const res = await app.inject({ url: `/kobo/${token}/v1/initialization` })
    expect(res.statusCode).toBe(200)
    const resources = res.json().Resources
    expect(resources.library_sync).toContain(`/kobo/${token}/v1/library/sync`)
    expect(resources.library_metadata).toContain(`/kobo/${token}/`)
  })

  it('leaves the store to answer for what it does not serve', async () => {
    const cookie = await ownerCookie()
    const { token } = await registerDevice(cookie)

    const res = await app.inject({ url: `/kobo/${token}/v1/initialization` })
    const resources = res.json().Resources

    expect(resources.user_profile).toBe('https://storeapi.kobo.com/v1/user/profile')
    expect(resources.user_wishlist).toBe('https://storeapi.kobo.com/v1/user/wishlist')
    expect(Object.keys(resources).length).toBeGreaterThan(60)
  })
})

describe('the queue is an outbox, not a library', () => {
  it('expires an uncollected book and deletes its file', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    await sendBook(cookie, id)
    const book = app.deliveries.listFor(id)[0]!

    await app.deliveries.remove(book.id)
    expect(app.deliveries.listFor(id)).toHaveLength(0)
    expect(await contentsOf(config.kobo.queueDir)).toHaveLength(0)
  })

  it('drops everything when the app closes', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    await sendBook(cookie, id)
    expect(await contentsOf(config.kobo.queueDir)).toHaveLength(1)

    await app.close()
    expect(await contentsOf(config.kobo.queueDir)).toHaveLength(0)
  })

  it('purges the directory on boot without removing it', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    await sendBook(cookie, id)

    await DeliveryQueue.prepare()
    expect(await contentsOf(config.kobo.queueDir)).toHaveLength(0)
  })
})

describe('a kept copy backs up a book the queue has already let go', () => {
  async function keepFor(deviceId: string, bookId: string = randomUUID()) {
    await mkdir(config.library.dir, { recursive: true })
    const path = join(config.library.dir, `${bookId}.epub`)
    await writeFile(path, sampleEpub())

    app.repos.books.create({
      id: bookId,
      userId: app.repos.users.byEmail('owner@example.com')!.id,
      name: 'My Book.epub',
      title: 'My Book',
      authors: ['A Writer'],
      format: 'epub',
      size: sampleEpub().length,
      path,
      coverPath: null,
      coverType: null,
      source: 'send',
      deviceId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    return { bookId, path }
  }

  it('serves the kept copy once the queue entry is gone, and keeps it', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    const { bookId, path } = await keepFor(id)

    expect(app.deliveries.get(bookId, id)).toBeNull()

    const first = await app.inject({ url: `/kobo/${token}/download/${bookId}` })
    expect(first.statusCode).toBe(200)
    expect(first.rawPayload.equals(sampleEpub())).toBe(true)

    const again = await app.inject({ url: `/kobo/${token}/download/${bookId}` })
    expect(again.statusCode).toBe(200)
    expect(existsSync(path)).toBe(true)
  })

  it('keeps offering it on sync so a device that lost the file can fetch it again', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    const { bookId } = await keepFor(id)

    const sync = await app.inject({ url: `/kobo/${token}/v1/library/sync` })
    expect(sync.statusCode).toBe(200)

    const entitlements = sync.json()
    expect(entitlements).toHaveLength(1)
    expect(entitlements[0].NewEntitlement.BookEntitlement.Id).toBe(bookId)
  })

  it('offers a book once, not twice, while it is both queued and kept', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    await sendBook(cookie, id)

    const queued = app.deliveries.listFor(id)
    expect(queued).toHaveLength(1)
    await keepFor(id, queued[0]!.id)

    const entitlements = (await app.inject({ url: `/kobo/${token}/v1/library/sync` })).json()
    expect(entitlements).toHaveLength(1)
    expect(entitlements[0].NewEntitlement.BookEntitlement.Id).toBe(queued[0]!.id)
  })

  it('stops offering it once the device removes it from its books', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    const { bookId } = await keepFor(id)

    await app.inject({ method: 'DELETE', url: `/kobo/${token}/v1/library/${bookId}` })

    expect((await app.inject({ url: `/kobo/${token}/v1/library/sync` })).json()).toEqual([])
  })

  it('answers metadata for the kept copy too', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    const { bookId } = await keepFor(id)

    const res = await app.inject({ url: `/kobo/${token}/v1/library/${bookId}/metadata` })
    expect(res.statusCode).toBe(200)
    expect(res.json()[0].Title).toBe('My Book')
  })

  it('refuses a device the copy was not sent to', async () => {
    const cookie = await ownerCookie()
    const { id } = await registerDevice(cookie)
    const other = await registerDevice(cookie)
    const { bookId } = await keepFor(id)

    const res = await app.inject({ url: `/kobo/${other.token}/download/${bookId}` })
    expect(res.statusCode).toBe(404)
  })

  it('stops serving it once the device says it has it', async () => {
    const cookie = await ownerCookie()
    const { id, token } = await registerDevice(cookie)
    const { bookId } = await keepFor(id)

    const archived = await app.inject({
      method: 'DELETE',
      url: `/kobo/${token}/v1/library/${bookId}`,
    })
    expect(archived.statusCode).toBe(204)

    const res = await app.inject({ url: `/kobo/${token}/download/${bookId}` })
    expect(res.statusCode).toBe(404)
  })
})
