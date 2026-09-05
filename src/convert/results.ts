import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { safeUnlink } from '../files.js'
import { settings } from '../settings.js'
import type { EbookFormat } from '../types.js'

export interface ConvertedFile {
  id: string
  name: string
  path: string
  format: EbookFormat
  size: number
  owner: string | null
}

export interface ResultLogger {
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

interface Entry {
  file: ConvertedFile
  timer: NodeJS.Timeout
}

export class ConversionResults {
  readonly #entries = new Map<string, Entry>()
  readonly #log: ResultLogger

  constructor(log: ResultLogger) {
    this.#log = log
  }

  get size(): number {
    return this.#entries.size
  }

  add(file: Omit<ConvertedFile, 'id'>, id: string = randomUUID()): ConvertedFile {
    const stored: ConvertedFile = { ...file, id }

    const timer = setTimeout(() => {
      this.#log.info({ id: stored.id }, 'Converted file expired before it was downloaded')
      void this.remove(stored.id)
    }, settings.int('CONVERT_TTL') * 1000)
    timer.unref()

    this.#entries.set(stored.id, { file: stored, timer })
    return stored
  }

  get(id: string, owner: string | null): ConvertedFile | null {
    const file = this.#entries.get(id)?.file
    if (!file) return null
    if (file.owner && file.owner !== owner) return null
    return file
  }

  async remove(id: string): Promise<void> {
    const entry = this.#entries.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.#entries.delete(id)
    try {
      await safeUnlink(entry.file.path)
    } catch (err) {
      this.#log.error({ path: entry.file.path, err }, 'Failed to delete a converted file')
    }
  }

  async clear(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((id) => this.remove(id)))
  }
}
