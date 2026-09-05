import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBackup } from '../src/admin/backup.js'
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

const PASSWORD = 'a-perfectly-fine-password'

let app: FastifyInstance
let db: Db
let cookie: string

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
  const raw = res.headers['set-cookie']
  cookie = (Array.isArray(raw) ? raw : [raw]).map((l) => String(l).split(';')[0]).join('; ')
})

afterEach(async () => {
  await app.close()
  db.close()
})

function namesIn(tar: Buffer): { name: string; size: number }[] {
  const found: { name: string; size: number }[] = []
  let at = 0
  while (at + 512 <= tar.length) {
    const name = tar
      .subarray(at, at + 100)
      .toString('utf8')
      .replace(/\0.*$/, '')
    if (name === '') break

    const size = Number.parseInt(
      tar
        .subarray(at + 124, at + 136)
        .toString('ascii')
        .replace(/\0.*$/, ''),
      8
    )
    found.push({ name, size })
    at += 512 + Math.ceil(size / 512) * 512
  }
  return found
}

describe('the archive', () => {
  it('carries the database and every kept book', async () => {
    const kept = join(config.library.dir, 'someone')
    mkdirSync(kept, { recursive: true })
    writeFileSync(join(kept, 'a-book.epub'), 'not really an epub, but a file')

    const backup = await makeBackup(db, new Date('2026-08-12T09:30:00Z'))
    const chunks: Buffer[] = []
    for await (const chunk of backup.stream) chunks.push(chunk as Buffer)

    const names = namesIn(gunzipSync(Buffer.concat(chunks)))
    expect(names.map((f) => f.name)).toContain('db/send2ereader.db')
    expect(names.map((f) => f.name)).toContain('library/someone/a-book.epub')

    const book = names.find((f) => f.name === 'library/someone/a-book.epub')!
    expect(book.size, 'the body is the file, not a stub').toBe(30)

    rmSync(kept, { recursive: true, force: true })
  })

  it('names itself after the moment it was taken', async () => {
    const backup = await makeBackup(db, new Date('2026-08-12T09:30:00Z'))
    backup.stream.destroy()
    expect(backup.filename).toBe('send2ereader-2026-08-12-09-30-00.tar.gz')
  })

  it('is a database a fresh process can open and read', async () => {
    const backup = await makeBackup(db, new Date())
    const chunks: Buffer[] = []
    for await (const chunk of backup.stream) chunks.push(chunk as Buffer)

    const tar = gunzipSync(Buffer.concat(chunks))
    const entries = namesIn(tar)
    const record = entries.find((f) => f.name === 'db/send2ereader.db')!

    let at = 0
    let body: Buffer | null = null
    for (const entry of entries) {
      if (entry.name === record.name) {
        body = tar.subarray(at + 512, at + 512 + entry.size)
        break
      }
      at += 512 + Math.ceil(entry.size / 512) * 512
    }
    expect(body).not.toBeNull()

    const dir = mkdtempSync(join(tmpdir(), 's2e-restore-'))
    const path = join(dir, 'restored.db')
    writeFileSync(path, body!)

    const out = execFileSync(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite')
         const db = new DatabaseSync(process.argv[1], { readOnly: true })
         console.log(JSON.stringify(db.prepare('SELECT email FROM users').all()))`,
        path,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )

    expect(JSON.parse(out.trim())).toEqual([{ email: 'first@example.com' }])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('who may take one', () => {
  it('hands it to an admin as a download', async () => {
    const res = await app.inject({ url: '/api/admin/backup', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/gzip')
    expect(String(res.headers['content-disposition'])).toMatch(
      /attachment; filename="send2ereader-[\d-]+\.tar\.gz"/
    )
    expect(gunzipSync(res.rawPayload).length, 'and it is a real archive').toBeGreaterThan(1024)
  })

  it('is not there for somebody signed out', async () => {
    expect((await app.inject({ url: '/api/admin/backup' })).statusCode).toBe(401)
  })

  it('is not there for an account that is not an admin', async () => {
    const { settings } = await import('../src/settings.js')
    settings.set('ALLOW_SIGNUP', 'true', null)

    const made = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'second@example.com',
        password: PASSWORD,
        firstName: 'Grace',
        lastName: 'Hopper',
      },
    })
    const raw = made.headers['set-cookie']
    const theirs = (Array.isArray(raw) ? raw : [raw]).map((l) => String(l).split(';')[0]).join('; ')

    const res = await app.inject({ url: '/api/admin/backup', headers: { cookie: theirs } })
    expect(res.statusCode, 'not even that it exists').toBe(404)
    settings.clear('ALLOW_SIGNUP')
  })
})

describe('what the page is told about it', () => {
  it('counts what would go in', async () => {
    const res = await app.inject({ url: '/api/admin/settings', headers: { cookie } })
    expect(res.json().backup).toEqual({ books: 0, accounts: 1, bytes: 0 })
  })
})

it('takes its staging copy away with it', async () => {
  const staging = () => readdirSync(tmpdir()).filter((name) => name.startsWith('s2e-backup-'))
  const before = staging().length

  const backup = await makeBackup(db, new Date())
  for await (const chunk of backup.stream) expect(chunk).toBeInstanceOf(Buffer)

  await new Promise((r) => setTimeout(r, 100))
  expect(staging().length, 'a backup a week would otherwise fill /tmp with databases').toBe(before)
})
