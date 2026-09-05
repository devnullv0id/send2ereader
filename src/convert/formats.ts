import { supportsLayoutFix } from '../files.js'
import type { ConversionOptions, EbookFormat } from '../types.js'
import type { ConversionPlan, ConversionStep, ToolAvailability } from './index.js'

export type OutputFormat = 'kepub' | 'epub' | 'kfx' | 'azw3' | 'mobi' | 'pdf' | 'txt' | 'htmlz'

export const outputFormats: OutputFormat[] = [
  'kepub',
  'epub',
  'kfx',
  'azw3',
  'mobi',
  'pdf',
  'txt',
  'htmlz',
]

export function isOutputFormat(value: string): value is OutputFormat {
  return (outputFormats as string[]).includes(value)
}

const comicSources: EbookFormat[] = ['cbz', 'cbr']
const comicTargets: OutputFormat[] = ['epub', 'azw3', 'mobi', 'kfx', 'pdf']

const kfxSources: EbookFormat[] = ['kfx', 'kfxZip']

export interface FormatOffer {
  format: OutputFormat
  refusal: string | null
}

export function offerFormat(
  from: EbookFormat | null,
  to: OutputFormat,
  tools: ToolAvailability
): FormatOffer {
  const refusal = (reason: string): FormatOffer => ({ format: to, refusal: reason })

  if (to === 'kfx' && !tools.kfxOutput) {
    return refusal(
      'Writing KFX needs Amazon’s Kindle Previewer, which an administrator can install under Admin → Converters'
    )
  }

  if (!from) return refusal('unsupported source')

  if (kfxSources.includes(from) && !tools.kfxInput) {
    return refusal(
      'Reading KFX needs calibre’s KFX Input plugin, which arrives with the calibre install under Admin → Converters'
    )
  }

  if (comicSources.includes(from) && !comicTargets.includes(to)) {
    return refusal('comics go to EPUB, AZW3, MOBI, KFX or PDF')
  }

  if ((to as string) === from) return { format: to, refusal: null }

  if (to === 'kepub' && !tools.kepubify) {
    return refusal('Writing a Kobo EPUB needs kepubify, which is not installed here')
  }

  const kepubifyOnly = to === 'kepub' && from === 'epub'
  if (!kepubifyOnly && !tools.calibre) {
    return refusal(
      'This conversion needs calibre, which an administrator can install under Admin → Converters'
    )
  }

  return { format: to, refusal: null }
}

export interface FormatGroup {
  name: string
  hint: string
  items: { format: OutputFormat; label: string; note: string }[]
}

export const formatGroups: FormatGroup[] = [
  {
    name: 'Kobo',
    hint: 'also Tolino and PocketBook',
    items: [
      { format: 'kepub', label: 'KEPUB', note: "Kobo's own" },
      { format: 'epub', label: 'EPUB', note: 'read by everything' },
    ],
  },
  {
    name: 'Kindle',
    hint: '',
    items: [
      { format: 'mobi', label: 'MOBI', note: 'older Kindles' },
      { format: 'azw3', label: 'AZW3', note: 'the safe choice' },
      { format: 'kfx', label: 'KFX', note: 'newest Kindles' },
    ],
  },
  {
    name: 'Anything else',
    hint: 'phones, tablets, print',
    items: [
      { format: 'pdf', label: 'PDF', note: 'fixed pages' },
      { format: 'txt', label: 'TXT', note: 'plain text' },
      { format: 'htmlz', label: 'HTMLZ', note: 'one zipped page' },
    ],
  },
]

export interface OfferedTarget {
  format: OutputFormat
  label: string
  note: string
  refusal: string | null
  via: string[]
}

export function offerGroups(
  from: EbookFormat | null,
  tools: ToolAvailability
): (Omit<FormatGroup, 'items'> & { items: OfferedTarget[] })[] {
  const plain = {
    target: 'none' as const,
    kindleFormat: 'azw3' as const,
    pdfcropmargins: false,
    transliteration: false,
    layoutFix: false,
  }

  return formatGroups.map((group) => ({
    name: group.name,
    hint: group.hint,
    items: group.items.map((item) => {
      const { refusal } = offerFormat(from, item.format, tools)
      const via =
        from && !refusal
          ? planFormatConversion(from, item.format, plain, tools).steps.map((s) => s.converter)
          : []
      return { ...item, refusal, via }
    }),
  }))
}

export function planFormatConversion(
  from: EbookFormat,
  to: OutputFormat,
  options: ConversionOptions,
  tools: ToolAvailability
): ConversionPlan {
  const steps: ConversionStep[] = []
  let current: EbookFormat = from

  if (from === 'pdf' && options.pdfcropmargins && tools.pdfcropmargins) {
    steps.push({ converter: 'pdfcropmargins', format: 'pdf' })
  }

  if (to === 'kepub') {
    if (current !== 'epub' && current !== 'kepub') {
      steps.push({ converter: 'calibre', format: 'epub' })
      current = 'epub'
    }
  } else if (to !== current) {
    steps.push({ converter: 'calibre', format: to })
    current = to
  }

  if (options.layoutFix && tools.layoutFix && supportsLayoutFix(current)) {
    steps.push({ converter: 'layoutfix', format: current, optional: true, layout: options.layout })
  }

  if (to === 'kepub' && current !== 'kepub') {
    steps.push({ converter: 'kepubify', format: 'kepub' })
    current = 'kepub'
  }

  return { steps, targetFormat: current }
}
