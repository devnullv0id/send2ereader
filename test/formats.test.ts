import { describe, expect, it } from 'vitest'
import {
  isOutputFormat,
  type OutputFormat,
  offerFormat,
  offerGroups,
  planFormatConversion,
} from '../src/convert/formats.js'
import type { ToolAvailability } from '../src/convert/index.js'
import type { ConversionOptions, EbookFormat } from '../src/types.js'

const ALL: ToolAvailability = {
  kepubify: true,
  calibre: true,
  pdfcropmargins: true,
  kfxInput: true,
  kfxOutput: false,
  layoutFix: true,
}

const PLAIN: ConversionOptions = {
  target: 'none',
  kindleFormat: 'azw3',
  pdfcropmargins: false,
  transliteration: false,
  layoutFix: false,
}

const steps = (from: EbookFormat, to: OutputFormat, options = PLAIN, tools = ALL) =>
  planFormatConversion(from, to, options, tools).steps.map((s) => s.converter)

describe('which conversions are offered', () => {
  it('refuses KFX out while the Previewer is not installed, and names it', () => {
    const offer = offerFormat('epub', 'kfx', ALL)
    expect(offer.refusal).toBeTruthy()
    expect(offer.refusal).toMatch(/Kindle Previewer/)
  })

  it('offers KFX out for real once the Previewer is there', () => {
    const withPreviewer = { ...ALL, kfxOutput: true }

    expect(offerFormat('epub', 'kfx', withPreviewer).refusal).toBeNull()
    expect(steps('epub', 'kfx', PLAIN, withPreviewer), 'calibre drives it').toEqual(['calibre'])

    const shown = offerGroups('epub', withPreviewer)[1]?.items.find((i) => i.format === 'kfx')
    expect(shown?.refusal).toBeNull()
    expect(shown?.via).toEqual(['calibre'])
  })

  it('still refuses KFX out when calibre itself is missing, whatever the plugin says', () => {
    const noCalibre = { ...ALL, kfxOutput: true, calibre: false }
    expect(offerFormat('epub', 'kfx', noCalibre).refusal).toMatch(/calibre/)
  })

  it('sends comics only to the formats that can carry pages of images', () => {
    for (const to of ['epub', 'azw3', 'mobi', 'pdf'] as OutputFormat[]) {
      expect(offerFormat('cbz', to, ALL).refusal, to).toBeNull()
    }
    for (const to of ['txt', 'htmlz', 'kepub'] as OutputFormat[]) {
      expect(offerFormat('cbr', to, ALL).refusal, to).toMatch(/comics go to/)
    }
  })

  it('takes a PDF to every target it offers at all', () => {
    for (const to of ['kepub', 'epub', 'azw3', 'mobi', 'pdf', 'txt', 'htmlz'] as OutputFormat[]) {
      expect(offerFormat('pdf', to, ALL).refusal, to).toBeNull()
    }
  })

  it('allows the same container out as in, which re-runs the fixes', () => {
    expect(offerFormat('epub', 'epub', ALL).refusal).toBeNull()
    expect(offerFormat('kepub', 'kepub', ALL).refusal).toBeNull()
    expect(steps('epub', 'epub')).toEqual([])
  })

  it('refuses everything when the source is not readable', () => {
    for (const to of ['epub', 'azw3', 'pdf'] as OutputFormat[]) {
      expect(offerFormat(null, to, ALL).refusal, to).toBeTruthy()
    }
  })

  it('names the missing tool rather than saying no', () => {
    expect(offerFormat('epub', 'kepub', { ...ALL, kepubify: false }).refusal).toMatch(/kepubify/)
    expect(offerFormat('epub', 'azw3', { ...ALL, calibre: false }).refusal).toMatch(/calibre/)
    expect(offerFormat('kfx', 'epub', { ...ALL, kfxInput: false }).refusal).toMatch(/KFX Input/)
  })

  it('still packages an EPUB as a KEPUB without calibre, which is kepubify’s own hop', () => {
    expect(offerFormat('epub', 'kepub', { ...ALL, calibre: false }).refusal).toBeNull()
    expect(steps('epub', 'kepub')).toEqual(['kepubify'])
  })
})

