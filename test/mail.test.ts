import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { redactKoboToken } from '../src/app.js'
import { withoutTokens } from '../src/mail/index.js'

const SMTP_OK = {
  SMTP_ENABLED: 'true',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USERNAME: 'user@example.com',
  SMTP_PASSWORD: 'secret',
  SMTP_FROM_EMAIL: 'user@example.com',
  SMTP_FROM_NAME: 'Send to eReader',
}

const REPORT = `
  const { createMailer, smtpProblem, senderHeader } = await import('./src/mail/index.ts')
  const lines = []
  const log = {
    info: (o, m) => lines.push({ level: 'info', ...o, msg: m }),
    warn: (o, m) => lines.push({ level: 'warn', ...o, msg: m }),
    error: (o, m) => lines.push({ level: 'error', ...o, msg: m }),
  }
  const mailer = createMailer(log)
  console.log(JSON.stringify({
    enabled: mailer.enabled,
    problem: smtpProblem(),
    from: senderHeader(),
    lines,
  }))
`

function run(env: Record<string, string>): {
  enabled: boolean
  problem: string | null
  from: string
  lines: { level: string; msg?: string; problem?: string }[]
} {
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', REPORT], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ENV_FILE: 'does-not-exist', ...env },
  })
  return JSON.parse(out.trim().split('\n').pop()!)
}

describe('mailer selection', () => {
  it('logs links when SMTP is disabled', () => {
    const result = run({ SMTP_ENABLED: 'false' })
    expect(result.enabled).toBe(false)
    expect(result.problem).toBeNull()
  })

  it('uses SMTP when fully configured', () => {
    expect(run(SMTP_OK).enabled).toBe(true)
  })

  it('accepts the quoted style a .env is often written in', () => {
    const quoted = Object.fromEntries(Object.entries(SMTP_OK).map(([k, v]) => [k, `"${v}"`]))
    expect(run(quoted).enabled).toBe(true)
  })

  it.each([
    ['a missing host', { ...SMTP_OK, SMTP_HOST: '' }, /SMTP_HOST is empty/],
    ['a username with no password', { ...SMTP_OK, SMTP_PASSWORD: '' }, /SMTP_PASSWORD is empty/],
    [
      'no sender and nothing to infer one from',
      { ...SMTP_OK, SMTP_FROM_EMAIL: '', SMTP_USERNAME: '', SMTP_PASSWORD: '' },
      /no SMTP_FROM_EMAIL or SMTP_USERNAME/,
    ],
    [
      'a username that is not an address',
      { ...SMTP_OK, SMTP_FROM_EMAIL: '', SMTP_USERNAME: 'noreply' },
      /not an address to fall back to/,
    ],
  ])('falls back to logging on %s', (_label, env, expected) => {
    const result = run(env)
    expect(result.enabled).toBe(false)
    expect(result.problem).toMatch(expected)
    expect(result.lines.some((l) => l.level === 'error')).toBe(true)
  })

  it('sends as the login when no sender is configured', () => {
    const result = run({ ...SMTP_OK, SMTP_FROM_EMAIL: '' })
    expect(result.enabled).toBe(true)
    expect(result.problem).toBeNull()
    expect(result.from).toBe('Send to eReader <user@example.com>')
  })

  it('prefers an explicit sender over the login', () => {
    const result = run({ ...SMTP_OK, SMTP_FROM_EMAIL: 'books@example.com' })
    expect(result.from).toBe('Send to eReader <books@example.com>')
  })

  it('never puts the SMTP password in the log', () => {
    const result = run({ ...SMTP_OK, SMTP_PASSWORD: 'hunter2-do-not-log-me', SMTP_HOST: '' })
    expect(JSON.stringify(result)).not.toContain('hunter2-do-not-log-me')
  })
})

describe('transport shape', () => {
  const TRANSPORT = `
    const { config } = await import('./src/config.ts')
    // Mirrors how SmtpMailer builds its transport, so the port/TLS pairing is
    // asserted rather than assumed.
    console.log(JSON.stringify({
      secure: config.mail.tls && config.mail.port === 465,
      requireTLS: config.mail.tls && config.mail.port !== 465,
      port: config.mail.port,
    }))
  `

  function transport(env: Record<string, string>) {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', TRANSPORT], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ENV_FILE: 'does-not-exist', ...env },
    })
    return JSON.parse(out.trim())
  }

  it('uses implicit TLS on 465', () => {
    expect(transport({ SMTP_PORT: '465' })).toMatchObject({ secure: true, requireTLS: false })
  })

  it('uses STARTTLS on 587', () => {
    expect(transport({ SMTP_PORT: '587' })).toMatchObject({ secure: false, requireTLS: true })
  })

  it('uses STARTTLS on 25 as well', () => {
    expect(transport({ SMTP_PORT: '25' })).toMatchObject({ secure: false, requireTLS: true })
  })

  it('drops both when TLS is switched off', () => {
    expect(transport({ SMTP_PORT: '465', SMTP_TLS: 'false' })).toMatchObject({
      secure: false,
      requireTLS: false,
    })
  })
})

describe('what the log is allowed to keep', () => {
  it('takes the live credential out of a mailed link', () => {
    const body = [
      'Confirm your email',
      'http://localhost:3001/auth/verify?token=ZNFZAaDtCl-z7Kt-XZnFMAV1C8xEmapAsHyMW0Tn9jo',
      'The link expires in 24 hours.',
    ].join('\n')

    const out = withoutTokens(body)

    expect(out).not.toContain('ZNFZAaDtCl-z7Kt-XZnFMAV1C8xEmapAsHyMW0Tn9jo')
    expect(out, 'the shape of the message survives').toContain('/auth/verify?token=[redacted]')
    expect(out).toContain('The link expires in 24 hours.')
  })

  it('leaves a message with nothing to hide alone', () => {
    const plain = 'Your password was changed. If that was not you, reset it.'
    expect(withoutTokens(plain)).toBe(plain)
  })

  it('handles a token that is not the last thing on the line', () => {
    expect(withoutTokens('go to /auth/link?token=abc123&next=/settings now')).toBe(
      'go to /auth/link?token=[redacted]&next=/settings now'
    )
  })
})

describe('the kobo token never reaches the log', () => {
  it('keeps the path and drops the credential', () => {
    expect(
      redactKoboToken('/kobo/VP17_zr_UTixtPOr-hMIPFiCmIwwys2H1vt46Ob0GMU/v1/library/sync')
    ).toBe('/kobo/[redacted]/v1/library/sync')
    expect(redactKoboToken('/kobo/abc123/v1/initialization?x=1')).toBe(
      '/kobo/[redacted]/v1/initialization?x=1'
    )
  })

  it('leaves every other url exactly as it was', () => {
    for (const url of ['/settings', '/api/devices', '/download/book.epub?key=ABCD', '/kobonot']) {
      expect(redactKoboToken(url)).toBe(url)
    }
  })
})
