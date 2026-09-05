import { openEpub } from './opf.js'

export interface EpubMetadata {
  title: string | null
  authors: string[]
  language: string | null
  description: string | null
  publisher: string | null
}

const MAX_DESCRIPTION = 2000

export async function readEpubMetadata(path: string): Promise<EpubMetadata | null> {
  const book = await openEpub(path)
  if (!book) return null

  try {
    return fromOpf(book.opf)
  } catch {
    return null
  } finally {
    await book.zip.close().catch(() => undefined)
  }
}

export function fromOpf(opf: string): EpubMetadata {
  const scope = opf.match(/<metadata\b[^>]*>([\s\S]*?)<\/metadata\s*>/i)?.[1] ?? opf

  const description = first(scope, 'description')
  return {
    title: first(scope, 'title'),
    authors: all(scope, 'creator'),
    language: first(scope, 'language'),
    description: description ? stripTags(description).slice(0, MAX_DESCRIPTION) : null,
    publisher: first(scope, 'publisher'),
  }
}

function elements(scope: string, name: string): string[] {
  const pattern = new RegExp(`<(?:dc:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:dc:)?${name}\\s*>`, 'gi')
  return [...scope.matchAll(pattern)].map((match) => clean(match[1] ?? ''))
}

function first(scope: string, name: string): string | null {
  return elements(scope, name).find((value) => value.length > 0) ?? null
}

function all(scope: string, name: string): string[] {
  return elements(scope, name).filter((value) => value.length > 0)
}

function clean(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, ' ').trim()
}

function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}
