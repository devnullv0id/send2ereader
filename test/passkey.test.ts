import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { totpAt } from '../src/auth/totp.js'
import { relyingParty } from '../src/auth/webauthn.js'
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

const EMAIL = 'owner@example.com'
const PASSWORD = 'a-perfectly-fine-password'

const b64url = (b: Buffer) => b.toString('base64url')

function cborBytes(payload: Buffer): Buffer {
  if (payload.length < 24) return Buffer.concat([Buffer.from([0x40 + payload.length]), payload])
  if (payload.length < 256) {
    return Buffer.concat([Buffer.from([0x58, payload.length]), payload])
  }
  const header = Buffer.alloc(3)
  header[0] = 0x59
  header.writeUInt16BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

const cborText = (text: string) =>
  Buffer.concat([Buffer.from([0x60 + text.length]), Buffer.from(text, 'ascii')])

function coseKey(x: Buffer, y: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0xa5]),
    Buffer.from([0x01]),
    Buffer.from([0x02]),
    Buffer.from([0x03]),
    Buffer.from([0x26]),
    Buffer.from([0x20]),
    Buffer.from([0x01]),
    Buffer.from([0x21]),
    cborBytes(x),
    Buffer.from([0x22]),
    cborBytes(y),
  ])
}

function authData(rpId: string, flags: number, counter: number, attested?: Buffer): Buffer {
  const head = Buffer.alloc(37)
  createHash('sha256').update(rpId).digest().copy(head, 0)
  head[32] = flags
  head.writeUInt32BE(counter, 33)
  return attested ? Buffer.concat([head, attested]) : head
}

class VirtualAuthenticator {
  readonly credentialId = randomBytes(32)
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  counter = 0

  private point(): { x: Buffer; y: Buffer } {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    return { x: Buffer.from(jwk.x, 'base64url'), y: Buffer.from(jwk.y, 'base64url') }
  }

  register(challenge: string, origin: string, rpId: string) {
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false })
    )

    const { x, y } = this.point()
    const idLength = Buffer.alloc(2)
    idLength.writeUInt16BE(this.credentialId.length)
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, coseKey(x, y)])

    const data = authData(rpId, 0x45, this.counter, attested)
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]),
      cborText('fmt'),
      cborText('none'),
      cborText('attStmt'),
      Buffer.from([0xa0]),
      cborText('authData'),
      cborBytes(data),
    ])

    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
    }
  }

  assert(challenge: string, origin: string, rpId: string, userId: string) {
    this.counter += 1
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false })
    )
    const data = authData(rpId, 0x05, this.counter)
    const signature = createSign('sha256')
      .update(Buffer.concat([data, createHash('sha256').update(clientData).digest()]))
      .sign(this.keys.privateKey)

    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(data),
        signature: b64url(signature),
        userHandle: b64url(Buffer.from(userId, 'utf8')),
      },
    }
  }
}

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
  return (
    all
      .map(String)
      .find((c) => c.startsWith('s2e_session='))
      ?.split(';')[0] ?? ''
  )
}

async function signedIn() {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email: EMAIL, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
  })
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL) as { id: string }
  return { cookie: cookieFrom(res), userId: user.id }
}

async function enrol(label = 'This computer') {
  const { cookie, userId } = await signedIn()
  const rp = relyingParty()

  const options = await app.inject({
    method: 'POST',
    url: '/auth/passkeys/options',
    headers: { cookie },
  })
  const challenge = options.json().options.challenge as string

  const key = new VirtualAuthenticator()
  const created = await app.inject({
    method: 'POST',
    url: '/auth/passkeys',
    headers: { cookie: cookieFrom(options) || cookie },
    payload: { response: key.register(challenge, rp.origin, rp.id), label },
  })

  return { cookie, userId, key, rp, created, optionsRes: options }
}

async function signInWith(
  key: VirtualAuthenticator,
  userId: string,
  rp: { id: string; origin: string }
) {
  const options = await app.inject({ method: 'POST', url: '/auth/passkey/login' + '/options' })
  const challenge = options.json().options.challenge as string
  return app.inject({
    method: 'POST',
    url: '/auth/passkey/login',
    headers: { cookie: cookieFrom(options) },
    payload: { response: key.assert(challenge, rp.origin, rp.id, userId) },
  })
}

