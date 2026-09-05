import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const staticDir = join(root, 'static')

const EXPECTED: Record<string, { key: string; why: string }[]> = {
  'signin.js': [
    {
      key: 'resetEmail',
      why: '/auth/reset does not say whose address the token belongs to',
    },
  ],
}

function scripts(): string[] {
  return readdirSync(staticDir).filter((f) => f.endsWith('.js'))
}

function declaredIn(source: string): string[] {
  const body = /const PLACEHOLDER = \{([\s\S]*?)\n {2}\}/.exec(source)?.[1]
  if (!body) return []
  return [...body.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1] as string)
}

describe('design content shipped ahead of its backend', () => {
  it('is declared in exactly the scripts that use it', () => {
    const found: Record<string, string[]> = {}
    for (const file of scripts()) {
      const keys = declaredIn(readFileSync(join(staticDir, file), 'utf8'))
      if (keys.length) found[file] = keys.sort()
    }

    const expected = Object.fromEntries(
      Object.entries(EXPECTED).map(([file, entries]) => [file, entries.map((e) => e.key).sort()])
    )
    expect(found).toEqual(expected)
  })

  it.each(Object.entries(EXPECTED))('%s says what each is standing in for', (file, entries) => {
    const source = readFileSync(join(staticDir, file), 'utf8')
    for (const entry of entries) {
      const before = source.slice(0, source.indexOf(`${entry.key}:`))
      const comment = before.slice(before.lastIndexOf('const PLACEHOLDER'))
      const doc = before.slice(Math.max(0, before.lastIndexOf('/**')))
      expect(
        (comment + doc).length,
        `${file} ${entry.key}: a placeholder with no note beside it is a bug waiting to be shipped`
      ).toBeGreaterThan(80)
    }
  })

  it('is never read outside the script that declares it', () => {
    for (const file of scripts()) {
      const source = readFileSync(join(staticDir, file), 'utf8')
      const uses = source.includes('PLACEHOLDER.')
      const declares = declaredIn(source).length > 0
      expect(uses && !declares, `${file} reads a PLACEHOLDER it does not declare`).toBe(false)
    }
  })
})
