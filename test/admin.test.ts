import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { maskEmail } from '../src/admin/routes.js'
import { buildApp } from '../src/app.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { prepareUploadDir } from '../src/files.js'
import { settings } from '../src/settings.js'
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

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const all = Array.isArray(raw) ? raw : [raw]
  return all.map((line) => String(line).split(';')[0]).join('; ')
}

async function join(email: string, firstName = 'Ada', lastName = 'Lovelace') {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, firstName, lastName },
  })
  return { cookie: cookieFrom(res), id: app.repos.users.byEmail(email)!.id }
}

async function open() {
  settings.set('ALLOW_SIGNUP', 'true', null)
}

describe('who the admin page opens for', () => {
  it('opens for the first account', async () => {
    const founder = await join('first@example.com')
    const res = await app.inject({ url: '/admin', headers: { cookie: founder.cookie } })
    expect(res.statusCode).toBe(200)
  })

  it('is not there at all for a second account', async () => {
    await join('first@example.com')
    await open()
    const other = await join('second@example.com')

    const page = await app.inject({ url: '/admin', headers: { cookie: other.cookie } })
    const api = await app.inject({ url: '/api/admin/settings', headers: { cookie: other.cookie } })

    expect(page.statusCode, 'a page they may not have should not admit it exists').toBe(404)
    expect(api.statusCode).toBe(404)
  })

  it('sends a signed-out visitor to sign in, and refuses the api outright', async () => {
    await join('first@example.com')

    const page = await app.inject({ url: '/admin', headers: { accept: 'text/html' } })
    expect(page.statusCode).toBe(302)
    expect(page.headers.location).toBe('/login?next=%2Fadmin')

    expect((await app.inject({ url: '/api/admin/users' })).statusCode).toBe(401)
  })

  it('opens once the first account grants it', async () => {
    const founder = await join('first@example.com')
    await open()
    const other = await join('second@example.com')

    const granted = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${other.id}/admin`,
      headers: { cookie: founder.cookie },
      payload: { isAdmin: true },
    })
    expect(granted.statusCode).toBe(200)

    const res = await app.inject({ url: '/admin', headers: { cookie: other.cookie } })
    expect(res.statusCode).toBe(200)
  })

  it('will not let anyone take admin from the first account', async () => {
    const founder = await join('first@example.com')

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${founder.id}/admin`,
      headers: { cookie: founder.cookie },
      payload: { isAdmin: false },
    })

    expect(res.statusCode, 'the page that configures SSO must not be lockable').toBe(409)
    expect(app.repos.users.canAdmin(founder.id)).toBe(true)
  })

  it('will not let a granted admin demote the first account either', async () => {
    const founder = await join('first@example.com')
    await open()
    const other = await join('second@example.com')
    app.repos.users.setAdmin(other.id, true)

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${founder.id}/admin`,
      headers: { cookie: other.cookie },
      payload: { isAdmin: false },
    })
    expect(res.statusCode).toBe(409)
    expect(app.repos.users.canAdmin(founder.id)).toBe(true)
  })

  it('passes admin to the oldest account left if the first one goes', async () => {
    const founder = await join('first@example.com')
    await open()
    const second = await join('second@example.com')

    const promoted = app.repos.users.remove(founder.id)

    expect(promoted, 'the handover is announced, not inferred').toBe(second.id)
    expect(app.repos.users.isFounder(second.id)).toBe(true)
    expect(app.repos.users.canAdmin(second.id), 'never nobody').toBe(true)
    expect(app.repos.users.byId(second.id)?.isAdmin, 'written down, not derived').toBe(true)
  })

  it('will not let the first account delete itself while anyone else is here', async () => {
    const founder = await join('first@example.com')
    await open()
    const second = await join('second@example.com')

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/account',
      headers: { cookie: founder.cookie },
      payload: { password: PASSWORD },
    })

    expect(res.statusCode).toBe(409)
    expect(app.repos.users.byId(founder.id), 'still there').not.toBeNull()
    expect(app.repos.users.canAdmin(second.id), 'nobody was promoted behind their back').toBe(false)
  })
})

describe('the list of people', () => {
  it('masks the address but not the name', async () => {
    const founder = await join('first@example.com', 'Grace', 'Hopper')
    const res = await app.inject({ url: '/api/admin/users', headers: { cookie: founder.cookie } })

    const [person] = res.json().users
    expect(person.email, 'the whole address never leaves the server').toBe('f•••@e•••.com')
    expect(person.firstName).toBe('Grace')
    expect(person.lastName).toBe('Hopper')
    expect(JSON.stringify(res.json())).not.toContain('first@example.com')
  })

  it('never hands over a hash or a two-factor secret', async () => {
    const founder = await join('first@example.com')
    const res = await app.inject({ url: '/api/admin/users', headers: { cookie: founder.cookie } })

    const body = JSON.stringify(res.json())
    expect(body).not.toContain('scrypt$')
    expect(body).not.toContain('passwordHash')
    expect(body).not.toContain('totpSecret')
  })

  it('says who is the first account and who was granted admin', async () => {
    const founder = await join('first@example.com')
    await open()
    const other = await join('second@example.com')
    app.repos.users.setAdmin(other.id, true)

    const res = await app.inject({ url: '/api/admin/users', headers: { cookie: founder.cookie } })
    const people = res.json().users as { id: string; isFounder: boolean; isAdmin: boolean }[]

    expect(people.find((p) => p.id === founder.id)).toMatchObject({
      isFounder: true,
      isAdmin: true,
    })
    expect(people.find((p) => p.id === other.id)).toMatchObject({
      isFounder: false,
      isAdmin: true,
    })
  })
})

describe('masking an address', () => {
  it('keeps the first letter and the top-level domain, and nothing else', () => {
    expect(maskEmail('matthias@example.de')).toBe('m•••@e•••.de')
    expect(maskEmail('a@b.co.uk')).toBe('a•••@b•••.uk')
  })

  it('gives nothing away when there is nothing to mask', () => {
    expect(maskEmail('@example.com')).toBe('•••')
    expect(maskEmail('nonsense')).toBe('•••')
  })
})

describe('deleting somebody', () => {
  it('removes the account and its books', async () => {
    const founder = await join('first@example.com')
    await open()
    const other = await join('second@example.com')

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${other.id}`,
      headers: { cookie: founder.cookie },
    })

    expect(res.statusCode).toBe(200)
    expect(app.repos.users.byId(other.id)).toBeNull()
  })

  it('refuses the first account and refuses you', async () => {
    const founder = await join('first@example.com')

    const self = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${founder.id}`,
      headers: { cookie: founder.cookie },
    })
    expect(self.statusCode, 'that is what Settings is for').toBe(409)
    expect(app.repos.users.byId(founder.id)).not.toBeNull()
  })

  it('does not let a second admin delete the first account', async () => {
    const founder = await join('first@example.com')
    await open()
    const other = await join('second@example.com')
    app.repos.users.setAdmin(other.id, true)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${founder.id}`,
      headers: { cookie: other.cookie },
    })
    expect(res.statusCode).toBe(409)
    expect(app.repos.users.byId(founder.id)).not.toBeNull()
  })

  it('is refused for someone who is not an admin', async () => {
    const founder = await join('first@example.com')
    await open()
    const other = await join('second@example.com')

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${founder.id}`,
      headers: { cookie: other.cookie },
    })
    expect(res.statusCode).toBe(404)
    expect(app.repos.users.byId(founder.id)).not.toBeNull()
  })
})
