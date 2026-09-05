import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config, rootDir } from './config.js'

export interface LanguageInfo {
  code: string
  name: string
}

const CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/

const ENTITIES: [string, string][] = [
  ['&amp;', '&'],
  ['&#39;', "'"],
  ['&quot;', '"'],
  ['&minus;', '−'],
  ['&times;', '×'],
  ['&plus;', '+'],
]

function decode(text: string): string {
  let out = text
  for (const [entity, plain] of ENTITIES) out = out.replaceAll(entity, plain)
  return out
}

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeAttr(text: string): string {
  return escapeText(text).replaceAll('"', '&quot;')
}

function braces(text: string): string {
  return [...text.matchAll(/\{[\w]+\}/g)]
    .map((hit) => hit[0])
    .sort()
    .join(' ')
}

export function fillIn(text: string, params?: Record<string, string | number>): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    params[name] === undefined ? whole : String(params[name])
  )
}

const TRANSLATED_ATTRS = /(\s(?:placeholder|title|aria-label|alt|value)=")([^"]*)(")/g

interface Catalog {
  name: string
  strings: Map<string, string>
}

export class I18n {
  #catalogs = new Map<string, Catalog>()

  constructor(dirs: string[]) {
    for (const dir of dirs) this.#scan(dir)
  }

  #scan(dir: string): void {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }

    for (const file of names.filter((name) => name.endsWith('.json')).sort()) {
      const path = join(dir, file)
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        const code = String(parsed?._meta?.code ?? '').toLowerCase()
        const name = String(parsed?._meta?.name ?? '')
        const strings = parsed?.strings

        if (!CODE.test(code) || !name || typeof strings !== 'object' || strings === null) {
          console.warn(`i18n: ${path} is missing _meta.code, _meta.name or strings — skipped`)
          continue
        }
        if (code === 'en') {
          console.warn(`i18n: ${path} says it is English, which is built in — skipped`)
          continue
        }
        if (file !== `${code}.json`) {
          console.warn(`i18n: ${path} says its code is ${code} — the filename disagrees`)
        }

        const map = new Map<string, string>()
        for (const [key, value] of Object.entries(strings)) {
          if (typeof value !== 'string' || value === '') continue
          if (braces(key) !== braces(value)) {
            console.warn(`i18n: ${code} translates "${key}" with different placeholders`)
          }
          map.set(decode(key), value)
        }
        this.#catalogs.set(code, { name, strings: map })
      } catch {
        console.warn(`i18n: could not read ${path} — skipped`)
      }
    }
  }

  installed(): LanguageInfo[] {
    const rest = [...this.#catalogs.entries()]
      .map(([code, catalog]) => ({ code, name: catalog.name }))
      .sort((a, b) => a.code.localeCompare(b.code))
    return [{ code: 'en', name: 'English' }, ...rest]
  }

  isInstalled(code: string): boolean {
    return code === 'en' || this.#catalogs.has(code)
  }

  translate(lang: string, text: string, params?: Record<string, string | number>): string {
    const hit = this.#catalogs.get(lang)?.strings.get(text)
    return fillIn(hit ?? text, params)
  }

  translatePage(html: string, lang: string): string {
    const catalog = this.#catalogs.get(lang)
    if (!catalog) return html

    const pieces = html.split(/(<[^>]*>)/)
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i] ?? ''
      if (piece === '') continue

      if (piece.startsWith('<')) {
        if (piece.startsWith('<html')) {
          pieces[i] = piece.replace('lang="en"', `lang="${lang}"`)
          continue
        }
        pieces[i] = piece.replace(TRANSLATED_ATTRS, (whole, head, value, tail) => {
          const hit = catalog.strings.get(decode(value))
          return hit === undefined ? whole : `${head}${escapeAttr(hit)}${tail}`
        })
        continue
      }

      const core = piece.trim()
      if (core === '') continue
      const hit = catalog.strings.get(decode(core))
      if (hit === undefined) continue
      const start = piece.indexOf(core)
      pieces[i] = piece.slice(0, start) + escapeText(hit) + piece.slice(start + core.length)
    }
    return pieces.join('')
  }

  dictionary(lang: string): {
    language: string
    languages: LanguageInfo[]
    strings: Record<string, string>
  } {
    const catalog = this.#catalogs.get(lang)
    return {
      language: catalog ? lang : 'en',
      languages: this.installed(),
      strings: catalog ? Object.fromEntries(catalog.strings) : {},
    }
  }
}

function dataLanguagesDir(): string {
  const dir = join(config.dataDir, 'languages')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
  return dir
}

// Scanned synchronously at module load, so the LANGUAGE setting's choices exist before settings.ts evaluates.
export const i18n = new I18n([join(rootDir, 'languages'), dataLanguagesDir()])
