import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectContainer, restarter } from '../src/admin/restart.js'
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
let cookie: string
let asked: number

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  return (Array.isArray(raw) ? raw : [raw]).map((l) => String(l).split(';')[0]).join('; ')
}

beforeEach(async () => {
  await prepareUploadDir(true)
  db = openDatabase(':memory:')
  app = asBrowser(await buildApp({ tools: noTools, logger: false, accounts: true, db }))
  await app.ready()

  asked = 0
  restarter.restart = () => {
    asked++
  }

  cookie = cookieFrom(
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'first@example.com',
        password: PASSWORD,
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
    })
  )
})

afterEach(async () => {
  await app.close()
  db.close()
})

const ask = () => app.inject({ method: 'POST', url: '/api/admin/restart', headers: { cookie } })

describe('asking the server to restart', () => {
  it('refuses when nothing would bring it back', async () => {
    restarter.canRestart = false
    const res = await ask()

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('not running in a container')
    expect(asked, 'and it really did not ask').toBe(0)
  })

  it('asks for a shutdown when it is running in a container', async () => {
    restarter.canRestart = true
    const res = await ask()

    expect(res.statusCode).toBe(200)
    await new Promise((r) => setTimeout(r, 250))
    expect(asked).toBe(1)
  })

  it('is refused for someone who is not an admin', async () => {
    restarter.canRestart = true
    settings.set('ALLOW_SIGNUP', 'true', null)

    const other = cookieFrom(
      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'second@example.com',
          password: PASSWORD,
          firstName: 'Grace',
          lastName: 'Hopper',
        },
      })
    )

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/restart',
      headers: { cookie: other },
    })
    expect(res.statusCode).toBe(404)
    await new Promise((r) => setTimeout(r, 250))
    expect(asked, 'a non-admin cannot take the server down').toBe(0)
  })

  it('is refused for somebody signed out', async () => {
    restarter.canRestart = true
    const res = await app.inject({ method: 'POST', url: '/api/admin/restart' })

    expect(res.statusCode).toBe(401)
    await new Promise((r) => setTimeout(r, 250))
    expect(asked).toBe(0)
  })

  it('tells the page whether the button is worth showing', async () => {
    restarter.canRestart = false
    const off = await app.inject({ url: '/api/admin/settings', headers: { cookie } })
    expect(off.json().canRestart).toBe(false)

    restarter.canRestart = true
    const on = await app.inject({ url: '/api/admin/settings', headers: { cookie } })
    expect(on.json().canRestart).toBe(true)
  })
})

describe('working out whether this is a container', () => {
  it('says no on a machine that is not one', () => {
    const found = detectContainer()
    expect(found.inContainer, 'this test host is not a container').toBe(false)
    expect(found.evidence).toBe('')
  })
})
