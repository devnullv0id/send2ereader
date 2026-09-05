import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { prepareUploadDir } from '../src/files.js'
import { KeyStore, type Logger, silentAfterSeconds } from '../src/keystore.js'
import type { StoredFile } from '../src/types.js'
import { contentsOf } from './helpers.js'

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} }

async function makeFile(store: KeyStore, key: string, name: string): Promise<StoredFile> {
  const path = join(config.uploadDir, name)
  await writeFile(path, 'x')
  const file: StoredFile = { name, path, format: 'epub', size: 1, uploaded: new Date() }
  await store.setFile(key, file)
  return file
}

const GRANTED_ON_CONTACT = config.expireSeconds + silentAfterSeconds()

let store: KeyStore

beforeEach(async () => {
  await prepareUploadDir(true)
  vi.useFakeTimers()
  store = new KeyStore(silent)
})

afterEach(async () => {
  vi.useRealTimers()
  await store.clear()
})

describe('prepareUploadDir', () => {
  it('clears leftovers without removing the directory itself', async () => {
    const fs = await import('node:fs/promises')
    await fs.writeFile(join(config.uploadDir, 'leftover.epub'), 'x')
    await fs.mkdir(join(config.uploadDir, 'nested'), { recursive: true })

    const before = await fs.stat(config.uploadDir)
    await prepareUploadDir(true)
    const after = await fs.stat(config.uploadDir)

    expect(await contentsOf(config.uploadDir)).toHaveLength(0)
    expect(after.ino).toBe(before.ino)
  })

  it('is idempotent and creates the directory when missing', async () => {
    const fs = await import('node:fs/promises')
    await fs.rm(config.uploadDir, { recursive: true, force: true })
    await prepareUploadDir(true)
    await prepareUploadDir(false)
    expect(await contentsOf(config.uploadDir)).toHaveLength(0)
  })
})

describe('KeyStore', () => {
  it('expires a key after the idle TTL', async () => {
    const info = store.create('agent', 'kobo')
    expect(store.get(info.key)).toBeDefined()

    await vi.advanceTimersByTimeAsync(GRANTED_ON_CONTACT * 1000 + 10)
    expect(store.get(info.key)).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('extends the idle TTL every time the ereader is heard from', async () => {
    const info = store.create('agent', 'kobo')

    const step = (config.expireSeconds * 1000) / 4
    const granted = (config.expireSeconds + silentAfterSeconds()) * 1000
    const rounds = Math.max(2, Math.floor((config.maxExpireSeconds * 1000 - granted) / step) - 1)

    for (let i = 0; i < rounds; i++) {
      await vi.advanceTimersByTimeAsync(step)
      store.heard(info.key)
    }
    expect(store.get(info.key)).toBeDefined()

    await vi.advanceTimersByTimeAsync(granted - 1000)
    expect(store.get(info.key), 'the allowance for noticing is part of it').toBeDefined()

    await vi.advanceTimersByTimeAsync(1000 + 10)
    expect(store.get(info.key)).toBeUndefined()
  })

  it('gives Extend the grace exactly, with no allowance for noticing', async () => {
    const info = store.create('agent', 'kobo')
    store.renew(info.key)

    await vi.advanceTimersByTimeAsync(config.expireSeconds * 1000 - 1000)
    expect(store.get(info.key)).toBeDefined()
    await vi.advanceTimersByTimeAsync(1000 + 10)
    expect(store.get(info.key)).toBeUndefined()
  })

  it('enforces the hard TTL no matter how often the key is renewed', async () => {
    const info = store.create('agent', 'kobo')
    const step = (config.expireSeconds * 1000) / 2

    for (let elapsed = 0; elapsed < config.maxExpireSeconds * 1000 + step; elapsed += step) {
      await vi.advanceTimersByTimeAsync(step)
      store.heard(info.key)
    }
    expect(store.get(info.key)).toBeUndefined()
  })

  it('renewing keeps the key without claiming the device spoke', async () => {
    const info = store.create('agent', 'kobo')
    const firstHeard = info.alive.getTime()

    await vi.advanceTimersByTimeAsync((config.expireSeconds * 1000) / 2)
    store.renew(info.key)
    await vi.advanceTimersByTimeAsync((config.expireSeconds * 1000) / 2)

    expect(store.get(info.key)).toBeDefined()
    expect(store.get(info.key)!.alive.getTime()).toBe(firstHeard)

    store.heard(info.key)
    expect(store.get(info.key)!.alive.getTime()).toBeGreaterThan(firstHeard)
  })

  it('deletes the attached file when the key expires', async () => {
    const info = store.create('agent', 'kobo')
    const file = await makeFile(store, info.key, 'expiring.epub')

    await vi.advanceTimersByTimeAsync(GRANTED_ON_CONTACT * 1000 + 10)
    await expect(import('node:fs/promises').then((fs) => fs.stat(file.path))).rejects.toThrow()
  })

  it('deletes the previous file when a new one replaces it', async () => {
    const info = store.create('agent', 'kobo')
    const first = await makeFile(store, info.key, 'first.epub')
    await makeFile(store, info.key, 'second.epub')

    const fs = await import('node:fs/promises')
    await expect(fs.stat(first.path)).rejects.toThrow()
    expect(store.get(info.key)?.file?.name).toBe('second.epub')
  })

  it('discards a file attached to an already-expired key', async () => {
    const info = store.create('agent', 'kobo')
    await vi.advanceTimersByTimeAsync(GRANTED_ON_CONTACT * 1000 + 10)

    const path = join(config.uploadDir, 'orphan.epub')
    await writeFile(path, 'x')
    await store.setFile(info.key, {
      name: 'orphan.epub',
      path,
      format: 'epub',
      size: 1,
      uploaded: new Date(),
    })

    const fs = await import('node:fs/promises')
    await expect(fs.stat(path)).rejects.toThrow()
  })

  it('clears every key and file at once', async () => {
    const a = store.create('agent', 'kobo')
    const b = store.create('agent', 'kindle')
    await makeFile(store, a.key, 'a.epub')
    await makeFile(store, b.key, 'b.epub')

    await store.clear()
    expect(store.size).toBe(0)
    const _fs = await import('node:fs/promises')
    expect(await contentsOf(config.uploadDir)).toHaveLength(0)
  })

  it('is a no-op when renewing or removing an unknown key', async () => {
    expect(() => store.renew('NOPE')).not.toThrow()
    expect(() => store.heard('NOPE')).not.toThrow()
    await expect(store.remove('NOPE')).resolves.toBeUndefined()
    await expect(store.clearFile('NOPE')).resolves.toBeUndefined()
  })
})
