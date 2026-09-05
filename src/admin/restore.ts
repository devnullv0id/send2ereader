import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { config } from '../config.js'
import { openDatabase } from '../db/index.js'

const BLOCK = 512
const CHUNK = 1024 * 1024

export interface RestoreRoots {
  dataDir: string
  dbPath: string
  libraryDir: string
}

// Roots arrive as an argument because wipe() empties them; a test reading config here would empty the real library.
function rootsOf(over?: Partial<RestoreRoots>): RestoreRoots {
  return {
    dataDir: over?.dataDir ?? config.dataDir,
    dbPath: over?.dbPath ?? config.db.path,
    libraryDir: over?.libraryDir ?? config.library.dir,
  }
}

export function restorePaths(over?: Partial<RestoreRoots>) {
  const dir = join(rootsOf(over).dataDir, 'restore')
  return {
    dir,
    archive: join(dir, 'pending.tar.gz'),
    request: join(dir, 'request'),
    name: join(dir, 'name'),
    stagedDb: join(dir, 'staged.db'),
  }
}

export interface StagedRestore {
  name: string
  size: number
  stagedAt: string
  requested: boolean
}

export interface RestoreOutcome {
  ok: boolean
  books: number
  error?: string
}

interface Entry {
  name: string
  size: number
}

class Bytes {
  #iter: AsyncIterator<Buffer>
  #held: Buffer = Buffer.alloc(0)

  constructor(source: AsyncIterable<Buffer>) {
    this.#iter = source[Symbol.asyncIterator]()
  }

  async take(want: number): Promise<Buffer | null> {
    while (this.#held.length < want) {
      const next = await this.#iter.next()
      if (next.done) break
      this.#held = Buffer.concat([this.#held, next.value])
    }
    if (this.#held.length < want) return null

    const out = this.#held.subarray(0, want)
    this.#held = this.#held.subarray(want)
    return out
  }
}

function entryOf(block: Buffer): Entry | null {
  if (block.every((byte) => byte === 0)) return null

  const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
  const size = Number.parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/, ''), 8)
  return { name, size: Number.isFinite(size) ? size : 0 }
}

// Archive members name themselves, so only the two prefixes a backup writes are taken, and only under their own root.
function targetFor(name: string, roots: RestoreRoots): string | null {
  const parts = name.split('/').filter(Boolean)
  if (parts.some((part) => part === '..' || part === '.')) return null

  if (parts.length === 2 && parts[0] === 'db' && parts[1] === 'send2ereader.db') {
    return roots.dbPath
  }
  if (parts.length >= 2 && parts[0] === 'library') {
    const root = resolve(roots.libraryDir)
    const path = resolve(join(root, ...parts.slice(1)))
    return path === root || path.startsWith(root + sep) ? path : null
  }
  return null
}

type Wanted = 'db' | 'library'

async function walkArchive(
  archive: string,
  wanted: Wanted,
  roots: RestoreRoots,
  into: (target: string, entry: Entry, read: (n: number) => Promise<Buffer | null>) => Promise<void>
): Promise<number> {
  const bytes = new Bytes(createReadStream(archive).pipe(createGunzip()))
  const prefix = wanted === 'db' ? 'db/' : 'library/'
  let taken = 0

  for (;;) {
    const head = await bytes.take(BLOCK)
    if (!head) break

    const entry = entryOf(head)
    if (!entry) break

    const target = targetFor(entry.name, roots)
    const padding = entry.size % BLOCK === 0 ? 0 : BLOCK - (entry.size % BLOCK)

    if (!target || !entry.name.startsWith(prefix)) {
      let left = entry.size + padding
      while (left > 0) {
        const skipped = await bytes.take(Math.min(left, CHUNK))
        if (!skipped) return taken
        left -= skipped.length
      }
      continue
    }

    await into(target, entry, (n) => bytes.take(n))
    if (padding > 0) await bytes.take(padding)
    taken++
  }

  return taken
}

