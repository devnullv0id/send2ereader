import { randomBytes } from 'node:crypto'
import type { Logger } from 'pino'
import { pino } from 'pino'
import { formatRecord } from './format.js'
import { type LogOptions, resolveLogOptions, scopeAllowed } from './options.js'

export { duration, size } from './format.js'
export type { LogOptions } from './options.js'
export { resolveLogOptions } from './options.js'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function newId(now: number = Date.now()): string {
  let time = ''
  let left = now
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[left % 32] + time
    left = Math.floor(left / 32)
  }

  const bytes = randomBytes(16)
  let random = ''
  for (let i = 0; i < 16; i += 1) {
    random += CROCKFORD[(bytes[i] as number) % 32]
  }
  return time + random
}

function colorize(options: LogOptions): boolean {
  if (options.color === 'never') return false
  if (options.color === 'always') return true
  return Boolean(process.stdout.isTTY)
}

function createDestination(options: LogOptions): { write(chunk: string): void } {
  const context = { options, colorize: colorize(options), startedAt: Date.now() }
  const filtering = options.include.length > 0 || options.exclude.length > 0

  return {
    write(chunk: string): void {
      if (options.format === 'json' && !filtering) {
        process.stdout.write(chunk)
        return
      }

      let record: Record<string, unknown>
      try {
        record = JSON.parse(chunk) as Record<string, unknown>
      } catch {
        process.stdout.write(chunk)
        return
      }

      if (!scopeAllowed(record.scope as string | undefined, options)) return
      if (String(record.msg ?? '').trim() === '') return
      if (options.format === 'json') {
        process.stdout.write(chunk)
        return
      }
      process.stdout.write(formatRecord(record, context))
    },
  }
}

export function createLogger(
  options: LogOptions = resolveLogOptions(),
  // biome-ignore lint/suspicious/noExplicitAny: pino's SerializerFn is typed as any
  serializers: Record<string, (value: any) => unknown> = {}
): Logger {
  return pino(
    {
      level: options.level === 'silent' ? 'silent' : options.level,
      base: { service: 'send2ereader' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label: string) => ({ level: label }),
      },
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization'],
        remove: true,
      },
      serializers,
    },
    createDestination(options)
  )
}
