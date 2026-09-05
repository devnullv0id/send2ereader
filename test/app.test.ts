import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { prepareUploadDir } from '../src/files.js'
import { silentAfterSeconds } from '../src/keystore.js'
import { contentsOf, multipart, multipartHeaders, sampleEpub } from './helpers.js'

const KOBO = 'Mozilla/5.0 (Linux; U; Kobo Touch)'
const OTHER = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120'

let app: FastifyInstance

const noTools = {
  kepubify: false,
  calibre: false,
  pdfcropmargins: false,
  kfxInput: false,
  kfxOutput: false,
  layoutFix: false,
}

beforeEach(async () => {
  await prepareUploadDir(true)
  app = await buildApp({ tools: noTools, logger: false, accounts: false })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

function expectNearly(actual: number, target: number, what: string): void {
  expect(actual, `${what}: ${actual}ms against ${target}ms`).toBeGreaterThan(target - 500)
  expect(actual, `${what}: ${actual}ms against ${target}ms`).toBeLessThanOrEqual(target)
}

async function generateKey(agent = KOBO): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/generate',
    headers: { 'user-agent': agent },
  })
  expect(res.statusCode).toBe(200)
  return res.body
}

describe('page routing', () => {
  it('serves the upload form to a normal browser', async () => {
    const res = await app.inject({ url: '/', headers: { 'user-agent': OTHER } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="submitbtn"')
  })

  it('serves the receive page to an eReader', async () => {
    const res = await app.inject({ url: '/', headers: { 'user-agent': KOBO } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('id="keyoutput"')
  })

  it('offers manual overrides in both directions', async () => {
    const receive = await app.inject({ url: '/receive', headers: { 'user-agent': OTHER } })
    expect(receive.body).toContain('id="keyoutput"')
    const send = await app.inject({ url: '/send', headers: { 'user-agent': KOBO } })
    expect(send.body).toContain('id="submitbtn"')
  })

  it('serves static assets', async () => {
    const res = await app.inject({ url: '/style.css' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/css')
  })

  it('reports health and tool availability', async () => {
    const res = await app.inject({ url: '/healthz' })
    expect(res.json()).toMatchObject({ ok: true, tools: noTools })
  })

  it('does not tell an anonymous caller how many keys are live, or how long they are', async () => {
    const body = (await app.inject({ url: '/healthz' })).json()
    expect(body.keys, 'how full the guessing space is').toBeUndefined()
    expect(body.keyLength, 'and how big it is').toBeUndefined()
  })
})

describe('the pages the design adds', () => {
  it.each([['/history', 'History']])('serves %s', async (url, marker) => {
    const res = await app.inject({ url, headers: { 'user-agent': OTHER } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain(marker)
  })

  it('does not serve /waiting without accounts', async () => {
    expect((await app.inject({ url: '/waiting' })).statusCode).toBe(404)
  })

  it('serves the vendored design assets, so no page needs a CDN', async () => {
    for (const url of [
      '/app.css',
      '/screens.css',
      '/shell.js',
      '/history.js',
      '/fonts/fonts.css',
      '/fonts/phosphor.css',
      '/fonts/phosphor-regular.woff2',
    ]) {
      expect((await app.inject({ url })).statusCode, url).toBe(200)
    }
  })
})

describe('pairing', () => {
  it('generates a key of the configured length from the allowed alphabet', async () => {
    const key = await generateKey()
    expect(key).toHaveLength(config.keyLength)
    expect(key).toMatch(/^[23456789ACDEFGHJKLMNPRSTUVWXYZ]+$/)
  })

  it('generates distinct keys', async () => {
    const keys = new Set<string>()
    for (let i = 0; i < 25; i++) keys.add(await generateKey())
    expect(keys.size).toBe(25)
  })

  it('reports status to the owning eReader', async () => {
    const key = await generateKey()
    const res = await app.inject({ url: `/status/${key}`, headers: { 'user-agent': KOBO } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ file: null, urls: [] })
  })

  it('accepts a lowercase key', async () => {
    const key = await generateKey()
    const res = await app.inject({
      url: `/status/${key.toLowerCase()}`,
      headers: { 'user-agent': KOBO },
    })
    expect(res.statusCode).toBe(200)
  })

  it('hides a key from a different user-agent', async () => {
    const key = await generateKey()
    const res = await app.inject({ url: `/status/${key}`, headers: { 'user-agent': OTHER } })
    expect(res.statusCode).toBe(404)
  })

  it('404s an unknown key', async () => {
    const res = await app.inject({ url: '/status/ZZZZ', headers: { 'user-agent': KOBO } })
    expect(res.statusCode).toBe(404)
  })

  it.each([
    'application/x-www-form-urlencoded',
    'text/plain',
    'application/xml',
    'application/octet-stream',
  ])('generates a key when the browser sends Content-Type: %s', async (contentType) => {
    const res = await app.inject({
      method: 'POST',
      url: '/generate',
      headers: { 'user-agent': KOBO, 'content-type': contentType },
      payload: '',
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toHaveLength(config.keyLength)
  })

  it('reports the paired device to the sender', async () => {
    const key = await generateKey(KOBO)
    const res = await app.inject({ url: `/key/${key}`, headers: { 'user-agent': OTHER } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ device: 'kobo', hasFile: false, label: 'a Kobo device' })
  })

  it('reports whether the eReader is still there', async () => {
    const key = await generateKey(KOBO)
    const res = await app.inject({ url: `/key/${key}`, headers: { 'user-agent': OTHER } })

    expect(res.json().connected).toBe(true)
    expect(res.json().silentFor).toBeLessThan(2)
  })

  it('opens the countdown at the full grace when the link is declared lost', async () => {
    const key = await generateKey(KOBO)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(Date.now() + silentAfterSeconds() * 1000))
      const atLoss = await app.inject({ url: `/key/${key}`, headers: { 'user-agent': OTHER } })
      expect(atLoss.json().connected).toBe(false)
      expectNearly(atLoss.json().expiresInMs, config.expireSeconds * 1000, 'the whole grace')

      vi.setSystemTime(new Date(Date.now() + (20 - silentAfterSeconds()) * 1000))
      const res = await app.inject({ url: `/key/${key}`, headers: { 'user-agent': OTHER } })

      expect(res.statusCode, 'the key is still there to ask about').toBe(200)
      expect(res.json().connected).toBe(false)
      expect(res.json().silentFor).toBeGreaterThanOrEqual(20)
      expectNearly(
        res.json().expiresInMs,
        (config.expireSeconds + silentAfterSeconds() - 20) * 1000,
        'what is left after twenty seconds'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts nothing down while the eReader is answering', async () => {
    const key = await generateKey(KOBO)
    const res = await app.inject({ url: `/key/${key}`, headers: { 'user-agent': OTHER } })
    expect(res.json().connected).toBe(true)
    expectNearly(
      res.json().expiresInMs,
      (config.expireSeconds + silentAfterSeconds()) * 1000,
      'the full allowance while it is answering'
    )
  })

  it('extends a key without pretending the eReader came back', async () => {
    const key = await generateKey(KOBO)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(Date.now() + 20_000))

      const extended = await app.inject({ method: 'POST', url: `/key/${key}/extend` })
      expect(extended.statusCode).toBe(200)
      expect(extended.json().ok).toBe(true)
      expectNearly(extended.json().expiresInMs, config.expireSeconds * 1000, 'a full grace')

      const after = await app.inject({ url: `/key/${key}`, headers: { 'user-agent': OTHER } })
      expect(after.json().connected, 'still asleep, just not expiring').toBe(false)
      expect(after.json().silentFor).toBeGreaterThanOrEqual(20)
    } finally {
      vi.useRealTimers()
    }
  })

  it('404s an extend for an unknown key', async () => {
    const res = await app.inject({ method: 'POST', url: '/key/ZZZZ/extend' })
    expect(res.statusCode).toBe(404)
  })

  it('polls the eReader page at the interval the server assumes', () => {
    const page = readFileSync(join(config.staticDir, 'download.html'), 'utf8')
    const interval = /setInterval\(pollFile, (\d+) \* 1000\)/.exec(page)?.[1]
    expect(interval, 'download.html no longer sets its poll interval this way').toBeDefined()
    expect(Number(interval)).toBe(config.ereaderPollSeconds)
  })

  it('404s a device lookup for an unknown key', async () => {
    const res = await app.inject({ url: '/key/ZZZZ' })
    expect(res.statusCode).toBe(404)
  })
})

describe('upload', () => {
  it('rejects a non-multipart body', async () => {
    const res = await app.inject({ method: 'POST', url: '/upload', payload: { key: 'ABCD' } })
    expect(res.statusCode).toBe(415)
  })

  it('rejects a missing key without crashing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([{ name: 'file', value: sampleEpub(), filename: 'book.epub' }]),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/No key/)
  })

  it('rejects an unknown key and deletes the temp file', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: 'ZZZZ' },
        { name: 'file', value: sampleEpub(), filename: 'book.epub' },
      ]),
    })
    expect(res.statusCode).toBe(400)
    expect(await contentsOf(config.uploadDir)).toHaveLength(0)
  })

  it('rejects a file whose contents contradict its extension', async () => {
    const key = await generateKey()
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'file', value: 'this is plain text', filename: 'book.epub' },
      ]),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/not a valid/)
    expect(await contentsOf(config.uploadDir)).toHaveLength(0)
  })

  it('rejects an unsupported extension', async () => {
    const key = await generateKey()
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'file', value: 'MZ', filename: 'payload.exe' },
      ]),
    })
    expect(res.statusCode).toBe(400)
    expect(await contentsOf(config.uploadDir)).toHaveLength(0)
  })

  it('accepts a .kfx with the right container magic', async () => {
    const key = await generateKey()
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'file', value: Buffer.from('CONTsome kfx payload'), filename: 'book.kfx' },
      ]),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().filename).toBe('book.kfx')
  })

  it('rejects a .kfx that lacks the container magic', async () => {
    const key = await generateKey()
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'file', value: 'definitely not a kfx container', filename: 'book.kfx' },
      ]),
    })
    expect(res.statusCode).toBe(400)
    expect(await contentsOf(config.uploadDir)).toHaveLength(0)
  })

  it('accepts a .kfx-zip container', async () => {
    const key = await generateKey()
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'file', value: sampleEpub(), filename: 'book.kfx-zip' },
      ]),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().filename).toBe('book.kfx-zip')
  })

  it('rejects an empty file', async () => {
    const key = await generateKey()
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'file', value: '', filename: 'book.txt' },
      ]),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/empty/)
  })

  async function uploadHeld(key: string, filename = 'Held Book.epub') {
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'hold', value: 'on' },
        { name: 'file', value: sampleEpub(), filename },
      ]),
    })
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  it('holds the book back when asked, so the sender can still call it off', async () => {
    const key = await generateKey()
    const body = await uploadHeld(key)

    expect(body.pending, 'a token to decide with').toEqual(expect.any(String))

    const status = await app.inject({ url: `/status/${key}`, headers: { 'user-agent': KOBO } })
    expect(status.json().file, 'nothing reaches the device yet').toBeNull()
  })

  it('hands the book over on commit', async () => {
    const key = await generateKey()
    const body = await uploadHeld(key)

    const commit = await app.inject({
      method: 'POST',
      url: '/upload/commit',
      payload: { key, token: body.pending },
    })
    expect(commit.statusCode).toBe(200)

    const status = await app.inject({ url: `/status/${key}`, headers: { 'user-agent': KOBO } })
    expect(status.json().file).toMatchObject({ name: 'Held Book.epub' })
  })

  it('deletes the book on discard, and the device never sees it', async () => {
    const key = await generateKey()
    const body = await uploadHeld(key)

    const discard = await app.inject({
      method: 'POST',
      url: '/upload/discard',
      payload: { key, token: body.pending },
    })
    expect(discard.json()).toMatchObject({ ok: true, discarded: true })

    const status = await app.inject({ url: `/status/${key}`, headers: { 'user-agent': KOBO } })
    expect(status.json().file).toBeNull()
    expect(await contentsOf(config.uploadDir), 'nothing left on disk').toEqual([])
  })

  it('cannot be claimed twice, nor with the wrong key', async () => {
    const key = await generateKey()
    const other = await generateKey()
    const body = await uploadHeld(key)

    const wrongKey = await app.inject({
      method: 'POST',
      url: '/upload/commit',
      payload: { key: other, token: body.pending },
    })
    expect(wrongKey.statusCode).toBe(404)

    const first = await app.inject({
      method: 'POST',
      url: '/upload/commit',
      payload: { key, token: body.pending },
    })
    expect(first.statusCode).toBe(200)

    const again = await app.inject({
      method: 'POST',
      url: '/upload/commit',
      payload: { key, token: body.pending },
    })
    expect(again.statusCode).toBe(404)
  })

  it('accepts an EPUB and exposes it for download', async () => {
    const key = await generateKey()
    const upload = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'kepubify', value: 'on' },
        { name: 'file', value: sampleEpub(), filename: 'My Book.epub' },
      ]),
    })
    expect(upload.statusCode).toBe(200)
    expect(upload.json()).toMatchObject({ ok: true, filename: 'My Book.epub', conversion: [] })

    const status = await app.inject({ url: `/status/${key}`, headers: { 'user-agent': KOBO } })
    expect(status.json().file).toMatchObject({ name: 'My Book.epub' })

    const download = await app.inject({
      url: `/download/${encodeURIComponent('My Book.epub')}?key=${key}`,
      headers: { 'user-agent': KOBO },
    })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-type']).toBe('application/epub+zip')
    expect(download.rawPayload.equals(sampleEpub())).toBe(true)
  })

  it('returns messages as data, never as HTML', async () => {
    const key = await generateKey()
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'file', value: sampleEpub(), filename: '<img src=x onerror=alert(1)>.epub' },
      ]),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.messages)).toBe(true)
    expect(body.messages.join(' ')).toContain(body.filename)
  })

  it('accepts a url on its own and rejects non-http schemes', async () => {
    const key = await generateKey()
    const ok = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'url', value: 'https://example.com/book' },
      ]),
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().url).toBe('https://example.com/book')

    const bad = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'url', value: 'javascript:alert(1)' },
      ]),
    })
    expect(bad.statusCode).toBe(400)
  })

  it('rejects an upload with neither file nor url', async () => {
    const key = await generateKey()
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([{ name: 'key', value: key }]),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/No file or url/)
  })

  it('replaces a previous upload and leaves only one file on disk', async () => {
    const key = await generateKey()
    for (const name of ['first.epub', 'second.epub']) {
      const res = await app.inject({
        method: 'POST',
        url: '/upload',
        headers: multipartHeaders,
        payload: multipart([
          { name: 'key', value: key },
          { name: 'file', value: sampleEpub(), filename: name },
        ]),
      })
      expect(res.statusCode).toBe(200)
    }
    expect(await contentsOf(config.uploadDir)).toHaveLength(1)
  })
})

