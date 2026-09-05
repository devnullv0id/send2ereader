import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileTypeFromFile } from 'file-type'
import sanitize from 'sanitize-filename'
import { transliterate } from 'transliteration'
import { config } from './config.js'
import type { EbookFormat } from './types.js'

export const acceptedExtensions = [
  '.epub',
  '.pdf',
  '.mobi',
  '.azw3',
  '.kfx',
  '.kfx-zip',
  '.kepub.epub',
  '.cbz',
  '.cbr',
  '.txt',
  '.htmlz',
] as const

const contentTypes: Record<EbookFormat, string> = {
  epub: 'application/epub+zip',
  kepub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  kfx: 'application/vnd.amazon.ebook',
  kfxZip: 'application/zip',
  pdf: 'application/pdf',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htmlz: 'application/zip',
}

export const fileExtensions: Record<EbookFormat, string> = {
  epub: '.epub',
  kepub: '.kepub.epub',
  mobi: '.mobi',
  azw3: '.azw3',
  kfx: '.kfx',
  kfxZip: '.kfx-zip',
  pdf: '.pdf',
  cbz: '.cbz',
  cbr: '.cbr',
  txt: '.txt',
  html: '.html',
  htmlz: '.htmlz',
}

export function contentTypeFor(format: EbookFormat): string {
  return contentTypes[format]
}

const epubFamily = new Set<EbookFormat>(['epub', 'kepub'])

export function isEpubFamily(format: EbookFormat): boolean {
  return epubFamily.has(format)
}

const layoutFixFormats = new Set<EbookFormat>(['epub', 'kepub'])

export function supportsLayoutFix(format: EbookFormat): boolean {
  return layoutFixFormats.has(format)
}

export function formatFromName(filename: string): EbookFormat | null {
  const name = filename.toLowerCase()
  if (name.endsWith('.kepub.epub') || name.endsWith('.kepub')) return 'kepub'
  switch (extname(name)) {
    case '.epub':
      return 'epub'
    case '.mobi':
    case '.prc':
    case '.azw':
      return 'mobi'
    case '.azw3':
      return 'azw3'
    case '.kfx':
      return 'kfx'
    case '.kfx-zip':
      return 'kfxZip'
    case '.pdf':
      return 'pdf'
    case '.cbz':
      return 'cbz'
    case '.cbr':
      return 'cbr'
    case '.txt':
      return 'txt'
    case '.htmlz':
      return 'htmlz'
    default:
      return null
  }
}

const allowedSignatures: Record<EbookFormat, (string | null)[]> = {
  epub: ['application/epub+zip', 'application/zip'],
  kepub: ['application/epub+zip', 'application/zip'],
  mobi: ['application/x-mobipocket-ebook', 'application/vnd.amazon.mobi8-ebook'],
  azw3: ['application/x-mobipocket-ebook', 'application/vnd.amazon.mobi8-ebook'],
  kfx: [null],
  kfxZip: ['application/zip', 'application/epub+zip'],
  pdf: ['application/pdf'],
  cbz: ['application/zip', 'application/epub+zip'],
  cbr: ['application/vnd.rar', 'application/x-rar-compressed', 'application/zip'],
  txt: [null, 'text/plain'],
  html: [null, 'text/plain', 'text/html'],
  htmlz: ['application/zip'],
}

const magicPrefixes: Partial<Record<EbookFormat, Buffer[]>> = {
  kfx: [Buffer.from('CONT', 'ascii'), Buffer.from([0xe0, 0x01, 0x00, 0xea])],
}

async function hasMagicPrefix(path: string, prefixes: Buffer[]): Promise<boolean> {
  const longest = Math.max(...prefixes.map((p) => p.length))
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(longest)
    const { bytesRead } = await handle.read(buffer, 0, longest, 0)
    return prefixes.some((p) => bytesRead >= p.length && buffer.subarray(0, p.length).equals(p))
  } finally {
    await handle.close()
  }
}

export interface DetectedFormat {
  format: EbookFormat
  sniffedMime: string | null
}

