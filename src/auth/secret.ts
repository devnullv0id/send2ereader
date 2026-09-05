import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const SECRET_BYTES = 64
export const WEAK_SECRET_LENGTH = 32
export const SECRET_FILE = 'session.key'

export type StoredSecret = { secret: string; created: boolean }

export function readOrCreateSessionSecret(path: string): StoredSecret {
  try {
    const held = readFileSync(path, 'utf8').trim()
    if (held.length > 0) return { secret: held, created: false }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new Error(
        `Cannot read the session key at ${path}: ${code}. ` +
          'It encrypts stored tokens and signs every session, so the server will not ' +
          'start without it. Fix the permissions, or set SESSION_SECRET in the environment.'
      )
    }
  }

  const made = randomBytes(SECRET_BYTES).toString('base64url')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${made}\n`, { mode: 0o600 })

  return { secret: made, created: true }
}