describe('download guards', () => {
  async function seed(): Promise<string> {
    const key = await generateKey()
    await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'file', value: sampleEpub(), filename: 'book.epub' },
      ]),
    })
    return key
  }

  it('requires a key', async () => {
    const key = await seed()
    void key
    const res = await app.inject({ url: '/download/book.epub', headers: { 'user-agent': KOBO } })
    expect(res.statusCode).toBe(400)
  })

  it('requires the owning user-agent', async () => {
    const key = await seed()
    const res = await app.inject({
      url: `/download/book.epub?key=${key}`,
      headers: { 'user-agent': OTHER },
    })
    expect(res.statusCode).toBe(404)
  })

  it('requires the exact filename', async () => {
    const key = await seed()
    const res = await app.inject({
      url: `/download/other.epub?key=${key}`,
      headers: { 'user-agent': KOBO },
    })
    expect(res.statusCode).toBe(404)
  })

  it('serves byte ranges', async () => {
    const key = await seed()
    const res = await app.inject({
      url: `/download/book.epub?key=${key}`,
      headers: { 'user-agent': KOBO, range: 'bytes=0-3' },
    })
    expect(res.statusCode).toBe(206)
    expect(res.headers['content-range']).toMatch(/^bytes 0-3\//)
    expect(res.rawPayload).toHaveLength(4)
  })
})

