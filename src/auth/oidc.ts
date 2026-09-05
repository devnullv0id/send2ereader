import * as client from 'openid-client'
import { config, publicUrlFor } from '../config.js'

export interface OidcLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface OidcIdentity {
  issuer: string
  subject: string
  email?: string
  emailVerified?: boolean
  name?: string
  groups: string[]
}

export interface AuthorizationRequest {
  url: string
  state: string
  nonce: string
  codeVerifier: string
}

export const REDIRECT_PATH = '/auth/sso/callback'

export function issuerFromConfigUrl(configUrl: string): string {
  return configUrl.replace(/\/+\.well-known\/openid-configuration\/?$/, '').replace(/\/+$/, '')
}

function readGroups(claims: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ['groups', 'roles', 'realm_access.roles']) {
    const value =
      key === 'realm_access.roles'
        ? (claims.realm_access as { roles?: unknown } | undefined)?.roles
        : claims[key]
    if (Array.isArray(value)) out.push(...value.filter((v): v is string => typeof v === 'string'))
    else if (typeof value === 'string') out.push(...value.split(/[\s,]+/).filter(Boolean))
  }
  return [...new Set(out)]
}

export class OidcService {
  #config: client.Configuration | null = null
  #discovery: Promise<client.Configuration> | null = null

  constructor(private readonly log: OidcLogger) {}

  get enabled(): boolean {
    return (
      config.oidc.enabled && config.oidc.configUrl.length > 0 && config.oidc.clientId.length > 0
    )
  }

  static problem(): string | null {
    if (!config.oidc.enabled) return null
    if (!config.oidc.configUrl) return 'OIDC_ENABLED is set but OIDC_CONFIG_URL is empty'
    if (!config.oidc.clientId) return 'OIDC_ENABLED is set but OIDC_CLIENT_ID is empty'
    if (!config.domain) return 'OIDC_ENABLED is set but DOMAIN is empty'
    return null
  }

  get redirectUri(): string {
    return publicUrlFor(REDIRECT_PATH)
  }

  async #load(): Promise<client.Configuration> {
    if (this.#config) return this.#config
    if (!this.#discovery) {
      const issuer = issuerFromConfigUrl(config.oidc.configUrl)
      this.#discovery = client
        .discovery(
          new URL(issuer),
          config.oidc.clientId,
          config.oidc.clientSecret || undefined,
          config.oidc.clientSecret ? undefined : client.None()
        )
        .then((resolved) => {
          this.#config = resolved
          this.log.info({ issuer }, 'Discovered OIDC provider')
          return resolved
        })
        .catch((err) => {
          this.#discovery = null
          throw err
        })
    }
    return this.#discovery
  }

  async startLogin(): Promise<AuthorizationRequest> {
    const resolved = await this.#load()
    const codeVerifier = client.randomPKCECodeVerifier()
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
    const state = client.randomState()
    const nonce = client.randomNonce()

    const url = client.buildAuthorizationUrl(resolved, {
      redirect_uri: this.redirectUri,
      scope: 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    })

    return { url: url.href, state, nonce, codeVerifier }
  }

  async completeLogin(
    currentUrl: URL,
    expected: { state: string; nonce: string; codeVerifier: string }
  ): Promise<OidcIdentity> {
    const resolved = await this.#load()
    const tokens = await client.authorizationCodeGrant(resolved, currentUrl, {
      pkceCodeVerifier: expected.codeVerifier,
      expectedState: expected.state,
      expectedNonce: expected.nonce,
    })

    const claims = tokens.claims() as Record<string, unknown> | undefined
    if (!claims?.sub) throw new Error('The identity provider returned no subject claim')

    let merged: Record<string, unknown> = claims
    if (!merged.email) {
      try {
        const info = await client.fetchUserInfo(resolved, tokens.access_token, String(claims.sub))
        merged = { ...merged, ...(info as unknown as Record<string, unknown>) }
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'Could not fetch OIDC userinfo')
      }
    }

    return {
      issuer: String(claims.iss),
      subject: String(claims.sub),
      email: typeof merged.email === 'string' ? merged.email : undefined,
      emailVerified: merged.email_verified === true,
      name: typeof merged.name === 'string' ? merged.name : undefined,
      groups: readGroups(merged),
    }
  }

  grantsAdmin(identity: OidcIdentity): boolean {
    const required = config.oidc.adminGroup
    return required.length > 0 && identity.groups.includes(required)
  }
}
