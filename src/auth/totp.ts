import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const PERIOD_SECONDS = 30
export const DIGITS = 6
const SECRET_BYTES = 20
const DEFAULT_WINDOW = 1

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (clean.length === 0) return null

  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const at = ALPHABET.indexOf(ch)
    if (at === -1) return null
    value = (value << 5) | at
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function generateSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES))
}

function counterBuffer(counter: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  return buf
}

export function hotp(secret: Buffer, counter: number): string {
  const mac = createHmac('sha1', secret).update(counterBuffer(counter)).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const truncated =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff)
  return String(truncated % 10 ** DIGITS).padStart(DIGITS, '0')
}

export function totpAt(secret: string, atMs: number): string | null {
  const key = base32Decode(secret)
  if (!key || key.length === 0) return null
  return hotp(key, Math.floor(atMs / 1000 / PERIOD_SECONDS))
}

function sameCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export function verifyTotp(
  secret: string,
  code: string,
  atMs = Date.now(),
  window = DEFAULT_WINDOW
): boolean {
  const wanted = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(wanted)) return false

  const key = base32Decode(secret)
  if (!key || key.length === 0) return false

  const step = Math.floor(atMs / 1000 / PERIOD_SECONDS)
  let matched = false
  for (let drift = -window; drift <= window; drift++) {
    if (sameCode(hotp(key, step + drift), wanted)) matched = true
  }
  return matched
}

export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

export function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ')
}
