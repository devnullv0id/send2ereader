export type DeviceKind = 'kobo' | 'kindle' | 'tolino' | 'generic'

export type EbookFormat =
  | 'epub'
  | 'kepub'
  | 'mobi'
  | 'azw3'
  | 'kfx'
  | 'kfxZip'
  | 'pdf'
  | 'cbz'
  | 'cbr'
  | 'txt'
  | 'html'
  | 'htmlz'

export interface StoredFile {
  name: string
  path: string
  format: EbookFormat
  size: number
  uploaded: Date
}

export interface KeyInfo {
  readonly key: string
  readonly created: Date
  readonly agent: string
  readonly device: DeviceKind
  alive: Date
  file: StoredFile | null
  urls: string[]
}

export type ConversionTarget = 'auto' | 'kobo' | 'kindle' | 'none'

export type ResolvedTarget = Exclude<ConversionTarget, 'auto'>

export interface LayoutFixSettings {
  fixImages?: boolean
  minWidthPercent?: number
  fixCovers?: boolean
  darkCover?: boolean
  coverColor?: string
  preserveAnchors?: boolean
  fixCaptioned?: boolean
  fixMultiImage?: boolean
}

export interface ConversionOptions {
  target: ConversionTarget
  kindleFormat: 'azw3' | 'mobi'
  format?: string | null
  pdfcropmargins: boolean
  transliteration: boolean
  layoutFix: boolean
  layout?: LayoutFixSettings
}

export function resolveTarget(target: ConversionTarget, device: DeviceKind): ResolvedTarget {
  if (target !== 'auto') return target
  return device === 'kobo' || device === 'kindle' ? device : 'none'
}
