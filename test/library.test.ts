import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claimDirectory, MARKER } from '../src/files.js'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 's2e-library-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(snippet: string, env: Record<string, string> = {}): Record<string, unknown> {
  const libraryDir = mkdtempSync(join(dir, 'lib-'))
  const body = `
    const { mkdtempSync } = await import('node:fs')
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { openDatabase } = await import('./src/db/index.ts')
    const { createRepositories } = await import('./src/db/repositories.ts')
    const { Library } = await import('./src/library.ts')
    const { epubWithCover } = await import('./test/helpers.ts')

    const silent = { info() {}, warn() {}, error() {} }
    const db = openDatabase(':memory:')
    const repos = createRepositories(db)
    const library = new Library(repos.books, silent)
    await Library.prepare()

    const user = repos.users.create({
      email: 'reader@example.com',
      passwordHash: 'x',
    })

    // A real book on disk, so the cover and metadata paths run for real.
    const source = join(mkdtempSync(join(tmpdir(), 's2e-src-')), 'A Book.epub')
    await writeFile(source, epubWithCover('properties'))

    const out = {}
    ${snippet}
    console.log(JSON.stringify(out))
  `

  const stdout = execFileSync(process.execPath, ['--import', 'tsx', '-e', body], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      ENV_FILE: 'test/no-such.env',
      LOG_LEVEL: 'silent',
      UPLOAD_DIR: 'uploads-test',
      KOBO_QUEUE_DIR: 'queue-test',
      SESSION_SECRET: 'test-secret-not-used-outside-the-suite',
      SCRYPT_N: '1024',
      LIBRARY_DIR: libraryDir,
      ...env,
    } as NodeJS.ProcessEnv,
  })
  return JSON.parse(stdout.trim().split('\n').pop() as string)
}

const KEEP = `
  const result = await library.keep({
    id: 'book-1',
    userId: user.id,
    retainMinutes: null,
    from: source,
    name: 'A Book.epub',
    source: 'send',
  })
  out.kept = result.kept
  out.reason = result.kept ? null : result.reason
  if (result.kept) {
    const { stat } = await import('node:fs/promises')
    out.fileOnDisk = await stat(result.book.path).then(() => true, () => false)
    out.coverOnDisk = result.book.coverPath
      ? await stat(result.book.coverPath).then(() => true, () => false)
      : false
    out.coverType = result.book.coverType
    out.title = result.book.title
    out.days = Math.round((Date.parse(result.book.expiresAt) - Date.now()) / 86400000)
    out.rows = repos.books.listForUser(user.id).length
  }
`

describe('keeping a book', () => {
  it('keeps nothing at all when retention is off', () => {
    const out = run(KEEP, { RETAIN_DAYS: '0' })
    expect(out.kept).toBe(false)
    expect(out.reason).toBe('off')
  })

  it('keeps the book, its cover and its deadline when it is on', () => {
    const out = run(KEEP, { RETAIN_DAYS: '7' })
    expect(out.kept).toBe(true)
    expect(out.fileOnDisk, 'the book').toBe(true)
    expect(out.coverOnDisk, 'the cover beside it').toBe(true)
    expect(out.coverType).toBe('image/png')
    expect(out.title).toBe('A Book')
    expect(out.days).toBe(7)
    expect(out.rows).toBe(1)
  })

  it('refuses when the account has filled its own share', () => {
    const out = run(KEEP, { RETAIN_DAYS: '7', STORAGE_PER_USER: '10' })
    expect(out.kept).toBe(false)
    expect(out.reason).toBe('user-full')
  })

  it('refuses, and blames the server, when the whole library is full', () => {
    const out = run(KEEP, { RETAIN_DAYS: '7', STORAGE_TOTAL: '10' })
    expect(out.kept).toBe(false)
    expect(out.reason).toBe('server-full')
  })

  it('never lets an account keep a book for longer than the server allows', () => {
    const out = run(
      `
      out.asked = library.retainMinutesFor(365 * 1440)
      out.unset = library.retainMinutesFor(null)
      out.off = library.retainMinutesFor(0)
      out.halfHour = library.retainMinutesFor(30)
      `,
      { RETAIN_DAYS: '7' }
    )
    const ceiling = 7 * 1440
    expect(out.asked, 'clamped to the ceiling').toBe(ceiling)
    expect(out.unset, 'no preference follows the server').toBe(ceiling)
    expect(out.off, 'a reader who turned it off stays off').toBe(0)
    expect(out.halfHour, 'a shorter unit than a day survives').toBe(30)
  })
})

