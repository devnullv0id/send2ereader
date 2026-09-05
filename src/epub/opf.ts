import { ZipFile } from './zip.js'

const MAX_XML = 4 * 1024 * 1024

export interface OpenedEpub {
  zip: ZipFile
  opf: string
  base: string
}

export async function openEpub(path: string): Promise<OpenedEpub | null> {
  let zip: ZipFile
  try {
    zip = await ZipFile.open(path)
  } catch {
    return null
  }

  try {
    const opfPath = await findOpf(zip)
    if (opfPath) {
      const opf = await readText(zip, opfPath)
      if (opf) return { zip, opf, base: dirname(opfPath) }
    }
  } catch {}

  await zip.close().catch(() => undefined)
  return null
}

async function findOpf(zip: ZipFile): Promise<string | null> {
  const container = await readText(zip, 'META-INF/container.xml')
  const declared = container?.match(/<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i)?.[1]
  if (declared && zip.has(decodeHref(declared))) return decodeHref(declared)

  return zip.names().find((name) => name.toLowerCase().endsWith('.opf')) ?? null
}

export async function readText(zip: ZipFile, name: string): Promise<string | null> {
  const data = await zip.read(name, MAX_XML)
  return data ? data.toString('utf8') : null
}

export function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1]
}

export function dirname(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

export function resolve(base: string, href: string): string {
  const parts = base ? base.split('/') : []
  for (const segment of decodeHref(href).split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}
