import { type FileHandle, open } from 'node:fs/promises'
import { promisify } from 'node:util'
import { inflateRaw as inflateRawCb } from 'node:zlib'

const inflateRaw = promisify(inflateRawCb)

const EOCD_SIGNATURE = 0x0605_4b50
const CENTRAL_SIGNATURE = 0x0201_4b50
const LOCAL_SIGNATURE = 0x0403_4b50

const MAX_EOCD_SCAN = 0xffff + 22

interface Entry {
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export class ZipFile {
  readonly #handle: FileHandle
  readonly #entries: Map<string, Entry>
  readonly #size: number

  private constructor(handle: FileHandle, entries: Map<string, Entry>, size: number) {
    this.#handle = handle
    this.#entries = entries
    this.#size = size
  }

  static async open(path: string): Promise<ZipFile> {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      return new ZipFile(handle, await readCentralDirectory(handle, size), size)
    } catch (err) {
      await handle.close()
      throw err
    }
  }

  async close(): Promise<void> {
    await this.#handle.close()
  }

  has(name: string): boolean {
    return this.#entries.has(name)
  }

  names(): string[] {
    return [...this.#entries.keys()]
  }

  async read(name: string, maxSize: number): Promise<Buffer | null> {
    const entry = this.#entries.get(name)
    if (!entry) return null
    if (entry.uncompressedSize > maxSize) return null

    const header = await readAt(this.#handle, entry.localHeaderOffset, 30, this.#size)
    if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) return null
    const dataOffset =
      entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)

    const raw = await readAt(this.#handle, dataOffset, entry.compressedSize, this.#size)
    if (raw.length < entry.compressedSize) return null

    if (entry.method === 0) return raw
    if (entry.method !== 8) return null
    try {
      return await inflateRaw(raw, { maxOutputLength: maxSize })
    } catch {
      return null
    }
  }
}

async function readAt(
  handle: FileHandle,
  position: number,
  length: number,
  size: number
): Promise<Buffer> {
  if (length <= 0 || position < 0 || position >= size) return Buffer.alloc(0)

  const room = Math.min(length, size - position)
  const buffer = Buffer.alloc(room)
  const { bytesRead } = await handle.read(buffer, 0, room, position)
  return buffer.subarray(0, bytesRead)
}

async function readCentralDirectory(handle: FileHandle, size: number): Promise<Map<string, Entry>> {
  const scan = Math.min(size, MAX_EOCD_SCAN)
  const tail = await readAt(handle, size - scan, scan, size)

  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file: no end-of-central-directory record')

  const count = tail.readUInt16LE(eocd + 10)
  const directorySize = tail.readUInt32LE(eocd + 12)
  const directoryOffset = tail.readUInt32LE(eocd + 16)
  if (directoryOffset === 0xffff_ffff) throw new Error('zip64 archives are not supported')

  const directory = await readAt(handle, directoryOffset, directorySize, size)
  const entries = new Map<string, Entry>()

  let pos = 0
  for (let i = 0; i < count; i++) {
    if (pos + 46 > directory.length) break
    if (directory.readUInt32LE(pos) !== CENTRAL_SIGNATURE) break

    const nameLength = directory.readUInt16LE(pos + 28)
    const extraLength = directory.readUInt16LE(pos + 30)
    const commentLength = directory.readUInt16LE(pos + 32)
    const name = directory.subarray(pos + 46, pos + 46 + nameLength).toString('utf8')

    entries.set(name, {
      method: directory.readUInt16LE(pos + 10),
      compressedSize: directory.readUInt32LE(pos + 20),
      uncompressedSize: directory.readUInt32LE(pos + 24),
      localHeaderOffset: directory.readUInt32LE(pos + 42),
    })

    pos += 46 + nameLength + extraLength + commentLength
  }

  return entries
}
