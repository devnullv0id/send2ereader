import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBackup } from '../src/admin/backup.js'
import {
  applyPendingRestore,
  discard,
  request,
  restorePaths,
  stage,
  staged,
} from '../src/admin/restore.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { tempFilePath } from '../src/files.js'

const stage2 = (name: string, from: string) => stage(name, from, roots)

const quiet = { info: () => undefined, error: () => undefined }

let db: Db
let roots: { dataDir: string; dbPath: string; libraryDir: string }

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 's2e-restore-'))
  roots = {
    dataDir,
    dbPath: join(dataDir, 'db', 'send2ereader.db'),
    libraryDir: join(dataDir, 'library'),
  }
  await mkdir(join(dataDir, 'db'), { recursive: true })
  await mkdir(roots.libraryDir, { recursive: true })

  db = openDatabase(roots.dbPath)
})

afterEach(async () => {
  try {
    db.close()
  } catch {}
  rmSync(roots.dataDir, { recursive: true, force: true })
})

function shelve(name: string): void {
  db.prepare(
    `INSERT INTO users (id, email, password_hash, email_verified, created_at)
     VALUES ('u1', 'owner@example.com', NULL, 1, '2026-01-01T00:00:00.000Z')`
  ).run()
  db.prepare(
    `INSERT INTO books (id, user_id, name, title, authors, format, size, path, source, created_at, expires_at)
     VALUES ('b1', 'u1', ?, 'A Book', '[]', 'epub', 4, ?, 'convert', '2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`
  ).run(name, join(roots.libraryDir, name))
}

async function archiveOf(): Promise<string> {
  const backup = await makeBackup(db, new Date(), roots.libraryDir)
  const path = tempFilePath('.tar.gz')
  await pipeline(backup.stream, (await import('node:fs')).createWriteStream(path))
  return path
}