export async function detectFormat(
  path: string,
  originalName: string
): Promise<DetectedFormat | null> {
  const claimed = formatFromName(originalName)
  if (!claimed) return null

  const sniffed = await fileTypeFromFile(path)
  const sniffedMime = sniffed?.mime ?? null
  if (!allowedSignatures[claimed].includes(sniffedMime)) return null

  const prefixes = magicPrefixes[claimed]
  if (prefixes && !(await hasMagicPrefix(path, prefixes))) return null

  return { format: claimed, sniffedMime }
}

const NAME_BYTES = 255

function keepTheExtension(wanted: string, cleaned: string): string {
  if (!wanted) return cleaned

  if (cleaned.toLowerCase() === wanted.toLowerCase()) return `book${wanted}`
  if (cleaned.toLowerCase().endsWith(wanted.toLowerCase())) return cleaned

  const room = NAME_BYTES - Buffer.byteLength(wanted, 'utf8')
  let stem = cleaned.replace(/\.+$/, '')
  while (Buffer.byteLength(stem, 'utf8') > room) stem = stem.slice(0, -1)

  return stem === '' || stem === '.' ? `book${wanted}` : `${stem}${wanted}`
}

// sanitize-filename can take the extension with it, and the extension is what everything downstream reads, so it survives. Longest match first: .epub would turn a .kepub.epub into a plain one.
export function decodeOriginalName(raw: string): string {
  const decoded = Buffer.from(raw, 'latin1').toString('utf8')
  const name = Buffer.from(decoded, 'utf8').toString('latin1') === raw ? decoded : raw

  const clean = sanitize(name).trim()
  const lowered = name.toLowerCase()

  const wanted =
    [...acceptedExtensions]
      .sort((a, b) => b.length - a.length)
      .find((ext) => lowered.endsWith(ext)) ?? ''
  return keepTheExtension(wanted, clean)
}

export function transliterateName(filename: string): string {
  const parts = filename.split('.')
  if (parts.length < 2) return sanitize(transliterate(filename))
  const ext = `.${parts.splice(-1).join('.')}`
  return sanitize(transliterate(parts.join('.')) + ext)
}

export function kindleSafeName(filename: string): string {
  return filename.replace(/[^.\w\-"'()]/g, '_')
}

export function withExtension(filename: string, format: EbookFormat): string {
  const stem = filename.replace(/\.kepub\.epub$/i, '').replace(/\.[^.]+$/, '')
  return (stem || 'ebook') + fileExtensions[format]
}

export function tempFilePath(extension: string): string {
  return join(
    config.uploadDir,
    `upload-${Date.now()}-${randomBytes(8).toString('hex')}${extension}`
  )
}

export async function safeUnlink(path: string | null | undefined): Promise<void> {
  if (!path) return
  try {
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

export const MARKER = '.send2ereader'

export async function claimDirectory(dir: string): Promise<boolean> {
  await mkdir(dir, { recursive: true })

  const entries = await readdir(dir)
  if (entries.includes(MARKER)) return true

  if (entries.length > 0) return false

  await writeFile(join(dir, MARKER), 'Files here are managed, and deleted, by send2ereader.\n')
  return true
}

export async function prepareUploadDir(clean: boolean): Promise<void> {
  const ours = await claimDirectory(config.uploadDir)
  if (!clean) return
  if (!ours) throw new UnclaimedDirectoryError('UPLOAD_DIR', config.uploadDir)

  const entries = await readdir(config.uploadDir)
  await Promise.all(
    entries
      .filter((entry) => entry !== MARKER)
      .map((entry) => rm(join(config.uploadDir, entry), { recursive: true, force: true }))
  )
}

export class UnclaimedDirectoryError extends Error {
  constructor(key: string, dir: string) {
    super(
      `${key} points at ${dir}, which already holds files this server did not put there. ` +
        `Point it somewhere of its own, or add a ${MARKER} file if it really is ours.`
    )
    this.name = 'UnclaimedDirectoryError'
  }
}
