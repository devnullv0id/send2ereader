import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { prepareUploadDir } from '../src/files.js'
import {
  boundsFor,
  problemWith,
  SETTING_GROUPS,
  SETTING_SPECS,
  settings,
  specFor,
} from '../src/settings.js'
import { asBrowser } from './helpers.js'

const noTools = {
  kepubify: false,
  calibre: false,
  pdfcropmargins: false,
  kfxInput: false,
  kfxOutput: false,
  layoutFix: false,
}

const PASSWORD = 'a-perfectly-fine-password'

let app: FastifyInstance
let db: Db
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
      password: PASSWORD,
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

const put = (key: string, value: string) =>
  app.inject({
    method: 'PUT',
    url: '/api/admin/settings',
    headers: { cookie },
    payload: { key, value },
  })

const wipe = (key: string) =>
  app.inject({ method: 'DELETE', url: `/api/admin/settings/${key}`, headers: { cookie } })

describe('where a value comes from', () => {
  it('falls through to the environment when nothing is stored', () => {
    expect(settings.isOverridden('MIN_PASSWORD_LENGTH')).toBe(false)
    expect(settings.int('MIN_PASSWORD_LENGTH')).toBe(
      Number(settings.envValue('MIN_PASSWORD_LENGTH'))
    )
  })

  it('prefers a stored value over the environment', async () => {
    expect((await put('MIN_PASSWORD_LENGTH', '14')).statusCode).toBe(200)
    expect(settings.int('MIN_PASSWORD_LENGTH')).toBe(14)
    expect(settings.isOverridden('MIN_PASSWORD_LENGTH')).toBe(true)
  })

  it('goes back to the environment when the stored value is cleared', async () => {
    await put('MIN_PASSWORD_LENGTH', '14')
    expect((await wipe('MIN_PASSWORD_LENGTH')).statusCode).toBe(200)

    expect(settings.isOverridden('MIN_PASSWORD_LENGTH')).toBe(false)
    expect(settings.int('MIN_PASSWORD_LENGTH')).toBe(
      Number(settings.envValue('MIN_PASSWORD_LENGTH'))
    )
  })

  it('still reports what the environment said while it is overridden', async () => {
    const before = settings.envValue('SESSION_TTL')
    await put('SESSION_TTL', '900')

    expect(settings.int('SESSION_TTL')).toBe(900)
    expect(settings.envValue('SESSION_TTL'), 'Reset has to know what it goes back to').toBe(before)
  })

  it('forgets the override when the value is put back to what the environment says', async () => {
    const original = settings.envValue('SESSION_TTL')

    await put('SESSION_TTL', '900')
    expect(settings.isOverridden('SESSION_TTL')).toBe(true)

    await put('SESSION_TTL', original)

    expect(settings.isOverridden('SESSION_TTL'), 'same value, so nothing to override').toBe(false)
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'SESSION_TTL'").get(),
      'and no row left behind saying otherwise'
    ).toEqual({ n: 0 })
  })

  it('tells the page it is no longer overridden, so the label can go', async () => {
    const original = settings.envValue('SESSION_TTL')
    await put('SESSION_TTL', '900')

    const changed = (await put('SESSION_TTL', original)).json()
    const shown = changed.settings.find((s: { key: string }) => s.key === 'SESSION_TTL')

    expect(shown.overridden).toBe(false)
    expect(shown.value).toBe(original)
  })

  it('does the same for a secret put back to the environment value', async () => {
    const original = settings.envValue('OIDC_CLIENT_SECRET')

    await put('OIDC_CLIENT_SECRET', 'something-else')
    expect(settings.isOverridden('OIDC_CLIENT_SECRET')).toBe(true)

    await put('OIDC_CLIENT_SECRET', original)
    expect(settings.isOverridden('OIDC_CLIENT_SECRET')).toBe(false)
  })

  it('survives a reload from the database', async () => {
    await put('MIN_PASSWORD_LENGTH', '14')
    settings.reload()
    expect(settings.int('MIN_PASSWORD_LENGTH')).toBe(14)
  })
})