describe('the steps a conversion takes', () => {
  it('routes anything else to a KEPUB through an EPUB first', () => {
    expect(steps('pdf', 'kepub')).toEqual(['calibre', 'kepubify'])
    expect(steps('mobi', 'kepub')).toEqual(['calibre', 'kepubify'])
  })

  it('reads a KEPUB directly, because it is an EPUB with Kobo markup', () => {
    expect(steps('kepub', 'azw3')).toEqual(['calibre'])
    expect(steps('kepub', 'kepub')).toEqual([])
  })

  it('crops a PDF before anything reads it, not after', () => {
    const withCrop = { ...PLAIN, pdfcropmargins: true }
    expect(steps('pdf', 'epub', withCrop)).toEqual(['pdfcropmargins', 'calibre'])
    expect(steps('pdf', 'pdf', withCrop)).toEqual(['pdfcropmargins'])
  })

  it('repairs the EPUB before packaging it, never the KEPUB after', () => {
    const withFix = { ...PLAIN, layoutFix: true }
    expect(steps('pdf', 'kepub', withFix)).toEqual(['calibre', 'layoutfix', 'kepubify'])

    const plan = planFormatConversion('pdf', 'kepub', withFix, ALL)
    const repair = plan.steps.find((s) => s.converter === 'layoutfix')
    expect(repair?.format, 'repairs an epub, not a kepub').toBe('epub')
    expect(repair?.optional, 'a cosmetic repair never fails the conversion').toBe(true)
  })

  it('runs on AZW3, which carries the same defect', () => {
    expect(steps('epub', 'azw3', { ...PLAIN, layoutFix: true })).toEqual(['calibre', 'layoutfix'])
  })

  it('leaves MOBI alone, which the fix does not cover', () => {
    expect(steps('epub', 'mobi', { ...PLAIN, layoutFix: true })).toEqual(['calibre'])
  })

  it('ends on the container that was asked for', () => {
    for (const to of ['kepub', 'epub', 'azw3', 'mobi', 'pdf', 'txt', 'htmlz'] as OutputFormat[]) {
      expect(planFormatConversion('epub', to, PLAIN, ALL).targetFormat, to).toBe(to)
    }
  })
})

describe('what the page is told', () => {
  it('groups the targets the way the design does', () => {
    const groups = offerGroups('epub', ALL)
    expect(groups.map((g) => g.name)).toEqual(['Kobo', 'Kindle', 'Anything else'])
    expect(groups[0]?.items.map((i) => i.format)).toEqual(['kepub', 'epub'])
    expect(groups[1]?.items.map((i) => i.format)).toEqual(['mobi', 'azw3', 'kfx'])
    expect(groups[2]?.items.map((i) => i.format)).toEqual(['pdf', 'txt', 'htmlz'])
  })

  it('names the converters a target would run, for the pipeline line', () => {
    const kobo = offerGroups('pdf', ALL)[0]?.items.find((i) => i.format === 'kepub')
    expect(kobo?.via).toEqual(['calibre', 'kepubify'])
  })

  it('carries no pipeline for a target it refuses', () => {
    const kfx = offerGroups('epub', ALL)[1]?.items.find((i) => i.format === 'kfx')
    expect(kfx?.refusal).toBeTruthy()
    expect(kfx?.via).toEqual([])
  })

  it('still lists every target with no file chosen, so the grid is not empty', () => {
    const groups = offerGroups(null, ALL)
    expect(groups.flatMap((g) => g.items)).toHaveLength(8)
  })
})

describe('the format names the page may send', () => {
  it('accepts exactly the eight the design offers', () => {
    for (const name of ['kepub', 'epub', 'kfx', 'azw3', 'mobi', 'pdf', 'txt', 'htmlz']) {
      expect(isOutputFormat(name), name).toBe(true)
    }
    for (const name of ['cbz', 'cbr', 'kfxZip', '', 'exe']) {
      expect(isOutputFormat(name), name).toBe(false)
    }
  })
})
