import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.js'
import { claimDirectory, MARKER, safeUnlink, UnclaimedDirectoryError } from '../files.js'
import { settings } from '../settings.js'
import type { EbookFormat } from '../types.js'

export interface QueuedBook {
  id: string
  deviceId: string
  name: string
  title: string
  authors: string[]
  language: string | null
  path: string
  format: EbookFormat
  size: number
  queuedAt: Date
}

export interface BookDetails {
  title?: string | null
  authors?: string[]
  language?: string | null
}

export interface QueueLogger {
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

interface Entry {
  book: QueuedBook
  timer: NodeJS.Timeout
}

export function titleFromName(name: string): string {
  const stem = name
    .replace(/\.kepub\.epub$/i, '')
    .replace(/\.kfx-zip$/i, '')
    .replace(/\.[^.]+$/, '')
  return stem.replace(/[_]+/g, ' ').trim() || name
}

export class DeliveryQueue {
  readonly #entries = new Map<string, Entry>()
  readonly #log: QueueLogger

  constructor(log: QueueLogger) {
    this.#log = log
  }

  get size(): number {
    return this.#entries.size
  }

  static async prepare(): Promise<void> {
    if (!(await claimDirectory(config.kobo.queueDir))) {
      throw new UnclaimedDirectoryError('KOBO_QUEUE_DIR', config.kobo.queueDir)
    }

    const entries = await readdir(config.kobo.queueDir)
    await Promise.all(
      entries
        .filter((entry) => entry !== MARKER)
        .map((entry) => rm(join(config.kobo.queueDir, entry), { recursive: true, force: true }))
    )
  }

  pathFor(id: string, extension: string): string {
    return join(config.kobo.queueDir, `${id}${extension}`)
  }

  add(
    book: Omit<QueuedBook, 'id' | 'queuedAt' | 'title' | 'authors' | 'language'> & { id: string },
    details: BookDetails = {}
  ): QueuedBook {
    const queued: QueuedBook = {
      ...book,
      title: details.title?.trim() || titleFromName(book.name),
      authors: details.authors?.filter((name) => name.trim().length > 0) ?? [],
      language: details.language?.trim() || null,
      queuedAt: new Date(),
    }

    const timer = setTimeout(() => {
      this.#log.info({ bookId: queued.id, deviceId: queued.deviceId }, 'Queued book expired')
      void this.remove(queued.id)
    }, settings.int('KOBO_QUEUE_TTL') * 1000)
    timer.unref()

    this.#entries.set(queued.id, { book: queued, timer })
    this.#log.info(
      { bookId: queued.id, deviceId: queued.deviceId, name: queued.name },
      'Queued book for device'
    )
    return queued
  }

  listFor(deviceId: string): QueuedBook[] {
    return [...this.#entries.values()]
      .map((entry) => entry.book)
      .filter((book) => book.deviceId === deviceId)
      .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())
  }

  get(id: string, deviceId: string): QueuedBook | null {
    const book = this.#entries.get(id)?.book
    return book && book.deviceId === deviceId ? book : null
  }

  async delivered(id: string): Promise<void> {
    const entry = this.#entries.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.#entries.delete(id)
    await this.#deleteFile(entry.book)
    this.#log.info({ bookId: id }, 'Delivered and removed queued book')
  }

  async remove(id: string): Promise<void> {
    const entry = this.#entries.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.#entries.delete(id)
    await this.#deleteFile(entry.book)
  }

  async removeForDevice(deviceId: string): Promise<void> {
    await Promise.all(this.listFor(deviceId).map((book) => this.remove(book.id)))
  }

  async clear(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((id) => this.remove(id)))
  }

  async #deleteFile(book: QueuedBook): Promise<void> {
    try {
      await safeUnlink(book.path)
      this.#log.debug({ path: book.path }, 'Deleted queued file')
    } catch (err) {
      this.#log.error({ path: book.path, err }, 'Failed to delete queued file')
    }
  }
}

export const newBookId = (): string => randomUUID()
