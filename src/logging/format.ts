import type { LogOptions } from './options.js'

const LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
}

const LEVEL_COLORS: Record<string, string> = {
  TRACE: '[2m',
  DEBUG: '[36m',
  INFO: '[32m',
  WARN: '[33m',
  ERROR: '[31m',
  FATAL: '[31m',
}

const RESET = '[0m'

const HIDDEN = new Set(['level', 'time', 'msg', 'scope', 'reqId', 'pid', 'hostname', 'service'])

const DURATION_KEYS = new Set(['took', 'responseTime', 'retryAfter'])
const SIZE_KEYS = new Set(['in', 'out', 'size', 'bytes'])

const LEVEL_WIDTH = 5
const SCOPE_WIDTH = 9

export function duration(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms)
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function size(bytes: number): string {
  if (!Number.isFinite(bytes)) return String(bytes)
  if (bytes < 1000) return `${bytes}B`
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)}kB`
  return `${(bytes / 1000 / 1000).toFixed(1)}MB`
}

function offset(date: Date): string {
  const mins = -date.getTimezoneOffset()
  const sign = mins < 0 ? '-' : '+'
  const abs = Math.abs(mins)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
}

function stamp(value: unknown, mode: LogOptions['time'], startedAt: number): string {
  if (mode === 'none') return ''

  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  if (!Number.isFinite(ms)) return ''

  if (mode === 'rel') {
    const seconds = (ms - startedAt) / 1000
    return `+${seconds.toFixed(3)}s`
  }

  const date = new Date(ms)
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  if (mode === 'short') return clock

  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day} ${clock} ${offset(date)}`
}

function scalar(key: string, value: unknown): string {
  if (typeof value === 'number') {
    if (DURATION_KEYS.has(key)) return duration(value)
    if (SIZE_KEYS.has(key)) return size(value)
    return String(value)
  }
  if (typeof value === 'string') {
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value
  }
  if (value === null || value === undefined) return String(value)
  if (Array.isArray(value)) return value.join(',')
  return JSON.stringify(value)
}

function tail(record: Record<string, unknown>): { pairs: string; blocks: string[] } {
  const pairs: string[] = []
  const blocks: string[] = []

  for (const [key, value] of Object.entries(record)) {
    if (HIDDEN.has(key)) continue
    if (value === undefined) continue

    if (key === 'err' && value && typeof value === 'object') {
      const err = value as { type?: string; message?: string; stack?: string }
      if (err.message) pairs.push(`error=${scalar('error', err.message)}`)
      if (err.stack) blocks.push(err.stack)
      continue
    }

    const text = scalar(key, value)
    if (text.includes('\n')) {
      blocks.push(`${key}=${text}`)
      continue
    }
    pairs.push(`${key}=${text}`)
  }

  return { pairs: pairs.join(' '), blocks }
}

function message(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const first = text.split(' ')[0] as string
  const lowered =
    first === first.toUpperCase() && /[A-Z]/.test(first)
      ? text
      : text.charAt(0).toLowerCase() + text.slice(1)
  return lowered.replace(/\.$/, '')
}

export interface FormatContext {
  options: LogOptions
  colorize: boolean
  startedAt: number
}

export function formatRecord(record: Record<string, unknown>, context: FormatContext): string {
  const levelValue = record.level
  const level =
    typeof levelValue === 'string'
      ? levelValue.toUpperCase()
      : (LEVEL_NAMES[Number(levelValue)] ?? 'INFO')

  const when = stamp(record.time, context.options.time, context.startedAt)
  const scope = String(record.scope ?? 'server').slice(0, SCOPE_WIDTH)
  const reqId = record.reqId === undefined ? '' : `[${String(record.reqId)}] `

  const painted =
    context.colorize && LEVEL_COLORS[level]
      ? `${LEVEL_COLORS[level]}${level.padEnd(LEVEL_WIDTH)}${RESET}`
      : level.padEnd(LEVEL_WIDTH)

  const { pairs, blocks } = tail(record)
  const head = when ? `${when}  ` : ''
  const body = `${reqId}${message(record.msg)}`
  const line = `${head}${painted}  ${scope.padEnd(SCOPE_WIDTH)}  ${body}${pairs ? `  ${pairs}` : ''}`

  if (blocks.length === 0) return `${line}\n`

  const indented = blocks
    .flatMap((block) => block.split('\n'))
    .map((part) => `    ${part.trim()}`)
    .join('\n')
  return `${line}\n${indented}\n`
}
