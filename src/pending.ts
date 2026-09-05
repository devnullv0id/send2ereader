import { randomUUID } from 'node:crypto'
import { safeUnlink } from './files.js'
import type { EbookFormat } from './types.js'

export interface QueuedBook {
  bookId: string
  deviceId: string
  userId: string
  title?: string | null
  authors?: string[] | null
  language?: string | null
}

export interface PendingDelivery {
  owner: string
  path: string
  filename: string
  format: EbookFormat
  size: number
  applied: string[]
  queued?: QueuedBook
}

interface Held extends PendingDelivery {
  timer: NodeJS.Timeout
}

export class PendingDeliveries {
  readonly #held = new Map<string, Held>()
  readonly #ttlMs: number

  constructor(ttlSeconds = 300) {
    this.#ttlMs = ttlSeconds * 1000
  }

  hold(delivery: PendingDelivery): string {
    const token = randomUUID()
    const timer = setTimeout(() => {
      void this.discard(token)
    }, this.#ttlMs)
    timer.unref?.()
    this.#held.set(token, { ...delivery, timer })
    return token
  }

  claim(token: string, owner: string): PendingDelivery | null {
    const held = this.#held.get(token)
    if (!held || held.owner !== owner) return null
    clearTimeout(held.timer)
    this.#held.delete(token)
    return held
  }

  async discard(token: string): Promise<boolean> {
    const held = this.#held.get(token)
    if (!held) return false
    clearTimeout(held.timer)
    this.#held.delete(token)
    await safeUnlink(held.path)
    return true
  }

  get size(): number {
    return this.#held.size
  }

  async clear(): Promise<void> {
    const tokens = [...this.#held.keys()]
    await Promise.all(tokens.map((token) => this.discard(token)))
  }
}
