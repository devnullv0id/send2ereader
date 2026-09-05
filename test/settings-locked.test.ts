import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.LOCKED_SETTINGS = 'MIN_PASSWORD_LENGTH, OIDC_CLIENT_SECRET'
vi.resetModules()

const { buildApp } = await import('../src/app.js')
const { openDatabase } = await import('../src/db/index.js')
const { prepareUploadDir } = await import('../src/files.js')
const { settings, isLocked } = await import('../src/settings.js')
const { asBrowser } = await import('./helpers.js')

const noTools = {
  kepubify: false,
  calibre: false,
  pdfcropmargins: false,
  kfxInput: false,
  kfxOutput: false,
  layoutFix: false,
}

let app: FastifyInstance
let db: ReturnType<typeof openDatabase>
let cookie: string

beforeEach(async () => {
  await prepareUploadDir(true)
  db = openDatabase(':memory:')
  app = asBrowser(await buildApp({ tools: noTools, logger: false, accounts: true, db }))
  await app.ready()

  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: 'first@example.com',
      password: 'a-perfectly-fine-password',
      firstName: 'Ada',
      lastName: 'Lovelace',
    },
  })
  const raw = res.headers['set-cookie']
  cookie = (Array.isArray(raw) ? raw : [raw]).map((l) => String(l).split(';')[0]).join('; ')
})

afterEach(async () => {
  await app.close()
  db.close()
})

describe('a key locked in the environment', () => {
  it('is the one the environment named, and only that one', () => {
    expect(isLocked('MIN_PASSWORD_LENGTH')).toBe(true)
    expect(isLocked('OIDC_CLIENT_SECRET')).toBe(true)
    expect(isLocked('SESSION_TTL')).toBe(false)
  })

  it('cannot be set through the page', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie },
      payload: { key: 'MIN_PASSWORD_LENGTH', value: '30' },
    })

    expect(res.statusCode).toBe(409)
    expect(settings.int('MIN_PASSWORD_LENGTH')).toBe(
      Number(settings.envValue('MIN_PASSWORD_LENGTH'))
    )
  })

  it('cannot be reset through the page either', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/settings/MIN_PASSWORD_LENGTH',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(409)
  })

  it('is shown to the page as locked, so the field can say so', async () => {
    const res = await app.inject({ url: '/api/admin/settings', headers: { cookie } })
    const shown = res.json().settings as { key: string; locked: boolean }[]

    expect(shown.find((s) => s.key === 'MIN_PASSWORD_LENGTH')?.locked).toBe(true)
    expect(shown.find((s) => s.key === 'SESSION_TTL')?.locked).toBe(false)
  })

  it('wins even over a row that is already in the database', async () => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by)
       VALUES ('MIN_PASSWORD_LENGTH', '99', '2026-01-01T00:00:00.000Z', NULL)`
    ).run()
    settings.reload()

    expect(
      settings.int('MIN_PASSWORD_LENGTH'),
      'locking has to hold against a row written before the lock'
    ).toBe(Number(settings.envValue('MIN_PASSWORD_LENGTH')))
  })

  it('leaves the keys it did not name alone', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie },
      payload: { key: 'SESSION_TTL', value: '900' },
    })
    expect(res.statusCode).toBe(200)
    expect(settings.int('SESSION_TTL')).toBe(900)
  })
})
