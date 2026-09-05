import { basename, dirname, join, sep } from 'node:path'
import { config } from '../config.js'
import { fileExtensions, safeUnlink, supportsLayoutFix } from '../files.js'
import { settings as store } from '../settings.js'
import type { ConversionOptions, EbookFormat, LayoutFixSettings, ResolvedTarget } from '../types.js'
import { unbrandKindleFile } from './kindle-asin.js'
import { ConversionError, isToolAvailable, runCommand } from './run.js'

export { ConversionError } from './run.js'

export type ConverterName = 'kepubify' | 'calibre' | 'pdfcropmargins' | 'layoutfix'

export interface ToolAvailability {
  kepubify: boolean
  calibre: boolean
  pdfcropmargins: boolean
  kfxInput: boolean
  kfxOutput: boolean
  layoutFix: boolean
}

export interface ConversionStep {
  converter: ConverterName
  format: EbookFormat
  optional?: boolean
  layout?: LayoutFixSettings
}

export function layoutFixArgs(layout: LayoutFixSettings | undefined): string[] {
  if (!layout) return []

  const args: string[] = []
  const toggle = (name: string, wanted: boolean | undefined): void => {
    if (wanted !== undefined) args.push(wanted ? `--${name}` : `--no-${name}`)
  }

  toggle('fix-images', layout.fixImages)
  toggle('preserve-anchors', layout.preserveAnchors)
  toggle('fix-captioned', layout.fixCaptioned)
  toggle('fix-multi-image', layout.fixMultiImage)
  toggle('fix-covers', layout.fixCovers)
  toggle('dark-cover', layout.darkCover)

  if (layout.minWidthPercent !== undefined) {
    args.push('--min-width-percent', String(layout.minWidthPercent))
  }
  if (layout.coverColor) args.push('--cover-color', layout.coverColor)

  return args
}

export interface ConversionPlan {
  steps: ConversionStep[]
  targetFormat: EbookFormat
}

const kindleConvertible: EbookFormat[] = ['epub', 'kepub', 'txt', 'html', 'htmlz', 'cbz', 'cbr']

const kindleNative: EbookFormat[] = ['mobi', 'azw3', 'kfx']

const kfxFormats: EbookFormat[] = ['kfx', 'kfxZip']

export function planConversion(
  target: ResolvedTarget,
  format: EbookFormat,
  options: ConversionOptions,
  tools: ToolAvailability
): ConversionPlan {
  const steps: ConversionStep[] = []
  const plan = (): ConversionPlan => ({
    steps,
    targetFormat: steps.length > 0 ? steps[steps.length - 1]!.format : format,
  })

  if (format === 'pdf') {
    if (options.pdfcropmargins && tools.pdfcropmargins) {
      steps.push({ converter: 'pdfcropmargins', format: 'pdf' })
    }
    return plan()
  }

  let current = format

  if (kfxFormats.includes(format)) {
    const nativeToKindle = target === 'kindle' && format === 'kfx'
    const readable = tools.calibre && tools.kfxInput
    if (!nativeToKindle && readable && target !== 'none') {
      current = target === 'kindle' ? options.kindleFormat : 'epub'
      steps.push({ converter: 'calibre', format: current })
    }
  } else if (
    target === 'kindle' &&
    tools.calibre &&
    !kindleNative.includes(format) &&
    kindleConvertible.includes(format)
  ) {
    current = options.kindleFormat
    steps.push({ converter: 'calibre', format: current })
  }

  if (options.layoutFix && tools.layoutFix && supportsLayoutFix(current)) {
    steps.push({ converter: 'layoutfix', format: current, optional: true, layout: options.layout })
  }

  if (target === 'kobo' && current === 'epub' && tools.kepubify) {
    current = 'kepub'
    steps.push({ converter: 'kepubify', format: current })
  }

  return plan()
}

export interface ConversionResult {
  path: string
  applied: ConverterName[]
}

export class TooBusyError extends Error {
  readonly statusCode = 503
  constructor() {
    super('Too many books are being converted right now. Try again in a moment.')
    this.name = 'TooBusyError'
  }
}

// calibre will happily take a core and ten minutes over one book, and nothing
// upstream of here bounds how many callers ask at once.
let running = 0

export function conversionsRunning(): number {
  return running
}

export async function runConversion(
  plan: ConversionPlan,
  inputPath: string,
  inputFormat: EbookFormat,
  log?: StepLogger
): Promise<ConversionResult> {
  if (plan.steps.length === 0) return { path: inputPath, applied: [] }
  if (running >= store.int('CONVERSION_CONCURRENCY')) throw new TooBusyError()

  running += 1
  try {
    return await convert(plan, inputPath, inputFormat, log)
  } finally {
    running -= 1
  }
}

