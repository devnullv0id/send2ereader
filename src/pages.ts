import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Every local stylesheet and script referenced by a page gets ?v=<hash of that
// file>. Nobody bumps a number by hand, and nothing can go out stale: the query
// changes exactly when the bytes do.
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
    } catch {
      // A page may reference something that is not there in a stripped image.
      // Serving the reference unstamped is better than serving no page.
    }
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