async function writeEntry(
  target: string,
  entry: Entry,
  read: (n: number) => Promise<Buffer | null>
): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  let left = entry.size

  await pipeline(async function* () {
    while (left > 0) {
      const chunk = await read(Math.min(left, CHUNK))
      if (!chunk || chunk.length === 0) return
      left -= chunk.length
      yield chunk
    }
  }, createWriteStream(target))
}

export async function stage(
  name: string,
  from: string,
  over?: Partial<RestoreRoots>
): Promise<StagedRestore> {
  const paths = restorePaths(over)
  await mkdir(paths.dir, { recursive: true })
  await rm(paths.request, { force: true })

  await rename(from, paths.archive).catch(async () => {
    await pipeline(createReadStream(from), createWriteStream(paths.archive))
    await unlink(from).catch(() => undefined)
  })
  await writeFile(paths.name, basename(name), 'utf8')

  return (await staged(over))!
}

export async function staged(over?: Partial<RestoreRoots>): Promise<StagedRestore | null> {
  const paths = restorePaths(over)

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(paths.archive)
  } catch {
    return null
  }

  const given = await readFile(paths.name, 'utf8').catch(() => '')
  return {
    name: given.trim() || 'send2ereader-backup.tar.gz',
    size: info.size,
    stagedAt: new Date(info.mtimeMs).toISOString(),
    requested: existsSync(paths.request),
  }
}

export async function discard(over?: Partial<RestoreRoots>): Promise<void> {
  await rm(restorePaths(over).dir, { recursive: true, force: true })
}

export async function request(byUserId: string, over?: Partial<RestoreRoots>): Promise<void> {
  const paths = restorePaths(over)
  await mkdir(paths.dir, { recursive: true })
  await writeFile(paths.request, `${new Date().toISOString()} ${byUserId}\n`, 'utf8')
}

// The session key beside the database is never in an archive and stays; deleting it would make restored secrets unreadable.
async function wipe(roots: RestoreRoots): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(`${roots.dbPath}${suffix}`, { force: true })
  }

  const names = await readdir(roots.libraryDir).catch(() => null)
  if (!names) return

  for (const name of names) {
    if (name === '.send2ereader') continue
    await rm(join(roots.libraryDir, name), { recursive: true, force: true })
  }
}

function bookCount(path: string): number {
  const db = openDatabase(path)
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

export interface RestoreLog {
  info: (fields: object, message: string) => void
  error: (fields: object, message: string) => void
}

// Runs before anything opens the database, so there is nothing to race.
export async function applyPendingRestore(
  log: RestoreLog,
  over?: Partial<RestoreRoots>
): Promise<RestoreOutcome | null> {
  const roots = rootsOf(over)
  const paths = restorePaths(over)
  if (!existsSync(paths.request) || !existsSync(paths.archive)) return null

  log.info({ scope: 'server', archive: paths.archive }, 'a restore is waiting — unpacking it')

  try {
    await rm(paths.stagedDb, { force: true })
    const found = await walkArchive(paths.archive, 'db', roots, async (_target, entry, read) => {
      await writeEntry(paths.stagedDb, entry, read)
    })
    if (found === 0) throw new Error('the archive holds no database')

    const books = bookCount(paths.stagedDb)

    await wipe(roots)
    await mkdir(dirname(roots.dbPath), { recursive: true })
    await rename(paths.stagedDb, roots.dbPath)

    const files = await walkArchive(paths.archive, 'library', roots, writeEntry)
    await discard(over)

    log.info({ scope: 'server', books, files }, 'restore finished; the archive has been removed')
    return { ok: true, books }
  } catch (err) {
    const error = (err as Error).message
    log.error({ scope: 'server', err }, 'the restore failed; the archive has been kept')
    await rm(paths.request, { force: true })
    return { ok: false, books: 0, error }
  }
}
