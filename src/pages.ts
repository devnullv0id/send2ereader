import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { i18n } from './i18n.js'

const REFERENCE = /(href|src)="((?:\.\/|\/)[\w./-]+\.(?:css|js))(?:\?v=[\w.-]*)?"/g

const STAMP_LENGTH = 10

export class Pages {
  private readonly rendered = new Map<string, string>()
  private readonly stamps = new Map<string, string>()

  constructor(
    private readonly dir: string,
    private readonly cache = true
  ) {}

  private stamp(asset: string): string {
    const known = this.stamps.get(asset)
    if (known && this.cache) return known

    let digest = 'missing'
    try {
      const bytes = readFileSync(join(this.dir, asset.replace(/^(?:\.\/|\/)/, '')))
      digest = createHash('sha256').update(bytes).digest('hex').slice(0, STAMP_LENGTH)
    } catch {}
    this.stamps.set(asset, digest)
    return digest
  }

  html(name: string, lang = 'en'): string | null {
    const key = `${lang}|${name}`
    const held = this.rendered.get(key)
    if (held !== undefined && this.cache) return held

    let source: string
    try {
      source = readFileSync(join(this.dir, name), 'utf8')
    } catch {
      return null
    }

    const stamped = source.replace(REFERENCE, (whole, attr: string, asset: string) => {
      const digest = this.stamp(asset)
      return digest === 'missing' ? whole : `${attr}="${asset}?v=${digest}"`
    })

    const out = i18n.translatePage(stamped, lang)
    this.rendered.set(key, out)
    return out
  }

  forget(): void {
    this.rendered.clear()
    this.stamps.clear()
  }
}
