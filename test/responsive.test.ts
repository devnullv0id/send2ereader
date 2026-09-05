import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { config } from '../src/config.js'

const staticDir = config.staticDir
const read = (name: string) => readFileSync(join(staticDir, name), 'utf8')

const app = read('app.css')
const screens = read('screens.css')
const shell = read('shell.js')
const sheets = `${app}\n${screens}\n${read('fonts/phosphor.css')}`.replace(/\/\*[\s\S]*?\*\//g, '')

describe('the card is sized by the viewport, not by a number', () => {
  it('never pins .step-card to a fixed height', () => {
    const rule = /\.step-card\s*\{([^}]*)\}/.exec(app)?.[1] ?? ''

    expect(rule, 'the rule is still there to check').toBeTruthy()
    expect(rule, 'a fixed height is what made the page scroll past the card').not.toMatch(
      /(^|[;\s])height:\s*(?!auto)/
    )
    expect(rule, 'it takes the space it is given').toMatch(/flex:\s*1/)
    expect(rule, '--card-floor is a ceiling now').toMatch(/max-height:\s*var\(--card-floor\)/)
    expect(rule, 'and it is what scrolls').toMatch(/overflow-y:\s*auto/)
  })

  it('locks the send and convert shells to the viewport so only the card scrolls', () => {
    expect(app).toMatch(/body\[data-page='send'\]\s*\.shell/)
    expect(app).toMatch(/body\[data-page='convert'\]\s*\.shell/)
    expect(app, 'dvh, so a collapsing address bar does not clip or gap').toMatch(/height:\s*100dvh/)
  })

  it('lets a landscape phone scroll the page instead of squeezing the card', () => {
    expect(app, 'orientation-scoped, so a 568px portrait phone keeps the locked layout').toMatch(
      /@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*600px\)/
    )
  })
})

describe('one set of breakpoints', () => {
  const widths = [...sheets.matchAll(/\(\s*(?:max|min)-width:\s*(\d+)px\s*\)/g)].map((m) => m[1])

  it('uses one width, everywhere', () => {
    expect(new Set(widths)).toEqual(new Set(['640']))
  })

  it('still has some, which is the whole point', () => {
    expect(widths.length).toBeGreaterThan(0)
  })

  it('sizes touch targets by pointer, not by width', () => {
    expect(sheets, 'a touch laptop is wide and still needs big targets').toMatch(
      /@media\s*\(pointer:\s*coarse\)/
    )
  })
})

describe('the drawer that replaces the header nav on a phone', () => {
  const used = new Set(
    [...shell.matchAll(/class="([^"$]*)"/g)]
      .flatMap((m) => (m[1] as string).split(/\s+/))
      .filter((name) => name && !name.includes('${'))
  )

  it('defines a rule for every class it renders', () => {
    const missing = [...used].filter(
      (name) =>
        !new RegExp(`\\.${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}[^\\w-]`).test(sheets)
    )
    expect(missing, 'shell.js builds its markup in strings, so nothing checks this for it').toEqual(
      []
    )
  })

  it('hides the pills and shows the toggle at the same breakpoint', () => {
    const phone = /@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/.exec(app)?.[1] ?? ''
    expect(phone).toMatch(/\.nav-pill,\s*\n?\s*\.account-btn\s*\{[^}]*display:\s*none/)
    expect(phone).toMatch(/\.nav-toggle\s*\{[^}]*display:\s*inline-flex/)
  })

  it('names the icon it draws, so the font ships the glyph', () => {
    expect(shell).toMatch(/icon\('list'\)/)
    expect(read('fonts/phosphor.css'), 'ph-list is declared').toMatch(/\.ph\.ph-list::before/)
  })

  it('closes on Escape and takes the page behind it out of reach', () => {
    expect(shell, 'the shared closer, so Escape reaches it').toMatch(/closeMenus\.push/)
    expect(shell, 'nothing behind the drawer is tabbable while it is open').toMatch(
      /shell\.inert\s*=\s*open/
    )
    expect(shell, 'and the page behind does not scroll').toMatch(/is-drawer-open/)
  })
})

describe('the e-reader page is left out of all of it', () => {
  const ereader = read('style.css')

  it('keeps its own breakpoints and takes none of ours', () => {
    expect(ereader, 'it had these all along').toMatch(/@media screen and \(max-width: 520px\)/)

    const widths = [...ereader.matchAll(/\(\s*max-width:\s*(\d+)px\s*\)/g)].map((m) => m[1])
    expect(new Set(widths)).toEqual(new Set(['520', '380']))
    expect(widths, 'the phone breakpoint belongs to the other bundle').not.toContain('640')
  })

  it('gains nothing from the design system while we are in here', () => {
    for (const modern of [/--[a-z]/, /display:\s*flex/, /display:\s*grid/, /clamp\(/, /100dvh/]) {
      expect(modern.test(ereader), String(modern)).toBe(false)
    }
  })
})

describe('the card keeps one width, whichever step is open', () => {
  const rule = /\.step-card\s*\{([^}]*)\}/.exec(app)?.[1] ?? ''

  it('fills its row rather than shrink-wrapping the open step', () => {
    expect(rule).toMatch(/width:\s*100%/)
    expect(rule, 'still centred and still capped').toMatch(/margin:\s*26px auto 0/)
    expect(rule).toMatch(/max-width:\s*var\(--card-max\)/)
  })
})