async function archiveNaming(name: string, body: Buffer): Promise<string> {
  const block = Buffer.alloc(512)
  block.write(name.slice(0, 100), 0, 100, 'utf8')
  block.write('0000644\0', 100, 8, 'ascii')
  block.write('0000000\0', 108, 8, 'ascii')
  block.write('0000000\0', 116, 8, 'ascii')
  block.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  block.write('00000000000\0', 136, 12, 'ascii')
  block.write('        ', 148, 8, 'ascii')
  block.write('0', 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')

  const padding = body.length % 512 === 0 ? 0 : 512 - (body.length % 512)
  const tar = Buffer.concat([block, body, Buffer.alloc(padding), Buffer.alloc(1024)])

  const path = tempFilePath('.tar.gz')
  await pipeline(
    Readable.from([tar]),
    createGzip(),
    (await import('node:fs')).createWriteStream(path)
  )
  return path
}

describe('staging an archive', () => {
  it('reports nothing until one is uploaded', async () => {
    expect(await staged(roots)).toBeNull()
  })

  it('holds the name and the size, and is not a request on its own', async () => {
    const from = tempFilePath('.tar.gz')
    await writeFile(from, Buffer.alloc(2048))

    const held = await stage2('my-backup.tar.gz', from)
    expect(held).toMatchObject({ name: 'my-backup.tar.gz', size: 2048, requested: false })
    expect(existsSync(from), 'the upload was moved, not copied and left behind').toBe(false)

    expect((await staged(roots))?.requested).toBe(false)
    await request('u1', roots)
    expect((await staged(roots))?.requested).toBe(true)
  })

  it('does nothing at boot until it has been asked for', async () => {
    const from = tempFilePath('.tar.gz')
    await writeFile(from, Buffer.alloc(16))
    await stage2('untouched.tar.gz', from)

    expect(await applyPendingRestore(quiet, roots)).toBeNull()
    expect(await staged(roots), 'and the archive is still there').not.toBeNull()
  })

  it('forgets the whole thing when it is thrown away', async () => {
    const from = tempFilePath('.tar.gz')
    await writeFile(from, Buffer.alloc(16))
    await stage2('gone.tar.gz', from)
    await request('u1', roots)

    await discard(roots)
    expect(await staged(roots)).toBeNull()
    expect(existsSync(restorePaths(roots).dir)).toBe(false)
  })
})

describe('applying one at boot', () => {
  it('puts the database and the library back as they were', async () => {
    const book = join(roots.libraryDir, 'kept.epub')
    await mkdir(roots.libraryDir, { recursive: true })
    await writeFile(book, 'BOOK')
    shelve('kept.epub')

    const from = await archiveOf()
    db.close()

    await rm(book, { force: true })
    await rm(roots.dbPath, { force: true })
    expect(existsSync(roots.dbPath), 'wiped before the restore, as a restore would').toBe(false)

    await stage2('snapshot.tar.gz', from)
    await request('u1', roots)

    const outcome = await applyPendingRestore(quiet, roots)
    expect(outcome).toMatchObject({ ok: true, books: 1 })

    expect(readFileSync(book, 'utf8'), 'the kept file came back').toBe('BOOK')

    db = openDatabase(roots.dbPath)
    const row = db.prepare('SELECT email FROM users').get() as { email: string }
    expect(row.email).toBe('owner@example.com')
  })

  it('removes the archive once it has worked', async () => {
    shelve('none.epub')
    const from = await archiveOf()
    db.close()

    await stage2('snapshot.tar.gz', from)
    await request('u1', roots)
    expect((await applyPendingRestore(quiet, roots))?.ok).toBe(true)

    expect(await staged(roots), 'nothing is left to restore twice').toBeNull()
    db = openDatabase(roots.dbPath)
  })

  it('replaces what is there rather than merging with it', async () => {
    shelve('kept.epub')
    const from = await archiveOf()
    db.close()

    db = openDatabase(roots.dbPath)
    db.prepare(
      `INSERT INTO users (id, email, password_hash, email_verified, created_at)
       VALUES ('u2', 'later@example.com', NULL, 1, '2026-02-01T00:00:00.000Z')`
    ).run()
    db.close()

    await stage2('snapshot.tar.gz', from)
    await request('u1', roots)
    expect((await applyPendingRestore(quiet, roots))?.ok).toBe(true)

    db = openDatabase(roots.dbPath)
    const emails = (db.prepare('SELECT email FROM users').all() as { email: string }[]).map(
      (row) => row.email
    )
    expect(emails, 'the account made after the backup is gone with everything else').toEqual([
      'owner@example.com',
    ])
  })

  it('leaves the session key alone, because no archive carries one', async () => {
    const key = join(roots.dbPath, '..', 'session.key')
    await writeFile(key, 'a-key-worth-keeping')

    shelve('kept.epub')
    const from = await archiveOf()
    db.close()

    await stage2('snapshot.tar.gz', from)
    await request('u1', roots)
    expect((await applyPendingRestore(quiet, roots))?.ok).toBe(true)

    expect(await readFile(key, 'utf8')).toBe('a-key-worth-keeping')
    db = openDatabase(roots.dbPath)
  })

  it('refuses an archive with no database in it, and keeps it to look at', async () => {
    const from = await archiveNaming('library/orphan.epub', Buffer.from('no db here'))
    db.close()

    await stage2('broken.tar.gz', from)
    await request('u1', roots)

    const outcome = await applyPendingRestore(quiet, roots)
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome?.error).toContain('no database')
    expect((await staged(roots))?.name, 'kept, so it can be looked at').toBe('broken.tar.gz')
    expect((await staged(roots))?.requested, 'but not tried again on every boot').toBe(false)

    db = openDatabase(roots.dbPath)
  })

  it('ignores a member that names its way out of the data directory', async () => {
    const outside = join(roots.dataDir, 'escaped.txt')
    await rm(outside, { force: true })

    const from = await archiveNaming('library/../../escaped.txt', Buffer.from('should not land'))
    db.close()

    await stage2('nasty.tar.gz', from)
    await request('u1', roots)
    await applyPendingRestore(quiet, roots)

    expect(existsSync(outside), 'nothing was written outside the library').toBe(false)
    db = openDatabase(roots.dbPath)
  })
})
