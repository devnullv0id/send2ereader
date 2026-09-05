import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { fixPublicUrl, publicUrl } from '../src/config.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { prepareUploadDir } from '../src/files.js'
import { settings } from '../src/settings.js'

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
let before: string

beforeEach(async () => {
  before = publicUrl()
  await prepareUploadDir(true)
  db = openDatabase(':memory:')
})

afterEach(async () => {
  await app.close()
  db.close()
  settings.detach()
  const { protocol, host } = new URL(before)
  fixPublicUrl(protocol.replace(':', ''), host)
})

async function buildWith(protocol: string, domain: string): Promise<void> {
  settings.attach(db)
  settings.set('PROTOCOL', protocol, null)
  settings.set('DOMAIN', domain, null)
  app = await buildApp({ tools: noTools, logger: false, accounts: true, db })
  await app.ready()
}

describe('headers follow the address the administrator actually set', () => {
  it('promises https once the stored settings say https', async () => {
    await buildWith('https', 'books.example.com')
    expect(publicUrl(), 'the app knows it is on https').toBe('https://books.example.com')

    const res = await app.inject({ url: '/' })
    expect(res.headers['strict-transport-security'], 'so HSTS is on').toBeTruthy()
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(res.headers['origin-agent-cluster']).toBe('?1')
    expect(String(res.headers['content-security-policy'])).toContain('upgrade-insecure-requests')
  })

  it('promises nothing it cannot keep once the stored settings say http', async () => {
    await buildWith('http', '10.0.0.5:3001')
    expect(publicUrl()).toBe('http://10.0.0.5:3001')

    const res = await app.inject({ url: '/' })
    expect(res.headers['strict-transport-security']).toBeUndefined()
    expect(res.headers['cross-origin-opener-policy']).toBeUndefined()
    expect(
      res.headers['origin-agent-cluster'],
      'a browser would only warn about it'
    ).toBeUndefined()
    expect(String(res.headers['content-security-policy'])).not.toContain(
      'upgrade-insecure-requests'
    )
  })
})
