import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { sessionSecret } from '../config.js'

const IV_LENGTH = 12

// Derived on first use rather than on import, because the secret may still be
// waiting to be read off disk when this module is loaded.
let derived: Buffer | null = null
function boxKey(): Buffer {
  derived ??= createHash('sha256').update(sessionSecret()).digest()
  return derived
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', boxKey(), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, body, cipher.getAuthTag()].map((b) => b.toString('base64url')).join('.')
}

export function decryptSecret(stored: string | null): string | null {
  if (!stored) return null
  const [iv, body, tag] = stored.split('.')
  if (!iv || !body || !tag) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', boxKey(), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}
