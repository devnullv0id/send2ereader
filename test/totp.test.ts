import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  base32Encode,
  generateSecret,
  groupSecret,
  hotp,
  otpauthUri,
  totpAt,
  verifyTotp,
} from '../src/auth/totp.js'

const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

describe('the base32 the authenticator apps read', () => {
  it('round-trips the bytes it was given', () => {
    for (const text of ['f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
      const bytes = Buffer.from(text, 'ascii')
      expect(base32Decode(base32Encode(bytes))?.toString('ascii')).toBe(text)
    }
  })

  it('encodes the RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
    expect(base32Encode(Buffer.from('f'))).toBe('MY')
  })

  it('forgives the spaces and padding a person types', () => {
    const plain = base32Decode('MZXW6YTBOI')
    expect(base32Decode('mzxw 6ytb oi')).toEqual(plain)
    expect(base32Decode('MZXW-6YTB-OI')).toEqual(plain)
    expect(base32Decode('MZXW6YTBOI======')).toEqual(plain)
  })

  it('refuses characters that are not in the alphabet', () => {
    expect(base32Decode('MZXW6YTB01')).toBeNull()
    expect(base32Decode('')).toBeNull()
  })

  it('makes a secret an app will accept', () => {
    const secret = generateSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(base32Decode(secret)).toHaveLength(20)
    expect(generateSecret()).not.toBe(secret)
  })
})

describe('the codes themselves, against RFC 4226 and RFC 6238', () => {
  const key = Buffer.from('12345678901234567890', 'ascii')

  it('matches the HOTP vectors from the RFC', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ]
    expected.forEach((code, counter) => {
      expect(hotp(key, counter)).toBe(code)
    })
  })

  it('matches the SHA-1 TOTP vectors from the RFC', () => {
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ]
    for (const [seconds, code] of vectors) {
      expect(totpAt(RFC_SECRET, seconds * 1000), `at ${seconds}`).toBe(code)
    }
  })
})

describe('what the server will accept when someone types a code', () => {
  const at = 1111111109 * 1000

  it('takes the code showing right now', () => {
    expect(verifyTotp(RFC_SECRET, '081804', at)).toBe(true)
  })

  it('takes one step either side, for a clock that drifted', () => {
    const before = totpAt(RFC_SECRET, at - 30_000)!
    const after = totpAt(RFC_SECRET, at + 30_000)!
    expect(verifyTotp(RFC_SECRET, before, at)).toBe(true)
    expect(verifyTotp(RFC_SECRET, after, at)).toBe(true)
  })

  it('refuses two steps out, so a stolen code goes stale', () => {
    const stale = totpAt(RFC_SECRET, at - 90_000)!
    expect(verifyTotp(RFC_SECRET, stale, at)).toBe(false)
  })

  it('forgives a space in the middle, the way phones show it', () => {
    expect(verifyTotp(RFC_SECRET, '081 804', at)).toBe(true)
  })

  it('refuses anything that is not six digits', () => {
    for (const bad of ['', '81804', '0818040', 'abcdef', '08180a']) {
      expect(verifyTotp(RFC_SECRET, bad, at), bad).toBe(false)
    }
  })

  it('refuses every code when the secret is unreadable', () => {
    expect(verifyTotp('not base32!', '081804', at)).toBe(false)
    expect(totpAt('', at)).toBeNull()
  })
})

describe('what the QR and the typed key say', () => {
  it('names the issuer in both the label and the parameters', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'me@example.com', 'Send to eReader')
    const parsed = new URL(uri)

    expect(parsed.protocol).toBe('otpauth:')
    expect(parsed.host).toBe('totp')
    expect(decodeURIComponent(parsed.pathname)).toBe('/Send to eReader:me@example.com')
    expect(parsed.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP')
    expect(parsed.searchParams.get('issuer')).toBe('Send to eReader')
    expect(parsed.searchParams.get('digits')).toBe('6')
    expect(parsed.searchParams.get('period')).toBe('30')
  })

  it('breaks the typed key into fours so it can be read aloud', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP')
  })
})