async function convert(
  plan: ConversionPlan,
  inputPath: string,
  inputFormat: EbookFormat,
  log?: StepLogger
): Promise<ConversionResult> {
  let currentPath = inputPath
  let currentFormat = inputFormat
  const applied: ConverterName[] = []
  const produced: string[] = []

  try {
    for (const [index, step] of plan.steps.entries()) {
      const outputPath = buildStepPath(inputPath, step, index)
      try {
        await runStep(step, currentPath, currentFormat, outputPath)
      } catch (err) {
        if (!step.optional) throw err
        log?.(step.converter, err instanceof Error ? err.message : String(err))
        await safeUnlink(outputPath)
        continue
      }
      produced.push(outputPath)
      applied.push(step.converter)
      currentPath = outputPath
      currentFormat = step.format
    }
  } catch (err) {
    await safeUnlink(inputPath)
    await Promise.all(produced.map(safeUnlink))
    throw err
  }

  if (currentPath !== inputPath) await safeUnlink(inputPath)
  await Promise.all(produced.filter((p) => p !== currentPath).map(safeUnlink))
  if (currentFormat === 'azw3' || currentFormat === 'mobi') {
    // Cosmetic, so a failure here must not lose the book — but silence meant a
    // failed rewrite looked exactly like a book with nothing to strip.
    await unbrandKindleFile(currentPath).catch((err) => {
      log?.('calibre', `could not strip the store identifiers: ${(err as Error).message}`)
      return false
    })
  }
  return { path: currentPath, applied }
}

export type StepLogger = (converter: ConverterName, reason: string) => void

async function runStep(
  step: ConversionStep,
  inputPath: string,
  inputFormat: EbookFormat,
  outputPath: string
): Promise<void> {
  const cwd = dirname(inputPath)
  const inputName = basename(inputPath)
  const outputName = basename(outputPath)
  const redact = {
    [join(config.uploadDir, inputName)]: `infile${fileExtensions[inputFormat]}`,
    [join(config.uploadDir, outputName)]: `outfile${fileExtensions[step.format]}`,
    [`${config.uploadDir}${sep}`]: '',
    [config.uploadDir]: '',
    [inputName]: `infile${fileExtensions[inputFormat]}`,
    [outputName]: `outfile${fileExtensions[step.format]}`,
  }
  const opts = { cwd, redact }

  switch (step.converter) {
    case 'kepubify':
      return expectSuccess(
        step.converter,
        await runCommand(config.bin.kepubify, ['-v', '-u', '-o', outputName, inputName], opts)
      )

    case 'calibre':
      return expectSuccess(
        step.converter,
        await runCommand(config.bin.ebookConvert, calibreArgs(inputName, outputName, step), opts)
      )

    case 'pdfcropmargins':
      return expectSuccess(
        step.converter,
        await runCommand(config.bin.pdfCropMargins, ['-s', '-u', '-o', outputName, inputName], opts)
      )

    case 'layoutfix':
      return expectSuccess(
        step.converter,
        await runCommand(
          config.bin.layoutFix,
          [...layoutFixArgs(step.layout), inputName, outputName],
          opts
        )
      )
  }
}

function buildStepPath(inputPath: string, step: ConversionStep, index: number): string {
  const dir = dirname(inputPath)
  const stem = basename(inputPath)
    .replace(/\.kepub\.epub$/i, '')
    .replace(/\.[^.]+$/, '')
  return join(dir, `${stem}-${index + 1}${step.converter}${fileExtensions[step.format]}`)
}

export interface CalibreSettings {
  calibreOutputProfile: string
  kindleShareNotSync: boolean
}

function calibreSettings(): CalibreSettings {
  return {
    calibreOutputProfile: store.str('CALIBRE_OUTPUT_PROFILE'),
    kindleShareNotSync: store.bool('KINDLE_SHARE_NOT_SYNC'),
  }
}

export function calibreArgs(
  inputName: string,
  outputName: string,
  step: ConversionStep,
  overrides?: CalibreSettings
): string[] {
  const settings = overrides ?? calibreSettings()
  const args = [inputName, outputName]
  const kindleTarget = step.format === 'azw3' || step.format === 'mobi'
  if (kindleTarget && settings.calibreOutputProfile) {
    args.push('--output-profile', settings.calibreOutputProfile)
  }
  if (kindleTarget && settings.kindleShareNotSync) {
    args.push('--share-not-sync')
  }
  if (step.format === 'mobi') {
    args.push('--mobi-file-type', 'old')
  }
  return args
}

async function expectSuccess(
  converter: ConverterName,
  result: Awaited<ReturnType<typeof runCommand>>
): Promise<void> {
  if (result.code !== 0) {
    throw new ConversionError(
      converter,
      `${converter} failed (exit code ${result.code})`,
      `${result.stdout}\n${result.stderr}`
    )
  }
}

// One call, two answers: the plugin list is the same list for both, and asking
// calibre twice costs a second of boot for nothing.
async function detectKfxPlugins(): Promise<{ input: boolean; output: boolean }> {
  try {
    const result = await runCommand(config.bin.calibreCustomize, ['--list-plugins'], {
      timeoutMs: 60_000,
    })
    if (result.code !== 0) return { input: false, output: false }
    return {
      input: /KFX Input/i.test(result.stdout),
      output: /KFX Output/i.test(result.stdout),
    }
  } catch {
    return { input: false, output: false }
  }
}

export async function detectTools(): Promise<ToolAvailability> {
  const [kepubify, calibre, pdfcropmargins, layoutFix] = await Promise.all([
    isToolAvailable(config.bin.kepubify),
    isToolAvailable(config.bin.ebookConvert),
    isToolAvailable(config.bin.pdfCropMargins),
    isToolAvailable(config.bin.layoutFix),
  ])
  const kfx = calibre ? await detectKfxPlugins() : { input: false, output: false }
  return {
    kepubify,
    calibre,
    pdfcropmargins,
    kfxInput: kfx.input,
    kfxOutput: kfx.output,
    layoutFix,
  }
}
