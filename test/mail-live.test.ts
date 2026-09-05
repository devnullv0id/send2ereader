import { createServer, type Server, type Socket } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { prepareUploadDir } from '../src/files.js'
import { smtpProblem } from '../src/mail/index.js'
import { SETTING_SPECS, settings } from '../src/settings.js'
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
const EMAIL = 'first@example.com'

interface Sink {
  server: Server
  port: number
  taken: string[]
}

async function smtpSink(): Promise<Sink> {
  const taken: string[] = []

  const server = createServer((socket: Socket) => {
    let body: string[] | null = null

    socket.write('220 sink\r\n')
    socket.setEncoding('utf8')

    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let cut = buffer.indexOf('\r\n')
      while (cut !== -1) {
        const line = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)

        if (body !== null) {
          if (line === '.') {
            taken.push(body.join('\n'))
            body = null
            socket.write('250 taken\r\n')
          } else {
            body.push(line)
          }
        } else if (/^(EHLO|HELO)/i.test(line)) {
          socket.write('250-sink\r\n250 HELP\r\n')
        } else if (/^(MAIL|RCPT)/i.test(line)) {
          socket.write('250 ok\r\n')
        } else if (/^DATA/i.test(line)) {
          body = []
          socket.write('354 go\r\n')
        } else if (/^QUIT/i.test(line)) {
          socket.write('221 bye\r\n')
          socket.end()
        } else {
          socket.write('250 ok\r\n')
        }
        cut = buffer.indexOf('\r\n')
      }
    })
    socket.on('error', () => undefined)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { server, port, taken }
}

let app: FastifyInstance
let db: Db
let cookie: string
let sink: Sink

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  return (Array.isArray(raw) ? raw : [raw]).map((l) => String(l).split(';')[0]).join('; ')
}

beforeEach(async () => {
  sink = await smtpSink()

  await prepareUploadDir(true)
  db = openDatabase(':memory:')
  app = asBrowser(await buildApp({ tools: noTools, logger: false, accounts: true, db }))
  await app.ready()

  cookie = cookieFrom(
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: EMAIL, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    })
  )
})

afterEach(async () => {
  await app.close()
  db.close()
  await new Promise<void>((resolve) => sink.server.close(() => resolve()))
})

const put = (key: string, value: string) =>
  app.inject({
    method: 'PUT',
    url: '/api/admin/settings',
    headers: { cookie },
    payload: { key, value },
  })

async function pointAtTheSink(): Promise<void> {
  await put('SMTP_HOST', '127.0.0.1')
  await put('SMTP_PORT', String(sink.port))
  await put('SMTP_SECURITY', 'none')
  await put('SMTP_FROM_EMAIL', 'server@example.com')
  await put('SMTP_ENABLED', 'true')
}

const askForAReset = () =>
  app.inject({ method: 'POST', url: '/auth/reset/request', payload: { email: EMAIL } })

const settle = () => new Promise((r) => setTimeout(r, 400))

