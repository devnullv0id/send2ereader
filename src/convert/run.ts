import { type ChildProcessByStdio, spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { FastifyBaseLogger } from 'fastify'
import { ChildOutput } from '../logging/child.js'
import { settings } from '../settings.js'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export class ConversionError extends Error {
  readonly tool: string
  readonly output: string

  constructor(tool: string, message: string, output = '') {
    super(message)
    this.name = 'ConversionError'
    this.tool = tool
    this.output = output
  }

  toUserMessage(): string {
    return this.message
  }

  // Already redacted by runCommand: infile/outfile replace the real paths before output reaches here.
  toUserDetail(): string | null {
    const said = this.output
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(-12)
      .join('\n')
    return said.length > 0 ? said.slice(-1200) : null
  }
}

function append(buffer: string, chunk: string): string {
  const limit = settings.int('CONVERSION_OUTPUT_LIMIT')
  if (buffer.length >= limit) return buffer
  return (buffer + chunk).slice(0, limit)
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  redact?: Record<string, string>
  log?: FastifyBaseLogger
}

function redactAll(text: string, redact: Record<string, string> | undefined): string {
  if (!redact) return text
  let out = text
  for (const [from, to] of Object.entries(redact)) {
    if (from) out = out.split(from).join(to)
  }
  return out
}

const WINDOWS_SUFFIXES = ['.exe']

function candidates(bin: string): string[] {
  if (process.platform !== 'win32') return [bin]
  if (/\.[a-z0-9]+$/i.test(bin)) return [bin]
  return [...WINDOWS_SUFFIXES.map((suffix) => bin + suffix), bin]
}

const resolved = new Map<string, string>()

export async function runCommand(
  bin: string,
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> {
  const known = resolved.get(bin)
  if (known) return runExact(known, args, options)

  let lastError: unknown
  for (const candidate of candidates(bin)) {
    try {
      const result = await runExact(candidate, args, options)
      resolved.set(bin, candidate)
      return result
    } catch (err) {
      const missing =
        err instanceof ConversionError && err.message.includes('is not installed or not on PATH')
      if (!missing) throw err
      lastError = err
    }
  }
  throw lastError
}

function runExact(bin: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? settings.int('CONVERSION_TIMEOUT_MS')

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn(bin, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const hint =
        code === 'ENOENT' || code === 'EINVAL'
          ? `${bin} is not installed or not on PATH`
          : (err as Error).message
      reject(new ConversionError(bin, `Could not run ${bin}: ${hint}`))
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref()

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const watcher = options.log ? new ChildOutput(options.log) : undefined
    let pending = ''
    const emitLines = (chunk: string) => {
      if (!watcher) return
      pending += chunk.replace(/\r/g, '\n')
      let cut = pending.indexOf('\n')
      while (cut !== -1) {
        const line = pending.slice(0, cut).trim()
        pending = pending.slice(cut + 1)
        if (line) watcher.line(redactAll(line, options.redact))
        cut = pending.indexOf('\n')
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = append(stdout, chunk)
      emitLines(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = append(stderr, chunk)
      emitLines(chunk)
    })

    child.once('error', (err) => {
      const hint =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `${bin} is not installed or not on PATH`
          : err.message
      finish(() => reject(new ConversionError(bin, `Could not run ${bin}: ${hint}`)))
    })

    child.once('close', (code) => {
      if (code !== 0 && watcher) watcher.flush()
      const output = redactAll(`${stdout}\n${stderr}`, options.redact)
      finish(() => {
        if (timedOut) {
          reject(new ConversionError(bin, `${bin} timed out after ${timeoutMs / 1000}s`, output))
        } else {
          resolve({
            code: code ?? -1,
            stdout: redactAll(stdout, options.redact),
            stderr: redactAll(stderr, options.redact),
          })
        }
      })
    })
  })
}

export async function isToolAvailable(bin: string): Promise<boolean> {
  try {
    await runCommand(bin, ['--version'], { timeoutMs: 30_000 })
    return true
  } catch {
    return false
  }
}
