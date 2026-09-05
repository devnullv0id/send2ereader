import { createServer, type Server } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { prepareUploadDir } from '../src/files.js'
import { DeliveryQueue } from '../src/kobo/queue.js'
import { asBrowser } from './helpers.js'

interface Seen {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

let store: Server
let seen: Seen[] = []
let storeBehaviour: 'ok' | 'hang' = 'ok'

const STORE_IMAGES = 'https://cdn.example-kobo.test/book-images'

beforeAll(async () => {
  store = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (storeBehaviour === 'hang') return

      if (req.url === '/v1/initialization') {
        res.setHeader('content-type', 'application/json')
        return res.end(
          JSON.stringify({
            Resources: {
              image_url_template: `${STORE_IMAGES}/{ImageId}/{Width}/{Height}/{IsGreyscale}/image.jpg`,
              image_url_quality_template: `${STORE_IMAGES}/{ImageId}/{Width}/{Height}/{Quality}/{IsGreyscale}/image.jpg`,
              something_we_do_not_serve: 'https://storeapi.kobo.com/v1/whatever',
            },
          })
        )
      }

      res.statusCode = 201
      res.setHeader('content-type', 'application/json')
      res.setHeader('x-kobo-something', 'from-the-store')
      res.end(JSON.stringify({ from: 'store', path: req.url }))
    })
  })
  await new Promise<void>((resolve) => store.listen(39217, '127.0.0.1', resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => store.close(() => resolve()))
})

const noTools = {
  kepubify: false,
  calibre: false,
  pdfcropmargins: false,
  kfxInput: false,
  kfxOutput: false,
  layoutFix: false,
}

let app: FastifyInstance
let db: Db

beforeEach(async () => {
  seen = []
  storeBehaviour = 'ok'
  await prepareUploadDir(true)
  await DeliveryQueue.prepare()
  db = openDatabase(':memory:')
  app = asBrowser(await buildApp({ tools: noTools, logger: false, accounts: true, db }))
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.close()
})

async function device(proxyStore = true) {
  const user = app.repos.users.create({
    email: 'owner@example.com',
    passwordHash: null,
    emailVerified: true,
  })
  return app.repos.devices.create(user.id, 'Clara', proxyStore)
}

describe('forwarding to the store', () => {
  it('passes an unrecognised path through, preserving the query', async () => {
    const { token } = await device()
    const res = await app.inject({ url: `/kobo/${token}/v1/user/profile?a=1&b=2` })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ from: 'store' })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('/v1/user/profile?a=1&b=2')
  })

  it('relays the method and the body', async () => {
    const { token } = await device()
    const res = await app.inject({
      method: 'POST',
      url: `/kobo/${token}/v1/analytics/event`,
      headers: { 'content-type': 'application/json' },
      payload: { hello: 'store' },
    })

    expect(res.statusCode).toBe(201)
    expect(seen[0]!.method).toBe('POST')
    expect(JSON.parse(seen[0]!.body)).toEqual({ hello: 'store' })
  })

  it('carries the device headers the store needs', async () => {
    const { token } = await device()
    await app.inject({
      url: `/kobo/${token}/v1/library/whatever`,
      headers: { authorization: 'Bearer kobo-token', 'x-kobo-deviceid': 'abc' },
    })

    expect(seen[0]!.headers.authorization).toBe('Bearer kobo-token')
    expect(seen[0]!.headers['x-kobo-deviceid']).toBe('abc')
  })

  it('never hands our session cookie to Rakuten', async () => {
    const { token } = await device()
    await app.inject({
      url: `/kobo/${token}/v1/library/whatever`,
      headers: {
        cookie: 's2e_session=this-is-ours-not-theirs',
        'x-kobo-deviceid': 'abc',
      },
    })

    expect(seen[0]!.headers.cookie, 'a browser on this site must not leak it').toBeUndefined()
    expect(seen[0]!.headers['x-kobo-deviceid'], 'what a Kobo needs still goes').toBe('abc')
  })

  it('forwards only what is on the list, not everything it failed to think of', async () => {
    const { token } = await device()
    await app.inject({
      url: `/kobo/${token}/v1/thing`,
      headers: {
        'x-forwarded-for': '10.0.0.1',
        'x-real-ip': '10.0.0.1',
        referer: 'https://send.example.com/settings',
        'x-csrf-token': 'ours',
      },
    })

    for (const header of ['x-forwarded-for', 'x-real-ip', 'referer', 'x-csrf-token']) {
      expect(seen[0]!.headers[header], header).toBeUndefined()
    }
  })

  it('rewrites Host so the store does not see ours', async () => {
    const { token } = await device()
    await app.inject({ url: `/kobo/${token}/v1/thing`, headers: { host: 'send.example.com' } })
    expect(seen[0]!.headers.host).not.toBe('send.example.com')
  })

  it('returns the store status and its headers', async () => {
    const { token } = await device()
    const res = await app.inject({ url: `/kobo/${token}/v1/thing` })
    expect(res.statusCode).toBe(201)
    expect(res.headers['x-kobo-something']).toBe('from-the-store')
  })

  it('does not relay hop-by-hop headers', async () => {
    const { token } = await device()
    await app.inject({
      url: `/kobo/${token}/v1/thing`,
      headers: { connection: 'keep-alive', 'transfer-encoding': 'chunked' },
    })
    expect(seen[0]!.headers['transfer-encoding']).toBeUndefined()
  })
})