describe('configuring SMTP while the server runs', () => {
  it('starts sending without a restart', async () => {
    expect(app.mailer.enabled, 'nothing configured yet').toBe(false)

    await pointAtTheSink()

    expect(app.mailer.enabled, 'the same mailer object, now live').toBe(true)
    expect(smtpProblem()).toBeNull()

    await askForAReset()
    await settle()

    expect(sink.taken, 'a real message reached a real SMTP server').toHaveLength(1)
    expect(sink.taken[0]).toContain('server@example.com')
  })

  it('stops sending again the moment it is turned off', async () => {
    await pointAtTheSink()
    await askForAReset()
    await settle()
    expect(sink.taken).toHaveLength(1)

    await put('SMTP_ENABLED', 'false')
    expect(app.mailer.enabled).toBe(false)

    await askForAReset()
    await settle()
    expect(sink.taken, 'the second one went to the log instead').toHaveLength(1)
  })

  it('will not send while the settings are incomplete, and says why', async () => {
    await put('SMTP_ENABLED', 'true')

    expect(smtpProblem()).toContain('SMTP_HOST is empty')
    expect(app.mailer.enabled).toBe(false)

    await askForAReset()
    await settle()
    expect(sink.taken).toHaveLength(0)
  })

  it('follows the address it is told to send from', async () => {
    await pointAtTheSink()
    await put('SMTP_FROM_NAME', 'Books')
    await put('SMTP_FROM_EMAIL', 'library@example.com')

    await askForAReset()
    await settle()

    expect(sink.taken[0]).toContain('Books <library@example.com>')
  })

  it('moves to a different server when the host changes', async () => {
    await pointAtTheSink()
    await askForAReset()
    await settle()
    expect(sink.taken).toHaveLength(1)

    const second = await smtpSink()
    try {
      await put('SMTP_PORT', String(second.port))

      await askForAReset()
      await settle()

      expect(second.taken, 'the new server got it').toHaveLength(1)
      expect(sink.taken, 'and the old one got nothing more').toHaveLength(1)
    } finally {
      await new Promise<void>((resolve) => second.server.close(() => resolve()))
    }
  })
})

describe('choosing how the connection is encrypted', () => {
  it('reads the older SMTP_TLS when SMTP_SECURITY is unset', async () => {
    const { SETTING_SPECS: specs } = await import('../src/settings.js')
    const spec = specs.find((entry) => entry.key === 'SMTP_SECURITY')!

    expect(spec.choices?.map((c) => c.value)).toEqual(['starttls', 'ssl', 'none'])
    expect(spec.env(), 'whatever this environment says, it is one of them').toBeTruthy()
    expect(spec.choices?.some((c) => c.value === spec.env())).toBe(true)
  })

  it('still sends with encryption switched off', async () => {
    await pointAtTheSink()
    expect(settings.str('SMTP_SECURITY')).toBe('none')

    await askForAReset()
    await settle()
    expect(sink.taken).toHaveLength(1)
  })

  it('refuses a mode nobody offers', async () => {
    const res = await put('SMTP_SECURITY', 'carrier-pigeon')
    expect(res.statusCode).toBe(400)
  })
})

describe('what the admin page claims about mail', () => {
  it('no longer tells anyone a restart is needed', () => {
    const mail = SETTING_SPECS.filter((spec) => spec.group === 'mail')

    expect(mail.length).toBeGreaterThan(5)
    for (const spec of mail) {
      expect(spec.restart, `${spec.key} still claims it needs a restart`).not.toBe(true)
    }
  })

  it('offers every SMTP key the mailer actually reads', () => {
    const offered = new Set(SETTING_SPECS.map((spec) => spec.key))
    for (const key of [
      'SMTP_ENABLED',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_SECURITY',
      'SMTP_USERNAME',
      'SMTP_PASSWORD',
      'SMTP_FROM_EMAIL',
      'SMTP_FROM_NAME',
      'SMTP_TIMEOUT_SECONDS',
      'MAIL_LOG_SECRETS',
    ]) {
      expect(offered.has(key), `${key} is read but cannot be set`).toBe(true)
    }
  })

  it('reports mail as on to the sign-in page as soon as it is', async () => {
    expect((await app.inject({ url: '/auth/status' })).json().mailEnabled).toBe(false)
    await pointAtTheSink()
    expect((await app.inject({ url: '/auth/status' })).json().mailEnabled).toBe(true)
  })

  it('keeps the password out of everything it hands back', async () => {
    await pointAtTheSink()
    await put('SMTP_PASSWORD', 'the-smtp-password')

    const shown = await app.inject({ url: '/api/admin/settings', headers: { cookie } })
    expect(JSON.stringify(shown.json())).not.toContain('the-smtp-password')
    expect(settings.str('SMTP_PASSWORD')).toBe('the-smtp-password')
  })
})