describe('DELETE /file/:key', () => {
  it('removes the file from disk, not just from the key', async () => {
    const key = await generateKey()
    await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'file', value: sampleEpub(), filename: 'book.epub' },
      ]),
    })
    expect(await contentsOf(config.uploadDir)).toHaveLength(1)

    const res = await app.inject({
      method: 'DELETE',
      url: `/file/${key}`,
      headers: { 'user-agent': KOBO },
    })
    expect(res.statusCode).toBe(200)
    expect(await contentsOf(config.uploadDir)).toHaveLength(0)

    const status = await app.inject({ url: `/status/${key}`, headers: { 'user-agent': KOBO } })
    expect(status.json().file).toBeNull()
  })

  it('refuses a foreign user-agent', async () => {
    const key = await generateKey()
    const res = await app.inject({
      method: 'DELETE',
      url: `/file/${key}`,
      headers: { 'user-agent': OTHER },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('shutdown', () => {
  it('deletes every stored file when the app closes', async () => {
    const key = await generateKey()
    await app.inject({
      method: 'POST',
      url: '/upload',
      headers: multipartHeaders,
      payload: multipart([
        { name: 'key', value: key },
        { name: 'file', value: sampleEpub(), filename: 'book.epub' },
      ]),
    })
    expect(await contentsOf(config.uploadDir)).toHaveLength(1)

    await app.close()
    expect(await contentsOf(config.uploadDir)).toHaveLength(0)
  })
})

describe('the headers every response carries', () => {
  it('sets a policy with no room for an inline script', async () => {
    const res = await app.inject({ url: '/', headers: { 'user-agent': OTHER } })
    const csp = String(res.headers['content-security-policy'])

    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp, 'nothing here needs it').not.toContain('unsafe-inline')
    expect(csp, 'nor this').not.toContain('unsafe-eval')
  })

  it('refuses to be framed, sniffed or over-referred', async () => {
    const res = await app.inject({ url: '/', headers: { 'user-agent': OTHER } })

    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('same-origin')
    expect(String(res.headers['permissions-policy'])).toContain('camera=()')
  })

  it('carries them on the api too, not just the pages', async () => {
    const res = await app.inject({ url: '/healthz' })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toBeTruthy()
  })

  it('does not promise https from a server reached over http', async () => {
    const res = await app.inject({ url: '/healthz' })
    expect(config.publicUrl.startsWith('https://'), 'the test server is plain http').toBe(false)
    expect(res.headers['strict-transport-security'], 'so no HSTS to strand anyone').toBeUndefined()
  })

  // helmet turns this on by default. It rewrites every stylesheet, script and
  // font request to https://, so on a plain-http instance the page loads and
  // nothing else does. It is a no-op on localhost, so it survives local testing
  // and only appears once the app is opened by IP — which is how it is used.
  it('does not upgrade its own assets to https it cannot serve', async () => {
    const csp = String((await app.inject({ url: '/' })).headers['content-security-policy'])
    expect(csp, 'the policy is there to check').toContain("default-src 'self'")
    expect(csp).not.toContain('upgrade-insecure-requests')
  })

  it('asks for nothing off this origin, so no upgrade is needed', async () => {
    const csp = String((await app.inject({ url: '/healthz' })).headers['content-security-policy'])
    for (const directive of ['script-src', 'style-src', 'font-src', 'connect-src']) {
      expect(csp, directive).toContain(`${directive} 'self'`)
    }
  })
})

describe('what an anonymous caller may ask for repeatedly', () => {
  it('throttles /convert, which writes a file and forks a converter', async () => {
    const codes: number[] = []
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/convert',
        headers: multipartHeaders,
        payload: multipart([{ name: 'file', value: sampleEpub(), filename: 'b.epub' }]),
      })
      codes.push(res.statusCode)
    }
    expect(codes, 'the limit is 5 a minute').toContain(429)
  })

  it('throttles /upload too', async () => {
    const codes: number[] = []
    for (let i = 0; i < 24; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/upload',
        headers: multipartHeaders,
        payload: multipart([{ name: 'key', value: 'ZZZZ' }]),
      })
      codes.push(res.statusCode)
    }
    expect(codes, 'the limit is 20 a minute').toContain(429)
  })

  it('leaves the pairing loop alone, which an eReader polls by design', async () => {
    const key = await generateKey()
    const codes: number[] = []
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({ url: `/status/${key}`, headers: { 'user-agent': KOBO } })
      codes.push(res.statusCode)
    }
    expect(
      codes.every((c) => c === 200),
      'polling is the protocol, not abuse'
    ).toBe(true)
  })
})