describe('registering a passkey', () => {
  it('accepts a credential the browser really signed, and keeps its name', async () => {
    const { created } = await enrol('My laptop')

    expect(created.statusCode).toBe(200)
    expect(created.json().passkey.label).toBe('My laptop')
    expect(created.json().passkey.id).toBeTruthy()
  })

  it('stores the public key and no private material', async () => {
    const { key } = await enrol()
    const row = db.prepare('SELECT * FROM passkeys').get() as {
      id: string
      public_key: string
      counter: number
    }
    expect(row.id).toBe(key.credentialId.toString('base64url'))
    expect(row.public_key).toBeTruthy()
    expect(row.public_key).not.toContain('PRIVATE')
  })

  it('lists it against the account that made it', async () => {
    const { cookie } = await enrol('Work phone')
    const res = await app.inject({ url: '/auth/passkeys', headers: { cookie } })
    expect(res.json().passkeys).toHaveLength(1)
    expect(res.json().passkeys[0].label).toBe('Work phone')
  })

  it('refuses a response signed against a different challenge', async () => {
    const { cookie } = await signedIn()
    const rp = relyingParty()
    const options = await app.inject({
      method: 'POST',
      url: '/auth/passkeys/options',
      headers: { cookie },
    })

    const key = new VirtualAuthenticator()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/passkeys',
      headers: { cookie: cookieFrom(options) },
      payload: { response: key.register(b64url(randomBytes(32)), rp.origin, rp.id), label: 'x' },
    })

    expect(res.statusCode).toBe(400)
    expect(db.prepare('SELECT COUNT(*) AS n FROM passkeys').get()).toMatchObject({ n: 0 })
  })

  it('refuses a response that names a different site', async () => {
    const { cookie } = await signedIn()
    const rp = relyingParty()
    const options = await app.inject({
      method: 'POST',
      url: '/auth/passkeys/options',
      headers: { cookie },
    })
    const challenge = options.json().options.challenge as string

    const key = new VirtualAuthenticator()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/passkeys',
      headers: { cookie: cookieFrom(options) },
      payload: {
        response: key.register(challenge, 'https://phishing.example', rp.id),
        label: 'x',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(db.prepare('SELECT COUNT(*) AS n FROM passkeys').get()).toMatchObject({ n: 0 })
  })

  it('spends the challenge, so the same response cannot be sent twice', async () => {
    const { cookie } = await signedIn()
    const rp = relyingParty()
    const options = await app.inject({
      method: 'POST',
      url: '/auth/passkeys/options',
      headers: { cookie },
    })
    const challenge = options.json().options.challenge as string
    const key = new VirtualAuthenticator()
    const response = key.register(challenge, rp.origin, rp.id)

    const first = await app.inject({
      method: 'POST',
      url: '/auth/passkeys',
      headers: { cookie: cookieFrom(options) },
      payload: { response, label: 'x' },
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'POST',
      url: '/auth/passkeys',
      headers: { cookie: cookieFrom(first) || cookieFrom(options) },
      payload: { response, label: 'x' },
    })
    expect(second.statusCode).not.toBe(200)
  })
})