describe('what a value is allowed to be', () => {
  it('refuses a number outside the spec and keeps the old one', async () => {
    const res = await put('MIN_PASSWORD_LENGTH', '3')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('at least 8')
    expect(settings.isOverridden('MIN_PASSWORD_LENGTH')).toBe(false)
  })

  it('refuses something that is not a number at all', async () => {
    expect((await put('SESSION_TTL', 'soon')).statusCode).toBe(400)
  })

  it('refuses a key it does not know', async () => {
    expect((await put('NO_SUCH_SETTING', 'anything')).statusCode).toBe(404)
    expect((await put('PATH', '/etc')).statusCode).toBe(404)
  })

  it('never refuses the value the environment already has', () => {
    for (const spec of SETTING_SPECS) {
      const problem = problemWith(spec, spec.env())
      expect(problem, `${spec.key} ships with a value its own rule rejects`).toBeNull()
    }
  })

  it('widens its own floor to reach a lower value set in the environment', () => {
    const spec = { ...specFor('MIN_PASSWORD_LENGTH')!, env: () => '5' }

    expect(spec.min, 'the page would like at least eight').toBe(8)
    expect(boundsFor(spec).min, 'but five is what the environment says').toBe(5)
    expect(problemWith(spec, '6'), 'so six has to be reachable').toBeNull()
    expect(problemWith(spec, '5')).toBeNull()
    expect(problemWith(spec, '4'), 'below the environment is still refused').toBeTruthy()
  })

  it('widens its own ceiling the same way', () => {
    const spec = { ...specFor('FAILED_SIGNINS_BEFORE_ALERT')!, env: () => '40' }

    expect(spec.max).toBe(9)
    expect(boundsFor(spec).max).toBe(40)
    expect(problemWith(spec, '20')).toBeNull()
    expect(problemWith(spec, '41')).toBeTruthy()
  })

  it('leaves the bounds alone when the environment sits inside them', () => {
    const spec = { ...specFor('MIN_PASSWORD_LENGTH')!, env: () => '10' }
    expect(boundsFor(spec)).toEqual({ min: 8, max: 128 })
  })

  it('hands the page the widened bounds, not the wishful ones', async () => {
    const shown = (await app.inject({ url: '/api/admin/settings', headers: { cookie } })).json()
      .settings as { key: string; min: number | null; max: number | null }[]

    for (const spec of SETTING_SPECS) {
      if (spec.kind !== 'int') continue
      const field = shown.find((s) => s.key === spec.key)!
      const current = Number.parseInt(settings.raw(spec.key), 10)

      if (field.min !== null) {
        expect(current, `${spec.key} renders below its own min`).toBeGreaterThanOrEqual(field.min)
      }
      if (field.max !== null) {
        expect(current, `${spec.key} renders above its own max`).toBeLessThanOrEqual(field.max)
      }
    }
  })

  it('gives every spec a group that exists', () => {
    const groups = new Set(SETTING_GROUPS.map((group) => group.id))
    for (const spec of SETTING_SPECS) {
      expect(specFor(spec.key)).toBe(spec)
      expect(groups.has(spec.group), `${spec.key} sits in a group with no rail item`).toBe(true)
    }
  })

  it('leaves no group empty, which would draw a rail item leading nowhere', () => {
    const used = new Set(SETTING_SPECS.map((spec) => spec.group))
    for (const group of SETTING_GROUPS) {
      expect(used.has(group.id), `${group.id} has no settings in it`).toBe(true)
    }
  })

  it('offers a choice for every choice spec, and starts on one of them', () => {
    const choices = SETTING_SPECS.filter((spec) => spec.kind === 'choice')
    expect(choices.length).toBeGreaterThan(0)

    for (const spec of choices) {
      const allowed = (spec.choices ?? []).map((choice) => choice.value)
      expect(allowed.length, `${spec.key} is a choice of nothing`).toBeGreaterThan(1)
      expect(allowed, `${spec.key} starts on a value it does not offer`).toContain(spec.env())
      expect(problemWith(spec, spec.env())).toBeNull()
      expect(problemWith(spec, 'not-a-choice')).toBeTruthy()
    }
  })

  it('points every inlined spec at a real key in its own group', () => {
    for (const spec of SETTING_SPECS) {
      if (!spec.inlineWith) continue
      const host = specFor(spec.inlineWith)
      expect(host, `${spec.key} sits beside a key that does not exist`).toBeTruthy()
      expect(host?.group, `${spec.key} sits beside a key on another page`).toBe(spec.group)
      expect(host?.inlineWith, 'two specs cannot each be inlined into the other').toBeUndefined()
      expect(
        host?.kind,
        `${spec.key} would vanish: a choice draws no row for a companion`
      ).not.toBe('choice')
    }
  })
})

