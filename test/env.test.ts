import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 's2e-env-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function runWithEnvFile(
  contents: string | null,
  snippet: string,
  realEnv: Record<string, string> = {}
): string {
  const file = join(dir, `env-${Math.random().toString(36).slice(2)}`)
  if (contents !== null) writeFileSync(file, contents)

  return execFileSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      SESSION_SECRET: undefined,
      SCRYPT_N: undefined,
      ENV_FILE: file,
      ...realEnv,
    } as NodeJS.ProcessEnv,
  }).trim()
}

const PRINT = `
  const { config, envFileLoaded } = await import('./src/config.ts')
  console.log(JSON.stringify({
    loaded: envFileLoaded,
    port: config.httpPort,
    secret: config.auth.sessionSecretEnv,
    signup: config.auth.allowSignup,
    mail: config.mail,
    oidcEnabled: config.oidc.enabled,
  }))
`

describe('.env loading', () => {
  it('applies values from the file', () => {
    const out = runWithEnvFile(
      'HTTP_PORT=4321\nSESSION_SECRET=from-the-file\nALLOW_SIGNUP=true\n',
      PRINT
    )
    const result = JSON.parse(out)
    expect(result).toMatchObject({
      loaded: true,
      port: 4321,
      secret: 'from-the-file',
      signup: true,
    })
  })

  it('lets a real environment variable win over the file', () => {
    const out = runWithEnvFile('SESSION_SECRET=from-the-file\n', PRINT, {
      SESSION_SECRET: 'from-the-real-environment',
    })
    expect(JSON.parse(out).secret).toBe('from-the-real-environment')
  })

  it('runs normally when there is no file', () => {
    const result = JSON.parse(runWithEnvFile(null, PRINT))
    expect(result.loaded).toBe(false)
    expect(result.port).toBe(3001)
    expect(result.secret).toBe('')
  })

  it('ignores comments and blank lines', () => {
    const out = runWithEnvFile('# a comment\n\nHTTP_PORT=4322\n\n# another\n', PRINT)
    expect(JSON.parse(out).port).toBe(4322)
  })

  it('strips surrounding quotes, however the value arrives', () => {
    const quoted = JSON.parse(
      runWithEnvFile(null, PRINT, {
        SMTP_ENABLED: '"true"',
        SMTP_PORT: '"587"',
        SMTP_HOST: '"smtp.example.com"',
        SMTP_FROM_NAME: "'Send to eReader'",
      })
    )
    expect(quoted.mail).toMatchObject({
      enabled: true,
      port: 587,
      host: 'smtp.example.com',
      fromName: 'Send to eReader',
    })
  })

  it('leaves quotes that are part of the value alone', () => {
    const out = JSON.parse(runWithEnvFile(null, PRINT, { SMTP_PASSWORD: 'pa"ss' }))
    expect(out.mail.password).toBe('pa"ss')
  })

  it('ignores a trailing comment left on a quoted value', () => {
    const out = JSON.parse(
      runWithEnvFile(null, PRINT, {
        SMTP_PORT: '"587"                # SMTP server port: 25 | 465 | 587',
        SMTP_ENABLED: '"true"            # Enable outgoing email: true | false',
        SMTP_FROM_NAME: '"Send to eReader"   # Sender display name',
      })
    )
    expect(out.mail).toMatchObject({ port: 587, enabled: true, fromName: 'Send to eReader' })
  })

  it('does not cut an unquoted value at a #, which is legal in a password', () => {
    const out = JSON.parse(runWithEnvFile(null, PRINT, { SMTP_PASSWORD: 'has#hash' }))
    expect(out.mail.password).toBe('has#hash')
  })

  it('keeps the special characters a password needs', () => {
    const password = 'p@ss-w0rd!$%&'
    const out = runWithEnvFile(`SMTP_PASSWORD=${password}\n`, PRINT)
    expect(JSON.parse(out).mail.password).toBe(password)
  })

  it('truncates an unquoted value at a # but keeps a quoted one whole', () => {
    const password = 'has#hash'
    const bare = runWithEnvFile(`SMTP_PASSWORD=${password}\n`, PRINT)
    expect(JSON.parse(bare).mail.password).toBe('has')

    const quoted = runWithEnvFile(`SMTP_PASSWORD="${password}"\n`, PRINT)
    expect(JSON.parse(quoted).mail.password).toBe(password)
  })

  it('starts anyway when the file cannot be parsed', () => {
    const out = runWithEnvFile('this is not = a valid = line\x00\n', PRINT, { HTTP_PORT: '4323' })
    expect(JSON.parse(out.split('\n').pop()!).port).toBe(4323)
  })
})

describe('.env.example', () => {
  const namesReadUnder = async (dir: string): Promise<Set<string>> => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')

    const found = new Set<string>()
    const walk = (here: string): void => {
      for (const entry of readdirSync(here)) {
        const path = join(here, entry)
        if (statSync(path).isDirectory()) {
          walk(path)
          continue
        }
        if (!path.endsWith('.ts')) continue

        const source = readFileSync(path, 'utf8')
        const readers = /(?:str|int|bool|dir|args|choice|maybeBool)\(\s*'([A-Z0-9_]+)'/g
        for (const m of source.matchAll(readers)) found.add(m[1]!)
        for (const m of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) found.add(m[1]!)
        for (const m of source.matchAll(/process\.env\[\s*'([A-Z0-9_]+)'/g)) found.add(m[1]!)
      }
    }
    walk(dir)
    return found
  }

  const IGNORED = new Set(['NODE_ENV', 'CI'])

  const documents = (example: string, name: string): boolean =>
    new RegExp(`^#?\\s*${name}=`, 'm').test(example)

  it('documents every variable anything under src reads', async () => {
    const { readFileSync } = await import('node:fs')
    const example = readFileSync('.env.example', 'utf8')

    const used = [...(await namesReadUnder('src'))].filter((name) => !IGNORED.has(name))
    expect(used.length, 'the scan found nothing, so it is not proving anything').toBeGreaterThan(30)

    const undocumented = used.filter((name) => !documents(example, name)).sort()
    expect(undocumented).toEqual([])
  })

  it('documents every key the admin page can set', async () => {
    const { readFileSync } = await import('node:fs')
    const example = readFileSync('.env.example', 'utf8')
    const { SETTING_SPECS } = await import('../src/settings.js')

    const undocumented = SETTING_SPECS.map((spec) => spec.key)
      .filter((key) => !documents(example, key))
      .sort()
    expect(undocumented).toEqual([])
  })

  it('never shows a quoted value, having said not to quote them', async () => {
    const { readFileSync } = await import('node:fs')
    const example = readFileSync('.env.example', 'utf8')

    expect(example, 'the rule itself').toContain('Values must NOT be quoted')

    const quoted = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)="/gm)].map((m) => m[1])
    expect(quoted, 'docker run --env-file would keep the quotes').toEqual([])
  })
})
