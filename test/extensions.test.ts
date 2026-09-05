import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Finishes, newlyFinished, parseProgress, runState } from '../src/admin/extensions.js'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { refreshTools } from '../src/convert/index.js'
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
  await rm(join(config.dataDir, 'extensions'), { recursive: true, force: true })
  db = openDatabase(':memory:')
  app = asBrowser(await buildApp({ tools: { ...noTools }, logger: false, accounts: true, db }))
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

async function join2(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
  })
  return cookieFrom(res)
}

async function ask(method: 'POST' | 'DELETE', id: string, cookie: string, token: string) {
  return await app.inject({
    method,
    url: `/api/admin/extensions/${id}`,
    headers: { cookie, 'x-csrf-token': token },
  })
}

async function csrf(cookie: string): Promise<string> {
  const res = await app.inject({ url: '/auth/status', headers: { cookie } })
  return (res.json() as { csrf: string }).csrf
}

describe('reading what the installer said', () => {
  it('starts with every stage waiting and calls that idle', () => {
    const progress = parseProgress('')
    expect(progress.stages.map((stage) => stage.state)).toEqual(Array(6).fill('waiting'))
    expect(progress.kind).toBeNull()
    expect(runState(progress)).toBe('idle')
  })

  it('keeps the last word on each stage, so a percentage does not linger past done', () => {
    const progress = parseProgress(
      ['packages running', 'packages done', 'download running 42', 'download running 73'].join('\n')
    )
    const byName = Object.fromEntries(progress.stages.map((stage) => [stage.name, stage]))

    expect(byName.packages?.state).toBe('done')
    expect(byName.packages?.percent).toBeNull()
    expect(byName.download?.state).toBe('running')
    expect(byName.download?.percent).toBe(73)
    expect(runState(progress)).toBe('running')
  })

  it('reports a failure with the reason the installer gave', () => {
    const progress = parseProgress(
      ['packages done', 'download failed that URL would not hand it over'].join('\n')
    )
    const download = progress.stages.find((stage) => stage.name === 'download')

    expect(download?.state).toBe('failed')
    expect(download?.detail).toBe('that URL would not hand it over')
    expect(runState(progress)).toBe('failed')
  })

  it('waits for the script to say it finished, rather than counting stages', () => {
    const all = ['packages', 'download', 'prefix', 'previewer', 'wire', 'verify']
    const everyStage = all.map((name) => `${name} done`).join('\n')

    expect(runState(parseProgress(everyStage))).toBe('running')
    expect(runState(parseProgress(`${everyStage}\nrun done`))).toBe('done')
  })

  it('calls a removal finished, though it never touches download or prefix', () => {
    const progress = parseProgress(
      [
        'run remove',
        'previewer done',
        'wire done',
        'packages done',
        'verify done',
        'run done',
      ].join('\n')
    )

    expect(progress.kind).toBe('remove')
    expect(progress.stages.find((stage) => stage.name === 'download')?.state).toBe('waiting')
    expect(runState(progress), 'this is what hung the page for ten minutes').toBe('done')
  })

  it('ignores lines that are not stages, so stray output cannot fake progress', () => {
    const progress = parseProgress(
      ['kfx: downloading: 42%', 'nonsense here', 'packages sideways', 'packages done'].join('\n')
    )
    expect(progress.stages.find((stage) => stage.name === 'packages')?.state).toBe('done')
    expect(runState(progress)).toBe('running')
  })
})

describe('deciding that something has finished', () => {
  const at = 1_000
  const marks = (pairs: Record<string, string>): Finishes => new Map(Object.entries(pairs))

  it('says no when nothing has ever finished', () => {
    expect(newlyFinished(null, marks({ calibre: '', pdfcrop: '', kfx: '' }), at)).toBe(false)
  })

  it('counts a run that ended while the server was still starting', () => {
    expect(newlyFinished(null, marks({ calibre: 'done@1500' }), at)).toBe(true)
  })

  it('ignores one that ended before this server looked', () => {
    expect(newlyFinished(null, marks({ calibre: 'done@500' }), at)).toBe(false)
  })

  it('notices the next one to finish, mid-queue', () => {
    const before = marks({ calibre: 'done@1100', pdfcrop: '', kfx: '' })
    const after = marks({ calibre: 'done@1100', pdfcrop: 'done@1200', kfx: '' })
    expect(newlyFinished(before, after, at), 'calibre must not wait for KFX').toBe(true)
  })

  it('stays quiet while nothing has changed', () => {
    const same = marks({ calibre: 'done@1100', pdfcrop: '', kfx: '' })
    expect(newlyFinished(same, marks({ calibre: 'done@1100', pdfcrop: '', kfx: '' }), at)).toBe(
      false
    )
  })

  it('counts a failure too, because what is installed changed either way', () => {
    const before = marks({ kfx: '' })
    expect(newlyFinished(before, marks({ kfx: 'failed@1300' }), at)).toBe(true)
  })

  it('notices the same extension finishing a second time', () => {
    const before = marks({ pdfcrop: 'done@1100' })
    expect(newlyFinished(before, marks({ pdfcrop: 'done@1900' }), at)).toBe(true)
  })
})