describe('giving the disk back', () => {
  it('deletes the file and the cover when a book lapses', () => {
    const out = run(
      `
      const { stat } = await import('node:fs/promises')
      const kept = await library.keep({
        id: 'book-1', userId: user.id, retainMinutes: null,
        from: source, name: 'A Book.epub', source: 'send',
      })
      const path = kept.book.path
      const cover = kept.book.coverPath

      // Reach past the deadline rather than waiting a week for it.
      db.prepare("UPDATE books SET expires_at = '2000-01-01T00:00:00.000Z'").run()
      out.hiddenImmediately = repos.books.listForUser(user.id).length
      out.purged = await library.purgeExpired()
      out.fileGone = await stat(path).then(() => false, () => true)
      out.coverGone = await stat(cover).then(() => false, () => true)
      `,
      { RETAIN_DAYS: '7' }
    )
    expect(out.hiddenImmediately).toBe(0)
    expect(out.purged).toBe(1)
    expect(out.fileGone).toBe(true)
    expect(out.coverGone).toBe(true)
  })

  it('clears an account, files and all', () => {
    const out = run(
      `
      const { stat } = await import('node:fs/promises')
      const kept = await library.keep({
        id: 'book-1', userId: user.id, retainMinutes: null,
        from: source, name: 'A Book.epub', source: 'send',
      })
      out.forgotten = await library.forgetUser(user.id)
      out.fileGone = await stat(kept.book.path).then(() => false, () => true)
      out.rows = repos.books.listForUser(user.id).length
      `,
      { RETAIN_DAYS: '7' }
    )
    expect(out.forgotten).toBe(1)
    expect(out.fileGone).toBe(true)
    expect(out.rows).toBe(0)
  })
})

describe('a directory this server did not create', () => {
  it('will not empty one that already holds someone else’s files', async () => {
    const theirs = mkdtempSync(join(dir, 'not-ours-'))
    writeFileSync(join(theirs, 'holiday-photo.jpg'), 'not a book')

    expect(await claimDirectory(theirs), 'unclaimed, so not ours to empty').toBe(false)
    expect(existsSync(join(theirs, 'holiday-photo.jpg')), 'still there').toBe(true)
  })

  it('claims an empty one and leaves its mark', async () => {
    const fresh = mkdtempSync(join(dir, 'fresh-'))

    expect(await claimDirectory(fresh)).toBe(true)
    expect(existsSync(join(fresh, MARKER))).toBe(true)
    expect(await claimDirectory(fresh), 'and knows it again next time').toBe(true)
  })

  it('sweeps nothing out of a directory it has not claimed', () => {
    const out = run(
      `
      const { rm, readdir } = await import('node:fs/promises')
      const { MARKER } = await import('./src/files.ts')

      await writeFile(join(process.env.LIBRARY_DIR, 'someone-elses.epub'), 'precious')
      await rm(join(process.env.LIBRARY_DIR, MARKER), { force: true })

      out.removed = await library.sweepOrphans()
      out.left = await readdir(process.env.LIBRARY_DIR)
    `
    )

    expect(out.removed, 'nothing swept').toBe(0)
    expect(out.left, 'the file that was never ours is untouched').toEqual(['someone-elses.epub'])
  })

  it('still sweeps a book the database has forgotten, once claimed', () => {
    const out = run(
      `
      const { readdir } = await import('node:fs/promises')
      await writeFile(join(process.env.LIBRARY_DIR, 'orphan.epub'), 'no row points here')

      out.removed = await library.sweepOrphans()
      out.left = await readdir(process.env.LIBRARY_DIR)
    `
    )

    expect(out.removed).toBe(1)
    expect(out.left, 'only the mark remains').toEqual(['.send2ereader'])
  })
})
