import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { prepareUploadDir } from '../src/files.js'
import { DeliveryQueue } from '../src/kobo/queue.js'
import { problemWith, specFor } from '../src/settings.js'

const noTools = {
  kepubify: false,
  calibre: false,
  pdfcropmargins: false,
  kfxInput: false,
  kfxOutput: false,
  layoutFix: false,
}

let app: FastifyInstance
let db: Db

function store(value: string): void {
  db.prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)').run(
    'TRUST_PROXY',
    value,
    new Date().toISOString(),
    null
  )
}

async function serve(): Promise<void> {
  app = await buildApp({ tools: noTools, logger: false, accounts: true, db })
  app.get('/whoami', async (req) => ({ ip: req.ip }))
  await app.ready()
}

const forged = { url: '/whoami', headers: { 'x-forwarded-for': '203.0.113.77' } }

beforeEach(async () => {
  await prepareUploadDir(true)
  await DeliveryQueue.prepare()
  db = openDatabase(':memory:')
})

afterEach(async () => {
  await app.close()
  db.close()
})

describe('the address the page stores is the one the server runs with', () => {
  it('believes X-Forwarded-For from the address it was told to believe', async () => {
    store('loopback')
    await serve()

    expect((await app.inject(forged)).json()).toEqual({ ip: '203.0.113.77' })
  })

  it('ignores it when nothing was stored, which is the default', async () => {
    await serve()

    expect((await app.inject(forged)).json()).toEqual({ ip: '127.0.0.1' })
  })

  it('ignores it when the stored address is not the one the request came from', async () => {
    store('192.168.20.2')
    await serve()

    expect((await app.inject(forged)).json()).toEqual({ ip: '127.0.0.1' })
  })

  it('ignores it once the switch is turned off again', async () => {
    store('false')
    await serve()

    expect((await app.inject(forged)).json()).toEqual({ ip: '127.0.0.1' })
  })
})

describe('what the page is allowed to store', () => {
  const spec = specFor('TRUST_PROXY')!

  it('takes an address, a range, a name and the word that switches it off', () => {
    for (const value of ['192.168.20.2', '10.0.0.0/8', 'loopback', 'false']) {
      expect(problemWith(spec, value), value).toBeNull()
    }
  })

  it('refuses a bare true, which would believe anyone who reaches the port', async () => {
    for (const value of ['true', 'TRUE', 'yes', 'on', '1']) {
      expect(problemWith(spec, value), value).toMatch(/believe anyone who reaches this port/)
    }
  })

  it('refuses an empty value, so the switch cannot be on and mean nothing', () => {
    expect(problemWith(spec, '')).toMatch(/Give an address/)
  })
})

describe('what the address may be set to', () => {
  const spec = specFor('DOMAIN')!

  it('takes a name, a name with a port, an IP and nothing at all', () => {
    for (const value of [
      'books.example.com',
      'books.example.com:8443',
      'BOOKS.example.com',
      '192.168.20.2',
      '192.168.20.2:3010',
      'localhost',
      '[2001:db8::1]',
      '[2001:db8::1]:8443',
      'a-b.c-d.example',
      '',
    ]) {
      expect(problemWith(spec, value), value).toBeNull()
    }
  })

  it('refuses a pasted URL, because the scheme is the field beside it', () => {
    for (const value of [
      'https://books.example.com',
      'http://books.example.com/',
      'HTTPS://x.example',
    ]) {
      expect(problemWith(spec, value), value).toMatch(/without the https:\/\/ in front/)
    }
  })

  it('refuses a path, a query, a fragment and a backslash', () => {
    for (const value of [
      'books.example.com/some/path',
      'books.example.com/',
      'books.example.com?a=1',
      'books.example.com#x',
      'books.example.com\\evil',
    ]) {
      expect(problemWith(spec, value), value).toMatch(/no path after it/)
    }
  })

  it('refuses whitespace, which new URL() throws on and passkeys need', () => {
    for (const value of [
      'books example com',
      'books.example.com\nevil.example',
      ' books\t.example',
    ]) {
      expect(problemWith(spec, value), value).not.toBeNull()
    }
  })

  it('refuses what is not a hostname at all', () => {
    for (const value of ['-leading.example', 'trailing-.example', 'two..dots', ':8443', '%%%']) {
      expect(problemWith(spec, value), value).not.toBeNull()
    }
  })

  it('lets through only what new URL() can parse into a host', () => {
    for (const value of [
      'books.example.com',
      'books.example.com:8443',
      '[2001:db8::1]',
      '192.168.20.2',
    ]) {
      expect(problemWith(spec, value), value).toBeNull()
      const parsed = new URL(`https://${value}`)
      expect(parsed.hostname.length, value).toBeGreaterThan(0)
    }
  })
})
