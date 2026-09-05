import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { issuerFromConfigUrl } from '../src/auth/oidc.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { createRepositories } from '../src/db/repositories.js'
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

describe('issuer resolution', () => {
  it.each([
    ['https://idp.example/.well-known/openid-configuration', 'https://idp.example'],
    ['https://idp.example/.well-known/openid-configuration/', 'https://idp.example'],
    [
      'https://idp.example/realms/x/.well-known/openid-configuration',
      'https://idp.example/realms/x',
    ],
    ['https://idp.example/realms/x', 'https://idp.example/realms/x'],
    ['https://idp.example/', 'https://idp.example'],
  ])('%s -> %s', (input, expected) => {
    expect(issuerFromConfigUrl(input)).toBe(expected)
  })
})

describe('SSO stays off unless fully configured', () => {
  const report = (env: Record<string, string>) => {
    const out = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `const { OidcService } = await import('./src/auth/oidc.ts')
         console.log(JSON.stringify({ problem: OidcService.problem() }))`,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, ENV_FILE: 'does-not-exist', ...env },
      }
    )
    return JSON.parse(out.trim().split('\n').pop()!)
  }

  it('is silent when SSO is switched off', () => {
    expect(report({ OIDC_ENABLED: 'false' }).problem).toBeNull()
  })

  it.each([
    ['no discovery URL', { OIDC_ENABLED: 'true' }, /OIDC_CONFIG_URL is empty/],
    [
      'no client id',
      { OIDC_ENABLED: 'true', OIDC_CONFIG_URL: 'https://idp.example' },
      /OIDC_CLIENT_ID is empty/,
    ],
    [
      'no public URL',
      {
        OIDC_ENABLED: 'true',
        OIDC_CONFIG_URL: 'https://idp.example',
        OIDC_CLIENT_ID: 'abc',
        DOMAIN: '',
      },
      /DOMAIN is empty/,
    ],
  ])('reports %s', (_label, env, expected) => {
    expect(report(env).problem).toMatch(expected)
  })

  it('has no SSO endpoints when it is off', async () => {
    for (const url of ['/auth/sso', '/auth/sso/callback']) {
      expect((await app.inject({ url })).statusCode).toBe(404)
    }
    expect((await app.inject({ url: '/auth/status' })).json().ssoEnabled).toBe(false)
  })
})

describe('linking an SSO identity to an account', () => {
  const identity = {
    issuer: 'https://idp.example',
    subject: 'sub-1',
    email: 'person@example.com',
    emailVerified: true,
  }

  it('creates an account on first sign-in', () => {
    const user = app.auth.linkOidcUser(identity)
    expect(user.email).toBe('person@example.com')
    expect(user.passwordHash).toBeNull()
    expect(user.emailVerified).toBe(true)
  })

  it('returns the same account next time, even without claims', () => {
    const first = app.auth.linkOidcUser(identity)
    const again = app.auth.linkOidcUser({ issuer: identity.issuer, subject: identity.subject })
    expect(again.id).toBe(first.id)
  })

  it('refuses to adopt a local account on an unverified claim', () => {
    app.repos.users.create({ email: 'person@example.com', passwordHash: 'x' })
    expect(() => app.auth.linkOidcUser({ ...identity, emailVerified: false })).toThrow(
      /did not confirm/i
    )
  })

  it('adopts a local account when the provider confirms the address', () => {
    const local = app.repos.users.create({
      email: 'person@example.com',
      passwordHash: 'x',
    })
    const linked = app.auth.linkOidcUser(identity)
    expect(linked.id).toBe(local.id)
    expect(createRepositories(db).users.count()).toBe(1)
  })

  it('rejects an identity with no address at all', () => {
    expect(() =>
      app.auth.linkOidcUser({ issuer: identity.issuer, subject: 'unknown-sub' })
    ).toThrow(/did not supply an e-mail address/i)
  })

  it('treats two providers with the same subject as different people', () => {
    const a = app.auth.linkOidcUser(identity)
    const b = app.auth.linkOidcUser({
      ...identity,
      issuer: 'https://other.example',
      email: 'other@example.com',
    })
    expect(b.id).not.toBe(a.id)
  })
})

describe('administrator rights from a group', () => {
  it('never demotes the first account, whatever the group says', () => {
    const repos = createRepositories(db)
    const first = repos.users.create({ email: 'a@example.com', passwordHash: 'x' })

    expect(repos.users.setAdmin(first.id, false), 'refused').toBe(false)
    expect(repos.users.byId(first.id)!.isAdmin).toBe(true)
  })

  it('demotes anybody else the group stops naming', () => {
    const repos = createRepositories(db)
    const a = repos.users.create({ email: 'a@example.com', passwordHash: 'x' })
    const b = repos.users.create({ email: 'b@example.com', passwordHash: 'x' })

    // Two accounts made in the same millisecond are ordered by id, so which one
    // is the founder is not the order they were written in.
    const other = repos.users.founderId() === a.id ? b : a

    repos.users.setAdmin(other.id, true)
    expect(repos.users.byId(other.id)!.isAdmin).toBe(true)

    expect(repos.users.setAdmin(other.id, false)).toBe(true)
    expect(repos.users.byId(other.id)!.isAdmin).toBe(false)
  })

  it('promotes on demand', () => {
    const repos = createRepositories(db)
    repos.users.create({ email: 'a@example.com', passwordHash: 'x' })
    const user = repos.users.create({ email: 'c@example.com', passwordHash: 'x' })

    repos.users.setAdmin(user.id, true)
    expect(repos.users.byId(user.id)!.isAdmin).toBe(true)
  })
})