describe('the routes this server implements always win', () => {
  it('handles sync itself rather than proxying it', async () => {
    const { token } = await device()
    const res = await app.inject({ url: `/kobo/${token}/v1/library/sync` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    expect(seen).toHaveLength(0)
  })

  it('handles the device check-in itself', async () => {
    const { token } = await device()
    const res = await app.inject({
      method: 'POST',
      url: `/kobo/${token}/v1/auth/device`,
      payload: { DeviceId: 'abc' },
    })
    expect(res.json().AccessToken).toBeTruthy()
    expect(seen).toHaveLength(0)
  })
})

describe('the per-device toggle', () => {
  it('refuses to forward for a device with the proxy off', async () => {
    const { token } = await device(false)
    const res = await app.inject({ url: `/kobo/${token}/v1/user/profile` })

    expect(res.statusCode).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it('still delivers books to a device with the proxy off', async () => {
    const { token } = await device(false)
    const res = await app.inject({ url: `/kobo/${token}/v1/library/sync` })
    expect(res.statusCode).toBe(200)
  })

  it('takes effect as soon as it is toggled', async () => {
    const { device: registered, token } = await device(true)
    expect((await app.inject({ url: `/kobo/${token}/v1/thing` })).statusCode).toBe(201)

    app.repos.devices.setProxyStore(registered.id, false)
    expect((await app.inject({ url: `/kobo/${token}/v1/thing` })).statusCode).toBe(404)
  })
})

describe('when the store is unreachable', () => {
  it('answers 502 rather than hanging the device', async () => {
    storeBehaviour = 'hang'
    const { token } = await device()

    const res = await app.inject({ url: `/kobo/${token}/v1/thing` })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toMatch(/could not be reached/i)
  })

  it('keeps serving books while the store is down', async () => {
    storeBehaviour = 'hang'
    const { token } = await device()
    expect((await app.inject({ url: `/kobo/${token}/v1/library/sync` })).statusCode).toBe(200)
  })
})

describe('cover images', () => {
  it("sends an image it does not recognise back to Kobo's own host", async () => {
    const { token } = await device()
    await app.inject({ url: `/kobo/${token}/v1/initialization` })
    const res = await app.inject({
      url: `/kobo/${token}/v1/books/some-kobo-id/thumbnail/300/400/false/image.jpg`,
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`${STORE_IMAGES}/some-kobo-id/300/400/false/image.jpg`)
  })

  it('handles the quality variant of the template too', async () => {
    const { token } = await device()
    await app.inject({ url: `/kobo/${token}/v1/initialization` })
    const res = await app.inject({
      url: `/kobo/${token}/v1/books/some-kobo-id/thumbnail/300/400/85/true/image.jpg`,
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`${STORE_IMAGES}/some-kobo-id/300/400/85/true/image.jpg`)
  })

  it("falls back to Kobo's CDN before initialization has primed the cache", async () => {
    const { token } = await device()
    const res = await app.inject({
      url: `/kobo/${token}/v1/books/some-kobo-id/thumbnail/300/400/false/image.jpg`,
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(
      'https://cdn.kobo.com/book-images/some-kobo-id/300/400/false/image.jpg'
    )
    expect(seen).toHaveLength(0)
  })

  it('does not proxy the image itself, only points at it', async () => {
    const { token } = await device()
    await app.inject({ url: `/kobo/${token}/v1/initialization` })
    await app.inject({
      url: `/kobo/${token}/v1/books/some-kobo-id/thumbnail/300/400/false/image.jpg`,
    })

    expect(seen.map((s) => s.url)).toEqual(['/v1/initialization'])
  })

  it('sends nothing to Kobo for a device with the proxy off', async () => {
    const { token } = await device(false)
    const res = await app.inject({
      url: `/kobo/${token}/v1/books/some-kobo-id/thumbnail/300/400/false/image.jpg`,
    })

    expect(res.statusCode).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it('refuses an unknown token before asking anything', async () => {
    const url = `/kobo/${'z'.repeat(32)}/v1/books/an-id/thumbnail/300/400/false/image.jpg`
    const res = await app.inject({ url })
    expect(res.statusCode).toBe(401)
    expect(seen).toHaveLength(0)
  })
})

describe('an unknown token never reaches the store', () => {
  it('rejects before forwarding', async () => {
    const res = await app.inject({ url: `/kobo/${'z'.repeat(32)}/v1/user/profile` })
    expect(res.statusCode).toBe(401)
    expect(seen).toHaveLength(0)
  })
})
