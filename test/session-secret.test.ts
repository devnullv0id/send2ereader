import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readOrCreateSessionSecret, SECRET_BYTES } from '../src/auth/secret.js'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 's2e-secret-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const fresh = (name: string) => join(dir, name, 'session.key')

describe('the key file', () => {
  it('makes one when there is none, and says it made it', () => {
    const path = fresh('made')
    const first = readOrCreateSessionSecret(path)

    expect(first.created).toBe(true)
    expect(Buffer.from(first.secret, 'base64url')).toHaveLength(SECRET_BYTES)
    expect(readFileSync(path, 'utf8').trim()).toBe(first.secret)
  })

  it('reads the same one back, because a new key every boot is a key nobody has', () => {
    const path = fresh('kept')
    const first = readOrCreateSessionSecret(path)
    const second = readOrCreateSessionSecret(path)

    expect(second.created).toBe(false)
    expect(second.secret).toBe(first.secret)
  })

  it('is not a different key twice', () => {
    const many = new Set(
      Array.from({ length: 20 }, (_, i) => readOrCreateSessionSecret(fresh(`draw-${i}`)).secret)
    )
    expect(many.size).toBe(20)
  })

  it('replaces an empty file rather than deriving every key from nothing', () => {
    const path = fresh('blank')
    readOrCreateSessionSecret(path)
    writeFileSync(path, '   \n')

    const again = readOrCreateSessionSecret(path)
    expect(again.created).toBe(true)
    expect(again.secret.length).toBeGreaterThan(0)
  })

  it.runIf(process.platform !== 'win32')('is readable by nobody else', () => {
    const path = fresh('mode')
    readOrCreateSessionSecret(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('a server given no SESSION_SECRET', () => {
  const boot = (dbPath: string): string =>
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `const c = await import('./src/config.ts')
         c.provisionSessionSecret()
         console.log(JSON.stringify({
           secret: c.sessionSecret(),
           origin: c.sessionSecretOrigin(),
           accounts: c.accountsEnabled(),
           path: c.sessionKeyPath,
         }))`,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          SESSION_SECRET: undefined,
          ENV_FILE: join(dir, 'no-such-env-file'),
          DB_PATH: dbPath,
        } as NodeJS.ProcessEnv,
      }
    ).trim()

  it('generates one, keeps it, and has accounts because of it', () => {
    const dbPath = join(dir, 'boot', 'send2ereader.db')

    const first = JSON.parse(boot(dbPath))
    expect(first.origin).toBe('generated')
    expect(first.accounts, 'no environment at all still has to be configurable').toBe(true)
    expect(first.path).toBe(join(dir, 'boot', 'session.key'))

    const second = JSON.parse(boot(dbPath))
    expect(second.secret, 'the same key on the next boot').toBe(first.secret)
  })

  it('leaves an explicit secret alone, file or no file', () => {
    const out = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `const c = await import('./src/config.ts')
         const made = c.provisionSessionSecret()
         console.log(JSON.stringify({
           secret: c.sessionSecret(),
           origin: c.sessionSecretOrigin(),
           created: made.created,
         }))`,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          SESSION_SECRET: 'given-on-purpose',
          ENV_FILE: join(dir, 'no-such-env-file'),
          DB_PATH: join(dir, 'given', 'send2ereader.db'),
        } as NodeJS.ProcessEnv,
      }
    ).trim()

    expect(JSON.parse(out)).toEqual({
      secret: 'given-on-purpose',
      origin: 'environment',
      created: false,
    })
    expect(() => statSync(join(dir, 'given', 'session.key'))).toThrow()
  })

  it('has no accounts when they are turned off on purpose', () => {
    const out = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `const c = await import('./src/config.ts')
         c.provisionSessionSecret()
         console.log(JSON.stringify({ accounts: c.accountsEnabled() }))`,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          SESSION_SECRET: undefined,
          ACCOUNTS: 'false',
          ENV_FILE: join(dir, 'no-such-env-file'),
          DB_PATH: join(dir, 'off', 'send2ereader.db'),
        } as NodeJS.ProcessEnv,
      }
    ).trim()

    expect(JSON.parse(out).accounts).toBe(false)
  })
})
