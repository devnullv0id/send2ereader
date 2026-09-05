import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { publicUrl, publicUrlFor } from '../config.js'
import type { Passkey, User } from '../db/repositories.js'

export const RP_NAME = 'Send to eReader'

function siteUrl(): URL | null {
  try {
    return new URL(publicUrl() || publicUrlFor('/'))
  } catch {
    return null
  }
}

export function relyingParty(): { id: string; origin: string } {
  const url = siteUrl()
  if (!url) throw new Error('DOMAIN is not a host, so passkeys have no site to belong to')
  return { id: url.hostname, origin: url.origin }
}

export function isSecureContext(): boolean {
  const url = siteUrl()
  if (!url) return false
  return url.protocol === 'https:' || url.hostname === 'localhost'
}

export async function registrationOptions(user: User, existing: Passkey[]) {
  const rp = relyingParty()
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.id,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.email,
    attestationType: 'none',
    excludeCredentials: existing.map((key) => ({
      id: key.id,
      transports: key.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  })
}

export interface NewCredential {
  id: string
  publicKey: string
  counter: number
  transports: string[]
}

export async function verifyRegistration(
  response: RegistrationResponseJSON,
  expectedChallenge: string
): Promise<NewCredential | null> {
  const rp = relyingParty()
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    })
  } catch {
    return null
  }

  if (!result.verified || !result.registrationInfo) return null
  const { credential } = result.registrationInfo
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: response.response.transports ?? [],
  }
}

export async function authenticationOptions() {
  const rp = relyingParty()
  return generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: 'preferred',
  })
}

export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  stored: Passkey
): Promise<{ counter: number } | null> {
  const rp = relyingParty()
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        counter: stored.counter,
        transports: stored.transports as AuthenticatorTransportFuture[],
      },
    })
    if (!result.verified) return null
    return { counter: result.authenticationInfo.newCounter }
  } catch {
    return null
  }
}

export function userHandleOf(response: AuthenticationResponseJSON): string | null {
  const handle = response.response.userHandle
  if (!handle) return null
  try {
    return Buffer.from(handle, 'base64url').toString('utf8')
  } catch {
    return null
  }
}