describe('the read-only tier', () => {
  const readOnly = SETTING_SPECS.filter((spec) => spec.readOnly)

  it('covers the keys that decide how the process starts and what protects it', () => {
    const keys = readOnly.map((spec) => spec.key)
    for (const key of [
      'SESSION_SECRET',
      'SCRYPT_N',
      'DB_PATH',
      'STATIC_DIR',
      'HTTP_ADDR',
      'HTTP_PORT',
      'LOCKED_SETTINGS',
      'ACCOUNTS',
      'KEPUBIFY_BIN',
      'EBOOK_CONVERT_BIN',
      'PDFCROPMARGINS_BIN',
      'CALIBRE_CUSTOMIZE_BIN',
      'EPUB_LAYOUT_FIX_BIN',
    ]) {
      expect(keys, `${key} is editable from a browser`).toContain(key)
    }
  })

  it('is refused by the route, not merely disabled on the page', async () => {
    for (const spec of readOnly) {
      const res = await put(spec.key, spec.kind === 'bool' ? 'true' : 'nonsense')
      expect(res.statusCode, `${spec.key} was accepted`).toBe(409)
      expect(res.json().error).toContain(spec.key)
      expect(settings.isOverridden(spec.key)).toBe(false)
    }
  })

  it('cannot be reset either, because there is nothing to reset', async () => {
    for (const spec of readOnly) {
      expect((await wipe(spec.key)).statusCode, spec.key).toBe(409)
    }
  })

  it('ignores a row somebody put in the database by hand', () => {
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'SCRYPT_N',
      '2',
      new Date().toISOString()
    )
    settings.reload()

    expect(settings.int('SCRYPT_N'), 'the environment still decides').toBe(
      Number(settings.envValue('SCRYPT_N'))
    )
    expect(settings.isOverridden('SCRYPT_N')).toBe(false)
  })

  it('tells the page which fields they are, and where each value came from', async () => {
    const shown = (await app.inject({ url: '/api/admin/settings', headers: { cookie } })).json()
      .settings as { key: string; readOnly: boolean; origin: string }[]

    expect(shown.filter((field) => field.readOnly)).toHaveLength(readOnly.length)
    for (const field of shown) {
      expect(['environment', 'default', 'generated'], field.key).toContain(field.origin)
    }
    expect(shown.find((field) => field.key === 'SCRYPT_N')?.origin).toBe('environment')
    expect(shown.find((field) => field.key === 'KEPUBIFY_BIN')?.origin).toBe('default')
  })

  it('never shows the session secret, only that there is one', async () => {
    const shown = (await app.inject({ url: '/api/admin/settings', headers: { cookie } })).json()
      .settings as { key: string; value: string; isSet: boolean }[]

    const secret = shown.find((field) => field.key === 'SESSION_SECRET')!
    expect(secret.value).toBe('')
    expect(secret.isSet).toBe(true)
  })
})

describe('a secret', () => {
  it('is never handed back to the page', async () => {
    await put('OIDC_CLIENT_SECRET', 'the-actual-secret')

    const res = await app.inject({ url: '/api/admin/settings', headers: { cookie } })
    expect(JSON.stringify(res.json())).not.toContain('the-actual-secret')

    const shown = res.json().settings.find((s: { key: string }) => s.key === 'OIDC_CLIENT_SECRET')
    expect(shown.value, 'the field shows nothing, only that something is set').toBe('')
    expect(shown.isSet).toBe(true)
  })

  it('is not stored in the clear either', async () => {
    await put('OIDC_CLIENT_SECRET', 'the-actual-secret')

    const row = db.prepare("SELECT value FROM settings WHERE key = 'OIDC_CLIENT_SECRET'").get() as {
      value: string
    }
    expect(row.value).not.toContain('the-actual-secret')
    expect(settings.str('OIDC_CLIENT_SECRET'), 'and it still reads back').toBe('the-actual-secret')
  })
})

describe('what the settings actually change', () => {
  it('a new minimum length is enforced on the very next registration', async () => {
    await put('ALLOW_SIGNUP', 'true')
    await put('MIN_PASSWORD_LENGTH', '20')

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'second@example.com',
        password: 'nineteen-chars-xx',
        firstName: 'Grace',
        lastName: 'Hopper',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('at least 20')
  })

  it('a complexity rule is enforced without a restart', async () => {
    await put('ALLOW_SIGNUP', 'true')
    await put('PASSWORD_REQUIRE_DIGIT', 'true')

    const refused = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'second@example.com',
        password: 'no-digits-in-here',
        firstName: 'Grace',
        lastName: 'Hopper',
      },
    })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error).toContain('a digit')

    const accepted = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'second@example.com',
        password: 'has-1-digit-in-here',
        firstName: 'Grace',
        lastName: 'Hopper',
      },
    })
    expect(accepted.statusCode).toBe(200)
  })

  it('closing registration shuts the door, and opening it again opens it', async () => {
    await put('ALLOW_SIGNUP', 'false')

    const shut = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'second@example.com',
        password: PASSWORD,
        firstName: 'Grace',
        lastName: 'Hopper',
      },
    })
    expect(shut.statusCode).toBe(403)

    await put('ALLOW_SIGNUP', 'true')
    const open = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'second@example.com',
        password: PASSWORD,
        firstName: 'Grace',
        lastName: 'Hopper',
      },
    })
    expect(open.statusCode).toBe(200)
  })

  it('tells the sign-in page the rules it should show', async () => {
    await put('MIN_PASSWORD_LENGTH', '16')
    await put('PASSWORD_REQUIRE_UPPER', 'true')

    const status = (await app.inject({ url: '/auth/status' })).json()
    expect(status.minPasswordLength).toBe(16)
    expect(status.passwordRules).toMatchObject({
      minLength: 16,
      needs: [{ id: 'upper', said: 'a capital letter' }],
    })
  })
})
