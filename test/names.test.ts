import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { prepareUploadDir } from '../src/files.js'
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

beforeEach(async () => {
  await prepareUploadDir(true)
  db = openDatabase(':memory:')
  app = asBrowser(await buildApp({ tools: noTools, logger: false, accounts: true, db }))
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.close()
})

const create = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/auth/register', payload })

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  return (Array.isArray(raw) ? raw : [raw]).map((l) => String(l).split(';')[0]).join('; ')
}

describe('a name on a new account', () => {
  it('is kept, and comes back with the account', async () => {
    const res = await create({
      email: 'a@example.com',
      password: PASSWORD,
      firstName: 'Grace',
      lastName: 'Hopper',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ firstName: 'Grace', lastName: 'Hopper' })
  })

  it('is required, and says which half is missing', async () => {
    const neither = await create({ email: 'a@example.com', password: PASSWORD })
    expect(neither.statusCode).toBe(400)
    expect(neither.json().error).toContain('first name')

    const half = await create({ email: 'a@example.com', password: PASSWORD, firstName: 'Grace' })
    expect(half.statusCode).toBe(400)
    expect(half.json().error).toContain('last name')
  })

  it('is not satisfied by spaces', async () => {
    const res = await create({
      email: 'a@example.com',
      password: PASSWORD,
      firstName: '   ',
      lastName: '  ',
    })
    expect(res.statusCode).toBe(400)
  })

  it('is trimmed on the way in', async () => {
    const res = await create({
      email: 'a@example.com',
      password: PASSWORD,
      firstName: '  Grace ',
      lastName: ' Hopper  ',
    })
    expect(res.json().user).toMatchObject({ firstName: 'Grace', lastName: 'Hopper' })
  })

  it('leaves no account behind when it is refused', async () => {
    await create({ email: 'a@example.com', password: PASSWORD })
    expect(app.repos.users.byEmail('a@example.com')).toBeNull()
  })
})

describe('a name on an account that has none', () => {
  it('can be given later without signing in again', async () => {
    const made = await create({
      email: 'a@example.com',
      password: PASSWORD,
      firstName: 'Grace',
      lastName: 'Hopper',
    })
    const cookie = cookieFrom(made)

    const res = await app.inject({
      method: 'POST',
      url: '/auth/name',
      headers: { cookie },
      payload: { firstName: 'Ada', lastName: 'Lovelace' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace' })
    expect(app.repos.users.byEmail('a@example.com')).toMatchObject({ firstName: 'Ada' })
  })

  it('is refused when empty, so nobody can blank it out', async () => {
    const cookie = cookieFrom(
      await create({
        email: 'a@example.com',
        password: PASSWORD,
        firstName: 'Grace',
        lastName: 'Hopper',
      })
    )

    const res = await app.inject({
      method: 'POST',
      url: '/auth/name',
      headers: { cookie },
      payload: { firstName: '', lastName: '' },
    })

    expect(res.statusCode).toBe(400)
    expect(app.repos.users.byEmail('a@example.com')).toMatchObject({ firstName: 'Grace' })
  })

  it('cannot be set by somebody who is not signed in', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/name',
      payload: { firstName: 'Ada', lastName: 'Lovelace' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('starts empty for an account that arrived through SSO', () => {
    const user = app.repos.users.create({
      email: 'sso@example.com',
      passwordHash: null,
    })
    expect(user.firstName).toBe('')
    expect(user.lastName).toBe('')
  })
})
