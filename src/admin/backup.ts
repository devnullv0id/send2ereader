import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { createGzip } from 'node:zlib'
import { config } from '../config.js'
import type { Db } from '../db/index.js'

const BLOCK = 512

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

function header(name: string, size: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK)
  const path = name.split(sep).join('/')

  block.write(path.slice(0, 100), 0, 100, 'utf8')
  block.write(octal(0o644, 8), 100, 8, 'ascii')
  block.write(octal(0, 8), 108, 8, 'ascii')
  block.write(octal(0, 8), 116, 8, 'ascii')
  block.write(octal(size, 12), 124, 12, 'ascii')
  block.write(octal(Math.floor(mtime / 1000), 12), 136, 12, 'ascii')
  block.write('        ', 148, 8, 'ascii')
  block.write('0', 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')

  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${octal(sum, 7)} `, 148, 8, 'ascii')

  return block
}

export interface BackupEntry {
  name: string
  path: string
}

async function* archive(entries: BackupEntry[]): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(entry.path)
    } catch {
      continue
    }
    if (!info.isFile()) continue

    yield header(entry.name, info.size, info.mtimeMs)
    for await (const chunk of createReadStream(entry.path)) yield chunk as Buffer

    const overhang = info.size % BLOCK
    if (overhang > 0) yield Buffer.alloc(BLOCK - overhang)
  }
  yield Buffer.alloc(BLOCK * 2)
}

async function* walk(dir: string): AsyncGenerator<string> {
  const { readdir } = await import('node:fs/promises')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (!info) continue
    if (info.isDirectory()) yield* walk(path)
    else if (info.isFile()) yield path
  }
}

export interface Backup {
  stream: Readable
  filename: string
}

export async function makeBackup(db: Db, when: Date): Promise<Backup> {
  const staging = await mkdtemp(join(tmpdir(), 's2e-backup-'))
  const copy = join(staging, 'send2ereader.db')
  db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`)

  const entries: BackupEntry[] = [{ name: 'db/send2ereader.db', path: copy }]
  for await (const path of walk(config.library.dir)) {
    entries.push({ name: join('library', relative(config.library.dir, path)), path })
  }

  const stream = Readable.from(archive(entries)).pipe(createGzip())
  const done = () => {
    void rm(staging, { recursive: true, force: true })
  }
  stream.once('close', done)
  stream.once('error', done)

  const stamp = when.toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return { stream, filename: `send2ereader-${stamp}.tar.gz` }
}

export function backupContents(db: Db): { books: number; accounts: number; bytes: number } {
  const books = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM books')
    .get() as {
    n: number
    b: number
  }
  const accounts = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  return { books: books.n, accounts: accounts.n, bytes: books.b }
}
