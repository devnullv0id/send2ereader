import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { settings } from '../settings.js'

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

const KEY_LENGTH = 64
const SALT_LENGTH = 16
const R = 8
const P = 1

function memoryFor(n: number): number {
  return 256 * n * R
}

export async function hashPassword(password: string, n = config.auth.scryptN): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: n,
    r: R,
    p: P,
    maxmem: memoryFor(n),
  })
  return `scrypt$${n}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4]!, 'base64')
    expected = Buffer.from(parts[5]!, 'base64')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let actual: Buffer
  try {
    actual = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 256 * n * r,
    })
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export const MIN_PASSWORD_LENGTH = config.auth.minPasswordLength

export const RULES = [
  { id: 'upper', key: 'PASSWORD_REQUIRE_UPPER', test: /\p{Lu}/u, said: 'a capital letter' },
  { id: 'lower', key: 'PASSWORD_REQUIRE_LOWER', test: /\p{Ll}/u, said: 'a small letter' },
  { id: 'digit', key: 'PASSWORD_REQUIRE_DIGIT', test: /\p{Nd}/u, said: 'a digit' },
  { id: 'symbol', key: 'PASSWORD_REQUIRE_SYMBOL', test: /[^\p{L}\p{Nd}\s]/u, said: 'a symbol' },
] as const

export interface PasswordRules {
  minLength: number
  maxLength: number
  needs: { id: string; said: string }[]
}

export function passwordRules(): PasswordRules {
  return {
    minLength: settings.int('MIN_PASSWORD_LENGTH'),
    maxLength: settings.int('MAX_PASSWORD_LENGTH'),
    needs: RULES.filter((rule) => settings.bool(rule.key)).map((rule) => ({
      id: rule.id,
      said: rule.said,
    })),
  }
}

function listOut(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function passwordProblem(password: string): string | null {
  const minLength = settings.int('MIN_PASSWORD_LENGTH')
  if (password.length < minLength) {
    return `Password must be at least ${minLength} characters`
  }
  if (password.length > settings.int('MAX_PASSWORD_LENGTH')) return 'Password is too long'

  const missing = RULES.filter((rule) => settings.bool(rule.key) && !rule.test.test(password)).map(
    (rule) => rule.said
  )
  if (missing.length > 0) return `Password must contain ${listOut(missing)}`

  return null
}
