import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

const ASIN_TAGS = new Set([113, 504])
const SOURCE_TAG = 112
const NEUTRAL_TAG = 0xffff

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isInventedIdentifier(tag: number, value: string): boolean {
  if (ASIN_TAGS.has(tag)) return UUID.test(value.trim())
  if (tag === SOURCE_TAG) return UUID.test(value.trim().replace(/^calibre:/, ''))
  return false
}

export function stripStoreIdentity(book: Buffer): boolean {
  if (book.length < 78 + 8) return false

  const records = book.readUInt16BE(76)
  if (records < 1) return false

  const start = book.readUInt32BE(78)
  const end = records > 1 ? book.readUInt32BE(86) : book.length
  if (start >= end || end > book.length) return false

  const header = book.subarray(start, end)
  const at = header.indexOf('EXTH')
  if (at < 0) return false

  const count = header.readUInt32BE(at + 8)
  let cursor = at + 12
  let changed = false

  for (let seen = 0; seen < count && cursor + 8 <= header.length; seen += 1) {
    const tag = header.readUInt32BE(cursor)
    const length = header.readUInt32BE(cursor + 4)
    if (length < 8 || cursor + length > header.length) break

    const value = header.subarray(cursor + 8, cursor + length)

    if (isInventedIdentifier(tag, value.toString('latin1'))) {
      header.writeUInt32BE(NEUTRAL_TAG, cursor)
      value.fill(0)
      changed = true
    }

    cursor += length
  }

  return changed
}

export async function unbrandKindleFile(path: string): Promise<boolean> {
  const book = await readFile(path)
  if (!stripStoreIdentity(book)) return false

  const staging = `${path}.unbranding`
  try {
    await writeFile(staging, book)
    await rename(staging, path)
  } catch (err) {
    await unlink(staging).catch(() => undefined)
    throw err
  }
  return true
}
