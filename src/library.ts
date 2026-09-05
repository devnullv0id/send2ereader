import { randomUUID } from 'node:crypto'
import { copyFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { config } from './config.js'
import type { Book, Books } from './db/repositories.js'
import { readEpubCover } from './epub/cover.js'
import { readEpubMetadata } from './epub/metadata.js'
import { claimDirectory, MARKER, safeUnlink, UnclaimedDirectoryError } from './files.js'
import { settings } from './settings.js'

export interface LibraryLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export type RefusedReason = 'off' | 'user-full' | 'server-full'

export type KeepResult =
  | { kept: true; book: Book }
  | { kept: false; reason: RefusedReason; usedBytes: number; limitBytes: number }

export class Library {
  readonly #books: Books
  readonly #log: LibraryLogger

  constructor(books: Books, log: LibraryLogger) {
    this.#books = books
    this.#log = log
  }

  static async prepare(): Promise<void> {
    if (!(await claimDirectory(config.library.dir))) {
      throw new UnclaimedDirectoryError('LIBRARY_DIR', config.library.dir)
    }
  }

  static ceilingMinutes(): number {
    return settings.int('RETAIN_DAYS') * 24 * 60
  }

  retainMinutesFor(chosen: number | null): number {
    const ceiling = Library.ceilingMinutes()
    if (ceiling <= 0) return 0
    if (chosen === null) return ceiling
    return Math.max(0, Math.min(chosen, ceiling))
  }

  room(userId: string, size: number): { ok: true } | { ok: false; result: KeepResult } {
    const total = this.#books.bytesTotal()
    if (total + size > settings.int('STORAGE_TOTAL')) {
      return {
        ok: false,
        result: {
          kept: false,
          reason: 'server-full',
          usedBytes: total,
          limitBytes: settings.int('STORAGE_TOTAL'),
        },
      }
    }
    const mine = this.#books.bytesForUser(userId)
    if (mine + size > settings.int('STORAGE_PER_USER')) {
      return {
        ok: false,
        result: {
          kept: false,
          reason: 'user-full',
          usedBytes: mine,
          limitBytes: settings.int('STORAGE_PER_USER'),
        },
      }
    }
    return { ok: true }
  }

  async keep(input: {
    id: string
    userId: string
    retainMinutes: number | null
    from: string
    name: string
    source: 'send' | 'convert'
    deviceId?: string | null
  }): Promise<KeepResult> {
    const minutes = this.retainMinutesFor(input.retainMinutes)
    if (minutes <= 0) {
      return { kept: false, reason: 'off', usedBytes: 0, limitBytes: 0 }
    }

    let size: number
    try {
      size = (await stat(input.from)).size
    } catch (err) {
      this.#log.warn({ err, from: input.from }, 'Cannot measure a book to keep it')
      return { kept: false, reason: 'off', usedBytes: 0, limitBytes: 0 }
    }

    const space = this.room(input.userId, size)
    if (!space.ok) return space.result

    const extension = extname(input.name) || extname(input.from)
    const path = join(config.library.dir, `${input.id}${extension}`)

    try {
      await copyFile(input.from, path)
    } catch (err) {
      this.#log.error({ err, path }, 'Could not write a book into the library')
      return { kept: false, reason: 'off', usedBytes: 0, limitBytes: 0 }
    }

    const metadata = await readEpubMetadata(path)
    const cover = await this.#writeCover(input.id, path)

    const expires = new Date(Date.now() + minutes * 60 * 1000).toISOString()
    const book = this.#books.create({
      id: input.id,
      userId: input.userId,
      name: input.name,
      title: metadata?.title?.trim() || titleFromName(input.name),
      authors: metadata?.authors?.filter((a) => a.trim().length > 0) ?? [],
      format: (extension.replace('.', '') || 'bin').toLowerCase(),
      size,
      path,
      coverPath: cover?.path ?? null,
      coverType: cover?.contentType ?? null,
      source: input.source,
      deviceId: input.deviceId ?? null,
      expiresAt: expires,
    })

    this.#log.info({ bookId: book.id, userId: book.userId, minutes }, 'Kept a book')
    return { kept: true, book }
  }

  async #writeCover(
    id: string,
    path: string
  ): Promise<{ path: string; contentType: string } | null> {
    try {
      const cover = await readEpubCover(path)
      if (!cover) return null
      const coverPath = join(config.library.dir, `${id}.cover`)
      await writeFile(coverPath, cover.data)
      return { path: coverPath, contentType: cover.contentType }
    } catch (err) {
      this.#log.warn({ err, id }, 'Could not keep a cover')
      return null
    }
  }

  async removeFiles(book: Book): Promise<void> {
    await safeUnlink(book.path)
    if (book.coverPath) await safeUnlink(book.coverPath)
  }

  async forget(book: Book): Promise<void> {
    this.#books.remove(book.id)
    await this.removeFiles(book)
  }

  async purgeExpired(): Promise<number> {
    const gone = this.#books.takeExpired()
    for (const book of gone) await this.removeFiles(book)
    if (gone.length > 0) this.#log.info({ books: gone.length }, 'Purged expired books')
    return gone.length
  }

  async forgetUser(userId: string): Promise<number> {
    const gone = this.#books.takeAllForUser(userId)
    for (const book of gone) await this.removeFiles(book)
    return gone.length
  }

  async sweepOrphans(): Promise<number> {
    let entries: string[]
    try {
      entries = await readdir(config.library.dir)
    } catch {
      return 0
    }

    if (!entries.includes(MARKER)) {
      this.#log.error(
        { dir: config.library.dir },
        'The library directory is not marked as ours, so nothing was swept'
      )
      return 0
    }

    const claimed = new Set<string>()
    for (const book of this.#books.listAll()) {
      claimed.add(book.path)
      if (book.coverPath) claimed.add(book.coverPath)
    }

    let removed = 0
    for (const entry of entries) {
      if (entry === MARKER) continue
      const path = join(config.library.dir, entry)
      if (claimed.has(path)) continue
      await rm(path, { force: true }).catch(() => undefined)
      removed++
    }
    if (removed > 0) this.#log.warn({ files: removed }, 'Removed library files with no book')
    return removed
  }
}

export async function keepACopy(
  app: {
    hasDecorator(name: string): boolean
    library: Library
    log: LibraryLogger
  },
  user: { id: string; retainMinutes: number | null } | null,
  input: {
    from: string
    name: string
    source: 'send' | 'convert'
    id?: string
    deviceId?: string | null
  }
): Promise<KeepResult | null> {
  if (!user || !app.hasDecorator('library')) return null
  try {
    return await app.library.keep({
      id: input.id ?? randomUUID(),
      userId: user.id,
      retainMinutes: user.retainMinutes,
      from: input.from,
      name: input.name,
      source: input.source,
      deviceId: input.deviceId ?? null,
    })
  } catch (err) {
    app.log.error({ err, name: input.name }, 'Keeping a copy failed; the book still went out')
    return null
  }
}

export function publicKeep(result: KeepResult | null): Record<string, unknown> | null {
  if (!result) return null
  if (result.kept) {
    return { kept: true, id: result.book.id, expiresAt: result.book.expiresAt }
  }
  return {
    kept: false,
    reason: result.reason,
    usedBytes: result.usedBytes,
    limitBytes: result.limitBytes,
  }
}

function titleFromName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').replace(/\.kepub$/i, '')
  return stem.replace(/[_]+/g, ' ').trim() || name
}
