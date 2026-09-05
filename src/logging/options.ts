export type LogFormat = 'text' | 'json'
export type LogTime = 'iso' | 'short' | 'rel' | 'none'
export type LogColor = 'auto' | 'always' | 'never'

export interface LogOptions {
  level: string
  format: LogFormat
  time: LogTime
  color: LogColor
  include: string[]
  exclude: string[]
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']

function flagValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const arg = argv[i] as string
    if (arg.startsWith(prefix)) return arg.slice(prefix.length)
    if (arg === `--${name}` && argv[i + 1] !== undefined) return argv[i + 1] as string
  }
  return undefined
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  const lower = value.toLowerCase() as T
  return allowed.includes(lower) ? lower : undefined
}

function levelFromShorthand(argv: string[]): string | undefined {
  let level: string | undefined
  for (const arg of argv) {
    if (arg === '-vv') level = 'trace'
    else if (arg === '-v' && level !== 'trace') level = 'debug'
    else if (arg === '-q') level = 'warn'
  }
  return level
}

function scopes(value: string | undefined): { include: string[]; exclude: string[] } {
  const include: string[] = []
  const exclude: string[] = []
  if (!value) return { include, exclude }

  for (const raw of value.split(',')) {
    const name = raw.trim()
    if (!name) continue
    if (name.startsWith('-')) exclude.push(name.slice(1).toLowerCase())
    else include.push(name.toLowerCase())
  }
  return { include, exclude }
}

export function resolveLogOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): LogOptions {
  const level =
    oneOf(flagValue(argv, 'log-level'), LEVELS) ??
    levelFromShorthand(argv) ??
    oneOf(env.LOG_LEVEL, LEVELS) ??
    'info'

  const legacyPretty = env.LOG_PRETTY === undefined ? undefined : env.LOG_PRETTY !== 'false'
  const format =
    oneOf<LogFormat>(flagValue(argv, 'log-format'), ['text', 'json']) ??
    oneOf<LogFormat>(env.LOG_FORMAT, ['text', 'json']) ??
    (legacyPretty === false ? 'json' : 'text')

  const time =
    oneOf<LogTime>(flagValue(argv, 'log-time'), ['iso', 'short', 'rel', 'none']) ??
    oneOf<LogTime>(env.LOG_TIME, ['iso', 'short', 'rel', 'none']) ??
    'iso'

  const color =
    env.NO_COLOR !== undefined && env.NO_COLOR !== ''
      ? 'never'
      : (oneOf<LogColor>(flagValue(argv, 'log-color'), ['auto', 'always', 'never']) ?? 'auto')

  const { include, exclude } = scopes(flagValue(argv, 'log-scope') ?? env.LOG_SCOPE)

  return { level, format, time, color, include, exclude }
}

export function scopeAllowed(scope: string | undefined, options: LogOptions): boolean {
  const name = (scope ?? '').toLowerCase()
  if (options.exclude.includes(name)) return false
  if (options.include.length === 0) return true
  return options.include.includes(name)
}