describe('signing in with a passkey', () => {
  it('signs in without the password ever being sent', async () => {
    const { key, userId, rp } = await enrol()
    const res = await signInWith(key, userId, rp)

    expect(res.statusCode).toBe(200)
    expect(res.json().user.email).toBe(EMAIL)

    const status = await app.inject({ url: '/auth/status', headers: { cookie: cookieFrom(res) } })
    expect(status.json().user.email).toBe(EMAIL)
  })

  it('records the counter the authenticator reported', async () => {
    const { key, userId, rp } = await enrol()
    await signInWith(key, userId, rp)

    const row = db.prepare('SELECT counter, last_used_at FROM passkeys').get() as {
      counter: number
      last_used_at: string | null
    }
    expect(row.counter).toBe(1)
    expect(row.last_used_at).not.toBeNull()
  })

  it('refuses an assertion whose signature does not match the stored key', async () => {
    const { userId, rp, key } = await enrol()

    const impostor = new VirtualAuthenticator()
    Object.defineProperty(impostor, 'credentialId', { value: key.credentialId })

    const res = await signInWith(impostor, userId, rp)
    expect(res.statusCode).toBe(401)
  })

  it('refuses an assertion for a credential this server never saw', async () => {
    const { userId, rp } = await enrol()
    const stranger = new VirtualAuthenticator()
    const res = await signInWith(stranger, userId, rp)
    expect(res.statusCode).toBe(401)
  })

  it('refuses an assertion made against another origin', async () => {
    const { key, userId, rp } = await enrol()
    const options = await app.inject({ method: 'POST', url: '/auth/passkey/login/options' })
    const challenge = options.json().options.challenge as string

    const res = await app.inject({
      method: 'POST',
      url: '/auth/passkey/login',
      headers: { cookie: cookieFrom(options) },
      payload: { response: key.assert(challenge, 'https://phishing.example', rp.id, userId) },
    })
    expect(res.statusCode).toBe(401)
  })

  it('refuses a replay of an assertion that already worked', async () => {
    const { key, userId, rp } = await enrol()
    const options = await app.inject({ method: 'POST', url: '/auth/passkey/login/options' })
    const challenge = options.json().options.challenge as string
    const response = key.assert(challenge, rp.origin, rp.id, userId)

    const first = await app.inject({
      method: 'POST',
      url: '/auth/passkey/login',
      headers: { cookie: cookieFrom(options) },
      payload: { response },
    })
    expect(first.statusCode).toBe(200)

    const replay = await app.inject({
      method: 'POST',
      url: '/auth/passkey/login',
      headers: { cookie: cookieFrom(options) },
      payload: { response },
    })
    expect(replay.statusCode, 'the challenge was spent on the first attempt').not.toBe(200)
  })

  it('refuses a user handle that points at somebody else', async () => {
    const { key, rp } = await enrol()
    db.prepare(
      `INSERT INTO users (id, email, email_verified, password_hash, created_at)
       VALUES ('someone-else', 'them@example.com', 1, NULL, '2026-01-01T00:00:00.000Z')`
    ).run()

    const res = await signInWith(key, 'someone-else', rp)
    expect(res.statusCode).toBe(401)
  })
})

describe('removing a passkey', () => {
  it('takes it off the account, and it stops signing anybody in', async () => {
    const { cookie, key, userId, rp } = await enrol()
    const id = key.credentialId.toString('base64url')

    const res = await app.inject({
      method: 'DELETE',
      url: `/auth/passkeys/${encodeURIComponent(id)}`,
      headers: { cookie },
      payload: { password: PASSWORD },
    })
    expect(res.statusCode).toBe(200)
    expect(db.prepare('SELECT COUNT(*) AS n FROM passkeys').get()).toMatchObject({ n: 0 })

    const after = await signInWith(key, userId, rp)
    expect(after.statusCode).toBe(401)
  })
})

describe('a passkey when two-factor is on', () => {
  it('does not walk past the second factor the way it used to', async () => {
    const { cookie, key, userId, rp } = await enrol()
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId)

    const begin = await app.inject({ method: 'POST', url: '/auth/tfa/begin', headers: { cookie } })
    const secret = (begin.json().typed as string).replace(/\s/g, '')
    await app.inject({
      method: 'POST',
      url: '/auth/tfa/confirm',
      headers: { cookie },
      payload: { code: totpAt(secret, Date.now()) },
    })

    const res = await signInWith(key, userId, rp)

    expect(res.statusCode).toBe(200)
    expect(res.json().secondFactor, 'held, not signed in').toBe(true)
    expect(res.json().user, 'no account handed over yet').toBeUndefined()

    const held = cookieFrom(res)
    const status = await app.inject({ url: '/auth/status', headers: { cookie: held } })
    expect(status.json().user, 'still nobody').toBeNull()
    expect(status.json().awaitingSecondFactor).toBe(true)

    const done = await app.inject({
      method: 'POST',
      url: '/auth/login/second-factor',
      headers: { cookie: held },
      payload: { code: totpAt(secret, Date.now()) },
    })
    expect(done.statusCode, 'the code finishes the job').toBe(200)
    expect(done.json().user.email).toBe(EMAIL)
  })

  it('signs straight in when the account has no second factor', async () => {
    const { key, userId, rp } = await enrol()
    const res = await signInWith(key, userId, rp)

    expect(res.json().secondFactor).toBeUndefined()
    expect(res.json().user.email).toBe(EMAIL)
  })
})
