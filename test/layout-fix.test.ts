import { describe, expect, it } from 'vitest'
import { planFormatConversion } from '../src/convert/formats.js'
import { layoutFixArgs, planConversion } from '../src/convert/index.js'
import { readLayoutSettings } from '../src/routes/upload.js'
import type { ConversionOptions } from '../src/types.js'

const ALL = {
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
  layoutFix: true,
}

const wire = (fields: Record<string, string>) => new Map(Object.entries(fields))

describe('the layout fix settings a sender may ask for', () => {
  it('says nothing when the sender asked for nothing', () => {
    expect(readLayoutSettings(wire({}))).toBeUndefined()
    expect(layoutFixArgs(undefined)).toEqual([])
  })

  it('carries each toggle through as the flag the engine reads', () => {
    const settings = readLayoutSettings(
      wire({
        layoutFixImages: 'on',
        layoutPreserveAnchors: 'off',
        layoutFixCaptioned: 'on',
        layoutFixMultiImage: 'off',
        layoutFixCovers: 'on',
        layoutDarkCover: 'off',
      })
    )

    expect(layoutFixArgs(settings)).toEqual([
      '--fix-images',
      '--no-preserve-anchors',
      '--fix-captioned',
      '--no-fix-multi-image',
      '--fix-covers',
      '--no-dark-cover',
    ])
  })

  it('passes the threshold and the letterbox colour as values', () => {
    const settings = readLayoutSettings(
      wire({ layoutMinWidthPercent: '62.5', layoutCoverColor: '#101010' })
    )

    expect(settings).toEqual({ minWidthPercent: 62.5, coverColor: '#101010' })
    expect(layoutFixArgs(settings)).toEqual([
      '--min-width-percent',
      '62.5',
      '--cover-color',
      '#101010',
    ])
  })

  it('drops a threshold outside the range and a colour that is not a hex triplet', () => {
    expect(readLayoutSettings(wire({ layoutMinWidthPercent: '0' }))).toBeUndefined()
    expect(readLayoutSettings(wire({ layoutMinWidthPercent: '101' }))).toBeUndefined()
    expect(readLayoutSettings(wire({ layoutMinWidthPercent: 'wide' }))).toBeUndefined()
    expect(readLayoutSettings(wire({ layoutCoverColor: 'black' }))).toBeUndefined()
    expect(readLayoutSettings(wire({ layoutCoverColor: '#abc' }))).toBeUndefined()
  })

  it('reaches the step that runs the tool, by both planners', () => {
    const layout = readLayoutSettings(wire({ layoutDarkCover: 'off', layoutCoverColor: '#223344' }))
    const options = { ...PLAIN, layout }

    const viaTarget = planConversion('kobo', 'epub', options, ALL)
    const viaFormat = planFormatConversion('epub', 'kepub', options, ALL)

    for (const plan of [viaTarget, viaFormat]) {
      const step = plan.steps.find((s) => s.converter === 'layoutfix')
      expect(step?.layout, 'the settings ride on the step').toEqual(layout)
      expect(layoutFixArgs(step?.layout)).toEqual(['--no-dark-cover', '--cover-color', '#223344'])
    }
  })

  it('leaves the command line alone when the sender customised nothing', () => {
    const plan = planConversion('kobo', 'epub', PLAIN, ALL)
    const step = plan.steps.find((s) => s.converter === 'layoutfix')

    expect(step).toBeDefined()
    expect(
      layoutFixArgs(step?.layout),
      'an untouched setup calls the tool as it always did'
    ).toEqual([])
  })
})
