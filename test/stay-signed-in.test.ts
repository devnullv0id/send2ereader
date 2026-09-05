import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

function signInWith(env: Record<string, string>): string {
  const snippet = `
    const { openDatabase } = await import('./src/db/index.ts')
    const { buildApp } = await import('./src/app.ts')
    const { prepareUploadDir } = await import('./src/files.ts')

    await prepareUploadDir(true)
    const db = openDatabase(':memory:')
    const app = await buildApp({
      tools: { kepubify: false, calibre: false, pdfcropmargins: false, kfxInput: false, layoutFix: false },
      logger: false,
      accounts: true,
      db,
    })
    await app.ready()

    const payload = { email: 'owner@example.com', password: 'a-perfectly-fine-password' }
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...payload, firstName: 'Ada', lastName: 'Lovelace' },
    })
    // Asks to stay signed in, explicitly, which is the interesting case.
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { ...payload, remember: true },
    })
    const status = await app.inject({ url: '/auth/status' })

    const raw = res.headers['set-cookie']
    const all = Array.isArray(raw) ? raw : [raw]
    console.log(JSON.stringify({
      cookie: String(all.find((c) => String(c).startsWith('s2e_session='))),
      staySignedIn: status.json().staySignedIn,
    }))

    await app.close()
    db.close()
  `

  return execFileSync(process.execPath, ['--import', 'tsx', '-e', snippet], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      ENV_FILE: 'test/no-such.env',
      LOG_LEVEL: 'silent',
      UPLOAD_DIR: 'uploads-test',
      KOBO_QUEUE_DIR: 'queue-test',
      SESSION_SECRET: 'test-secret-not-used-outside-the-suite',
      SCRYPT_N: '1024',
      ...env,
    } as NodeJS.ProcessEnv,
  }).trim()
}

describe('ALLOW_STAY_SIGNED_IN', () => {
  it('honours the request when the operator allows it', () => {
    const result = JSON.parse(signInWith({ ALLOW_STAY_SIGNED_IN: 'true' }))
    expect(result.staySignedIn, 'the pages are told to offer the choice').toBe(true)
    expect(result.cookie).toMatch(/Max-Age=\d+/)
  })

  it('refuses a lasting cookie when the operator turns it off', () => {
    const result = JSON.parse(signInWith({ ALLOW_STAY_SIGNED_IN: 'false' }))
    expect(result.staySignedIn, 'the pages are told to hide the choice').toBe(false)
    expect(result.cookie).toContain('s2e_session=')
    expect(result.cookie).not.toMatch(/Max-Age=/i)
    expect(result.cookie).not.toMatch(/Expires=/i)
  })

  it('offers the choice by default', () => {
    const result = JSON.parse(signInWith({}))
    expect(result.staySignedIn).toBe(true)
    expect(result.cookie).toMatch(/Max-Age=\d+/)
  })
})
