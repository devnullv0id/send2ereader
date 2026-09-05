import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { config } from '../src/config.js'

const read = (name: string) => readFile(join(config.staticDir, name), 'utf8')

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('the vendored assets', () => {
  it('ships the fonts the design is set in', async () => {
    const files = await readdir(join(config.staticDir, 'fonts'))
    const woff2 = files.filter((f) => f.endsWith('.woff2'))

    expect(woff2.length).toBeGreaterThan(0)
    for (const family of ['instrument-serif', 'public-sans', 'space-mono']) {
      expect(
        woff2.some((f) => f.startsWith(family)),
        family
      ).toBe(true)
    }
  })

  it('ships the icon font the design draws with', async () => {
    const files = await readdir(join(config.staticDir, 'fonts'))

    expect(files, 'woff2').toContain('phosphor-regular.woff2')
    expect(files, 'licence').toContain('phosphor-LICENSE')

    const css = await read('fonts/phosphor.css')
    expect(css).toContain("url('/fonts/phosphor-regular.woff2')")
  })

  it('names only fonts it actually ships', async () => {
    const css = await read('fonts/fonts.css')
    const present = new Set(await readdir(join(config.staticDir, 'fonts')))

    const named = [...css.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1] as string)
    expect(named.length).toBeGreaterThan(0)
    for (const file of named) expect(present.has(file), file).toBe(true)
  })

  it('declares exactly the glyphs the pages use', async () => {
    const css = await read('fonts/phosphor.css')
    const names = await readdir(config.staticDir)
    const sources = [
      ...names.filter((f) => f.endsWith('.html')),
      ...names.filter((f) => f.endsWith('.js')),
    ]

    const used = new Set<string>()
    for (const file of sources) {
      const source = await read(file)
      for (const m of source.matchAll(/\bph ph-([a-z0-9-]+)/g)) used.add(m[1] as string)
      for (const m of source.matchAll(/\bicon\(\s*'([a-z0-9-]+)'/g)) used.add(m[1] as string)
    }

    const declared = new Set(
      [...css.matchAll(/\.ph\.ph-([a-z0-9-]+)::before/g)].map((m) => m[1] as string)
    )

    expect(used.size).toBeGreaterThan(0)
    expect([...used].sort(), 'declared and used must match exactly').toEqual([...declared].sort())
  })
})

describe('nothing reaches the internet at runtime', () => {
  it('has no external url() in any stylesheet', async () => {
    const root = await readdir(config.staticDir)
    const fonts = await readdir(join(config.staticDir, 'fonts'))
    const sheets = [
      ...root.filter((f) => f.endsWith('.css')),
      ...fonts.filter((f) => f.endsWith('.css')).map((f) => `fonts/${f}`),
    ]
    expect(sheets.length).toBeGreaterThan(3)

    for (const sheet of sheets) {
      const css = await read(sheet)
      const external = [...css.matchAll(/url\(\s*['"]?(https?:)?\/\//g)]
      expect(
        external.map((m) => m[0]),
        sheet
      ).toEqual([])
    }
  })

  it('loads no script or stylesheet from another host', async () => {
    for (const page of (await readdir(config.staticDir)).filter((f) => f.endsWith('.html'))) {
      const html = await read(page)
      const tags = [...html.matchAll(/<(?:script|link)\b[^>]*>/g)].map((m) => m[0])
      const remote = tags.filter((tag) => /(?:src|href)\s*=\s*['"](?:https?:)?\/\//.test(tag))
      expect(remote, page).toEqual([])
    }
  })

  it('makes no cross-origin request from the shell', async () => {
    const shell = await read('shell.js')
    const fetches = [...shell.matchAll(/fetch\(\s*['"`](https?:)?\/\//g)]
    expect(fetches.map((m) => m[0])).toEqual([])
  })
})

describe('the eReader page stays e-ink safe', () => {
  it('does not load the new design system', async () => {
    const html = await read('download.html')
    for (const asset of [
      'app.css',
      'screens.css',
      'send.css',
      'shell.js',
      'fonts/fonts.css',
      'fonts/phosphor.css',
    ]) {
      expect(html, asset).not.toContain(asset)
    }
  })

  it('keeps its stylesheet free of modern CSS', async () => {
    const css = code(await read('style.css'))
    for (const banned of [/--[a-z]/, /display:\s*flex/, /display:\s*grid/, /clamp\(/, /calc\(/]) {
      expect(banned.test(css), String(banned)).toBe(false)
    }
  })

  it('keeps its script free of modern JavaScript', async () => {
    const js = code(await read('common.js'))
    for (const banned of [/\bconst\b/, /\blet\b/, /=>/, /\bfetch\(/, /\bPromise\b/]) {
      expect(banned.test(js), String(banned)).toBe(false)
    }
  })
})
