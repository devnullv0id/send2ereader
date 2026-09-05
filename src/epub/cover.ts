import { attribute, dirname, openEpub, readText, resolve } from './opf.js'
import type { ZipFile } from './zip.js'

const MAX_IMAGE = 24 * 1024 * 1024

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif',
  'image/tiff',
])

const EXTENSION_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

export interface EpubCover {
  data: Buffer
  contentType: string
  entry: string
}

interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string
}

export async function readEpubCover(path: string): Promise<EpubCover | null> {
  const book = await openEpub(path)
  if (!book) return null

  try {
    const items = manifestItems(book.opf)
    const entry = await locateCover(book.zip, book.opf, items, book.base)
    if (!entry) return null

    const data = await book.zip.read(entry.name, MAX_IMAGE)
    if (!data || data.length === 0) return null
    return { data, contentType: entry.mediaType, entry: entry.name }
  } catch {
    return null
  } finally {
    await book.zip.close().catch(() => undefined)
  }
}

function manifestItems(opf: string): ManifestItem[] {
  const items: ManifestItem[] = []
  for (const tag of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const href = attribute(tag, 'href')
    if (!href) continue
    items.push({
      id: attribute(tag, 'id') ?? '',
      href,
      mediaType: attribute(tag, 'media-type') ?? '',
      properties: attribute(tag, 'properties') ?? '',
    })
  }
  return items
}

interface Located {
  name: string
  mediaType: string
}

async function locateCover(
  zip: ZipFile,
  opf: string,
  items: ManifestItem[],
  base: string
): Promise<Located | null> {
  const image = (item: ManifestItem | undefined): Located | null => {
    if (!item) return null
    const name = resolve(base, item.href)
    if (!zip.has(name)) return null
    const mediaType = IMAGE_TYPES.has(item.mediaType.toLowerCase())
      ? item.mediaType.toLowerCase()
      : typeFromName(name)
    return mediaType ? { name, mediaType } : null
  }

  // Two open-ended [^>]* runs in one pattern make the scan quadratic over a
  // 4MB OPF. A tag is short; bounding the runs costs nothing real.
  const metaId = opf.match(
    /<meta\b[^>]{0,500}\bname\s*=\s*["']cover["'][^>]{0,500}\bcontent\s*=\s*["']([^"']+)["']/i
  )?.[1]
  const byMeta = image(items.find((item) => item.id === metaId))
  if (byMeta) return byMeta

  const byProperties = image(items.find((item) => /\bcover-image\b/.test(item.properties)))
  if (byProperties) return byProperties

  const guideHref = opf.match(
    /<reference\b[^>]{0,500}\btype\s*=\s*["']cover["'][^>]{0,500}\bhref\s*=\s*["']([^"']+)["']/i
  )?.[1]
  if (guideHref) {
    const target = resolve(base, guideHref.split('#')[0] ?? guideHref)
    const item = items.find((candidate) => resolve(base, candidate.href) === target)
    const direct = image(item)
    if (direct) return direct

    const embedded = await imageInPage(zip, target)
    if (embedded) return embedded
  }

  return image(
    items.find(
      (item) =>
        IMAGE_TYPES.has(item.mediaType.toLowerCase()) &&
        /cover/i.test(`${item.id} ${item.href}`) &&
        !/back/i.test(item.href)
    )
  )
}

async function imageInPage(zip: ZipFile, pagePath: string): Promise<Located | null> {
  const page = await readText(zip, pagePath)
  if (!page) return null

  const href =
    page.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ??
    page.match(/<image\b[^>]*\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/i)?.[1]
  if (!href) return null

  const name = resolve(dirname(pagePath), href)
  if (!zip.has(name)) return null
  const mediaType = typeFromName(name)
  return mediaType ? { name, mediaType } : null
}

function typeFromName(name: string): string {
  const extension = name.toLowerCase().split('.').pop() ?? ''
  return EXTENSION_TYPES[extension] ?? ''
}