describe('re-detecting converters without a restart', () => {
  it('writes into the object the routes already hold, rather than replacing it', async () => {
    const tools = app.tools
    const same = await refreshTools(app.tools)

    expect(same, 'the same object, so every reader sees the change').toBe(tools)
    expect(app.tools).toBe(tools)
  })
})

describe('who may ask for an extension', () => {
  it('does not admit the page or the api exists to a second account', async () => {
    await join2('first@example.com')
    settings.set('ALLOW_SIGNUP', 'true', null)
    const other = await join2('second@example.com')

    const page = await app.inject({ url: '/admin/extensions', headers: { cookie: other } })
    const api = await app.inject({ url: '/api/admin/extensions', headers: { cookie: other } })

    expect(page.statusCode).toBe(404)
    expect(api.statusCode).toBe(404)
  })

  it('sends a signed-out visitor to sign in, and refuses the api outright', async () => {
    await join2('first@example.com')

    const page = await app.inject({ url: '/admin/extensions', headers: { accept: 'text/html' } })
    const api = await app.inject({ url: '/api/admin/extensions' })

    expect(page.statusCode).toBe(302)
    expect(page.headers.location).toBe('/login?next=%2Fadmin%2Fextensions')
    expect(api.statusCode).toBe(401)
  })

  it('lists every extension, in the order they depend on each other', async () => {
    const cookie = await join2('first@example.com')
    const res = await app.inject({ url: '/api/admin/extensions', headers: { cookie } })
    const body = res.json() as {
      extensions: { id: string; installed: boolean; blocked: string | null; stages: unknown[] }[]
    }

    expect(res.statusCode).toBe(200)
    expect(body.extensions.map((one) => one.id)).toEqual(['calibre', 'pdfcrop', 'kfx'])
    expect(body.extensions.every((one) => one.installed)).toBe(false)
    expect(body.extensions.find((one) => one.id === 'kfx')?.stages).toHaveLength(6)
  })

  it('says KFX is blocked while calibre is missing, and stops it being asked for', async () => {
    const cookie = await join2('first@example.com')
    const listed = await app.inject({ url: '/api/admin/extensions', headers: { cookie } })
    const kfx = (
      listed.json() as { extensions: { id: string; blocked: string | null }[] }
    ).extensions.find((one) => one.id === 'kfx')

    expect(kfx?.blocked).toMatch(/needs calibre/i)

    const asked = await app.inject({
      method: 'POST',
      url: '/api/admin/extensions/kfx',
      headers: { cookie, 'x-csrf-token': await csrf(cookie) },
    })
    expect(asked.statusCode).toBe(409)
    expect((asked.json() as { error: string }).error).toMatch(/needs calibre/i)
  })

  it('refuses an extension nobody has heard of', async () => {
    const cookie = await join2('first@example.com')
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/extensions/wat',
      headers: { cookie, 'x-csrf-token': await csrf(cookie) },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses to install what is already installed', async () => {
    const cookie = await join2('first@example.com')
    app.tools.calibre = true

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/extensions/calibre',
      headers: { cookie, 'x-csrf-token': await csrf(cookie) },
    })

    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toMatch(/already installed/i)
  })

  it('queues a second install rather than refusing it, as the assistant asks for three', async () => {
    const cookie = await join2('first@example.com')
    const token = await csrf(cookie)

    const first = await ask('POST', 'calibre', cookie, token)
    const second = await ask('POST', 'pdfcrop', cookie, token)

    expect(first.statusCode).toBe(200)
    expect(second.statusCode, 'the assistant would have lost this one').toBe(200)

    const listed = await app.inject({ url: '/api/admin/extensions', headers: { cookie } })
    const body = listed.json() as { busy: boolean; extensions: { id: string; pending: boolean }[] }
    expect(body.busy).toBe(true)
    expect(body.extensions.filter((one) => one.pending).map((one) => one.id)).toEqual([
      'calibre',
      'pdfcrop',
    ])
  })

  it('lets KFX through while calibre is still in the queue ahead of it', async () => {
    const cookie = await join2('first@example.com')
    const token = await csrf(cookie)

    expect((await ask('POST', 'calibre', cookie, token)).statusCode).toBe(200)

    const kfx = await ask('POST', 'kfx', cookie, token)
    expect(kfx.statusCode, 'waiting for calibre counts as having it').toBe(200)
  })

  it('refuses to ask for the same extension twice', async () => {
    const cookie = await join2('first@example.com')
    const token = await csrf(cookie)

    expect((await ask('POST', 'calibre', cookie, token)).statusCode).toBe(200)
    const again = await ask('POST', 'calibre', cookie, token)

    expect(again.statusCode).toBe(409)
    expect((again.json() as { error: string }).error).toMatch(/already on its way/i)
  })

  it('refuses to remove calibre while something still needs it', async () => {
    const cookie = await join2('first@example.com')
    app.tools.calibre = true
    app.tools.kfxOutput = true

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/extensions/calibre',
      headers: { cookie, 'x-csrf-token': await csrf(cookie) },
    })

    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toMatch(/Remove KFX/i)
  })
})
