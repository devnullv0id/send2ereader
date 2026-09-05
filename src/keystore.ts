import { randomInt } from 'node:crypto'
import { keyChars } from './config.js'
import { safeUnlink } from './files.js'
import { settings } from './settings.js'
import type { DeviceKind, KeyInfo, StoredFile } from './types.js'

export interface Logger {
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

interface Entry {
  info: KeyInfo
  idleUntil: number
  idleTimer: NodeJS.Timeout
  hardTimer: NodeJS.Timeout
}

export class KeyOverflowError extends Error {
  constructor() {
    super('Unable to allocate a unique key: the key space is exhausted')
    this.name = 'KeyOverflowError'
  }
}

export function silentAfterSeconds(): number {
  return Math.min(3 * settings.int('EREADER_POLL_SECONDS'), settings.int('EXPIRE_SECONDS') / 2)
}

export class KeyStore {
  readonly #entries = new Map<string, Entry>()
  readonly #log: Logger

  constructor(log: Logger) {
    this.#log = log
  }

  get size(): number {
    return this.#entries.size
  }

  #randomKey(): string {
    let key = ''
    for (let i = 0; i < settings.int('KEY_LENGTH'); i++) key += keyChars[randomInt(keyChars.length)]
    return key
  }

  create(agent: string, device: DeviceKind): KeyInfo {
    const maxAttempts = Math.max(16, this.#entries.size * 2)
    let key: string | null = null
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidate = this.#randomKey()
      if (!this.#entries.has(candidate)) {
        key = candidate
        break
      }
    }
    if (!key) throw new KeyOverflowError()

    const now = new Date()
    const info: KeyInfo = {
      key,
      created: now,
      agent,
      device,
      alive: now,
      file: null,
      urls: [],
    }

    const granted = settings.int('EXPIRE_SECONDS') + silentAfterSeconds()
    const entry: Entry = {
      info,
      idleUntil: now.getTime() + granted * 1000,
      idleTimer: this.#schedule(key, granted, 'idle'),
      hardTimer: this.#schedule(key, settings.int('MAX_EXPIRE_SECONDS'), 'max-lifetime'),
    }
    this.#entries.set(key, entry)
    this.#log.info({ key, device, keys: this.#entries.size }, 'Generated key')
    return info
  }

  #schedule(key: string, seconds: number, reason: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.#log.info({ key, reason }, 'Key expired')
      void this.remove(key)
    }, seconds * 1000)
    timer.unref()
    return timer
  }

  get(key: string): KeyInfo | undefined {
    return this.#entries.get(key)?.info
  }

  renew(key: string): void {
    const entry = this.#entries.get(key)
    if (!entry) return
    this.#renewFor(key, entry, settings.int('EXPIRE_SECONDS'))
  }

  #renewFor(key: string, entry: Entry, seconds: number): void {
    clearTimeout(entry.idleTimer)
    entry.idleUntil = Date.now() + seconds * 1000
    entry.idleTimer = this.#schedule(key, seconds, 'idle')
  }

  expiresAt(key: string): number | null {
    const entry = this.#entries.get(key)
    if (!entry) return null
    const hardDeadline = entry.info.created.getTime() + settings.int('MAX_EXPIRE_SECONDS') * 1000
    return Math.min(entry.idleUntil, hardDeadline)
  }

  heard(key: string): void {
    const entry = this.#entries.get(key)
    if (!entry) return
    this.#renewFor(key, entry, settings.int('EXPIRE_SECONDS') + silentAfterSeconds())
    entry.info.alive = new Date()
  }

  async setFile(key: string, file: StoredFile): Promise<void> {
    const entry = this.#entries.get(key)
    if (!entry) {
      await safeUnlink(file.path)
      return
    }
    const previous = entry.info.file
    entry.info.file = file
    if (previous) await this.#deleteFile(key, previous)
  }

  async clearFile(key: string): Promise<void> {
    const entry = this.#entries.get(key)
    const file = entry?.info.file
    if (!entry || !file) return
    entry.info.file = null
    await this.#deleteFile(key, file)
  }

  async remove(key: string): Promise<void> {
    const entry = this.#entries.get(key)
    if (!entry) return
    clearTimeout(entry.idleTimer)
    clearTimeout(entry.hardTimer)
    this.#entries.delete(key)
    const file = entry.info.file
    entry.info.file = null
    if (file) await this.#deleteFile(key, file)
  }

  async clear(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((key) => this.remove(key)))
  }

  async #deleteFile(key: string, file: StoredFile): Promise<void> {
    try {
      await safeUnlink(file.path)
      this.#log.debug({ key, path: file.path }, 'Deleted file')
    } catch (err) {
      this.#log.error({ key, path: file.path, err }, 'Failed to delete file')
    }
  }
}
