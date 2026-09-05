import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REFERENCE = /(?:href|src)="(\/[\w./-]+\.(?:css|js))"/g

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
      const bytes = readFileSync(join(this.dir, asset.replace(/^\//, '')))
      digest = createHash('sha256').update(bytes).digest('hex').slice(0, STAMP_LENGTH)
    } catch {}
    this.stamps.set(asset, digest)
    return digest
  }

  html(name: string): string | null {
    const held = this.rendered.get(name)
    if (held !== undefined && this.cache) return held

    let source: string
    try {
      source = readFileSync(join(this.dir, name), 'utf8')
    } catch {
      return null
    }

    const out = source.replace(REFERENCE, (whole, asset: string) => {
      const digest = this.stamp(asset)
      return digest === 'missing' ? whole : whole.replace(asset, `${asset}?v=${digest}`)
    })

    this.rendered.set(name, out)
    return out
  }

  forget(): void {
    this.rendered.clear()
    this.stamps.clear()
  }
}
