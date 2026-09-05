import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
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

let running = 0

export interface ConversionLogging {
  logger?: FastifyBaseLogger
  job?: string
}

export async function runConversion(
  plan: ConversionPlan,
  inputPath: string,
  inputFormat: EbookFormat,
  logging: ConversionLogging = {}
): Promise<ConversionResult> {
  if (plan.steps.length === 0) return { path: inputPath, applied: [] }
  if (running >= store.int('CONVERSION_CONCURRENCY')) throw new TooBusyError()

  running += 1
  try {
    return await convert(plan, inputPath, inputFormat, logging)
  } finally {
    running -= 1
  }
}

async function bytesOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}

async function convert(
  plan: ConversionPlan,
  inputPath: string,
  inputFormat: EbookFormat,
  logging: ConversionLogging
): Promise<ConversionResult> {
  let currentPath = inputPath
  let currentFormat = inputFormat
  const applied: ConverterName[] = []
  const produced: string[] = []
  const skipped: ConverterName[] = []

  const { logger, job } = logging
  const from = inputFormat
  const to = plan.targetFormat
  const startedAt = Date.now()

  logger?.info(
    {
      scope: 'convert',
      job,
      in: await bytesOf(inputPath),
      steps: plan.steps.map((step) => step.converter).join(','),
    },
    `${from}→${to} started`
  )

  try {
    for (const [index, step] of plan.steps.entries()) {
      const outputPath = buildStepPath(inputPath, step, index)
      const stepStartedAt = Date.now()
      try {
        await runStep(step, currentPath, currentFormat, outputPath, logging)
      } catch (err) {
        if (!step.optional) throw err
        skipped.push(step.converter)
        logger?.warn(
          { scope: step.converter, job, took: Date.now() - stepStartedAt },
          `step failed: ${err instanceof Error ? err.message : String(err)}`
        )
        await safeUnlink(outputPath)
        continue
      }
      produced.push(outputPath)
      applied.push(step.converter)
      currentPath = outputPath
      currentFormat = step.format
    }
  } catch (err) {
    logger?.error(
      { scope: 'convert', job, took: Date.now() - startedAt },
      `${from}→${to} failed: ${err instanceof Error ? err.message : String(err)}`
    )
    await safeUnlink(inputPath)
    await Promise.all(produced.map(safeUnlink))
    throw err
  }

  if (currentPath !== inputPath) await safeUnlink(inputPath)
  await Promise.all(produced.filter((p) => p !== currentPath).map(safeUnlink))
  if (currentFormat === 'azw3' || currentFormat === 'mobi') {
    await unbrandKindleFile(currentPath).catch((err) => {
      logger?.warn(
        { scope: 'calibre', job },
        `could not strip the store identifiers: ${(err as Error).message}`
      )
      return false
    })
  }

  const outcome = skipped.length > 0 ? 'partial' : 'ok'
  const finish = skipped.length > 0 ? logger?.warn.bind(logger) : logger?.info.bind(logger)
  finish?.(
    {
      scope: 'convert',
      job,
      out: await bytesOf(currentPath),
      took: Date.now() - startedAt,
      failed: skipped.length > 0 ? skipped.join(',') : undefined,
    },
    `${from}→${to} ${outcome}`
  )

  return { path: currentPath, applied }
}

async function runStep(
  step: ConversionStep,
  inputPath: string,
  inputFormat: EbookFormat,
  outputPath: string,
  logging: ConversionLogging = {}
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
  const opts = {
    cwd,
    redact,
    log: logging.logger?.child({ scope: step.converter, job: logging.job }),
  }

  try {
    switch (step.converter) {
      case 'kepubify':
        return await expectSuccess(
          step.converter,
          await runCommand(config.bin.kepubify, ['-v', '-u', '-o', outputName, inputName], opts)
        )

      case 'calibre':
        return await expectSuccess(
          step.converter,
          await runCommand(config.bin.ebookConvert, calibreArgs(inputName, outputName, step), opts)
        )

      case 'pdfcropmargins':
        return await expectSuccess(
          step.converter,
          await runCommand(
            config.bin.pdfCropMargins,
            ['-s', '-u', '-o', outputName, inputName],
            opts
          )
        )

      case 'layoutfix':
        return await expectSuccess(
          step.converter,
          await runCommand(
            config.bin.layoutFix,
            [...layoutFixArgs(step.layout), inputName, outputName],
            opts
          )
        )
    }
  } catch (err) {
    if (err instanceof ConversionError && err.tool !== step.converter) {
      throw new ConversionError(step.converter, err.message, err.output)
    }
    throw err
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

const PREVIEWER_MARKER = '/etc/s2e/kfx-previewer'

async function previewerAvailable(): Promise<boolean> {
  if (config.kfxPreviewerPath) return existsSync(config.kfxPreviewerPath)
  try {
    const recorded = (await readFile(PREVIEWER_MARKER, 'utf8')).trim()
    return recorded.length > 0 && existsSync(recorded)
  } catch {
    return false
  }
}

export async function refreshTools(tools: ToolAvailability): Promise<ToolAvailability> {
  Object.assign(tools, await detectTools())
  return tools
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
    kfxOutput: kfx.output && (await previewerAvailable()),
    layoutFix,
  }
}
