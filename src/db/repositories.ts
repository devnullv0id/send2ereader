import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Db } from './index.js'
import { decryptSecret, encryptSecret } from './secretbox.js'

export interface User {
  id: string
  email: string
  firstName: string
  lastName: string
  emailVerified: boolean
  passwordHash: string | null
  isAdmin: boolean
  createdAt: string
  lastLoginAt: string | null
  retainMinutes: number | null
  totpEnabled: boolean
  passkeysClearedAt: string | null
  passkeysClearedFrom: string | null
  verifyRemindersLeft: number | null
}

export type TokenPurpose = 'verify' | 'reset' | 'signin' | 'email_change'

export interface EmailToken {
  userId: string
  purpose: TokenPurpose
  email: string
  expiresAt: string
  persist: boolean
}

export interface Device {
  id: string
  userId: string
  label: string
  proxyStore: boolean
  koboDeviceId: string | null
  koboUserId: string | null
  createdAt: string
  lastSeenAt: string | null
  token: string | null
  lastSyncFailedAt: string | null
}

export interface Session {
  id: string
  userId: string
  userAgent: string
  ip: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
}

interface UserRow {
  id: string
  email: string
  first_name: string
  last_name: string
  email_verified: number
  password_hash: string | null
  is_admin: number
  created_at: string
  last_login_at: string | null
  retain_minutes: number | null
  totp_secret: string | null
  totp_enabled: number
  passkeys_cleared_at: string | null
  passkeys_cleared_from: string | null
  verify_reminders_left: number | null
}

interface DeviceRow {
  id: string
  user_id: string
  label: string
  proxy_store: number
  kobo_device_id: string | null
  kobo_user_id: string | null
  created_at: string
  last_seen_at: string | null
  token_enc: string | null
  last_sync_failed_at: string | null
}

interface SessionRow {
  id: string
  user_id: string
  user_agent: string
  ip: string
  created_at: string
  last_seen_at: string
  expires_at: string
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    userAgent: row.user_agent,
    ip: row.ip,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  }
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    emailVerified: row.email_verified === 1,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    retainMinutes: row.retain_minutes,
    totpEnabled: row.totp_enabled === 1,
    passkeysClearedAt: row.passkeys_cleared_at,
    passkeysClearedFrom: row.passkeys_cleared_from,
    verifyRemindersLeft: row.verify_reminders_left,
  }
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    proxyStore: row.proxy_store === 1,
    koboDeviceId: row.kobo_device_id,
    koboUserId: row.kobo_user_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    token: decryptSecret(row.token_enc),
    lastSyncFailedAt: row.last_sync_failed_at,
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

const now = () => new Date().toISOString()

export class Users {
  constructor(private readonly db: Db) {}

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    return row.n
  }

  isUnclaimed(): boolean {
    return this.count() === 0
  }

  byId(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
    return row ? toUser(row) : null
  }

  byEmail(email: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email) as
      | UserRow
      | undefined
    return row ? toUser(row) : null
  }

  create(input: {
    email: string
    passwordHash: string | null
    emailVerified?: boolean
    firstName?: string
    lastName?: string
  }): User {
    const id = randomUUID()
    const first = this.isUnclaimed()
    this.db
      .prepare(
        `INSERT INTO users (id, email, first_name, last_name, email_verified, password_hash,
                            is_admin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.email,
        (input.firstName ?? '').trim(),
        (input.lastName ?? '').trim(),
        input.emailVerified ? 1 : 0,
        input.passwordHash,
        first ? 1 : 0,
        now()
      )
    return this.byId(id)!
  }

  setName(id: string, firstName: string, lastName: string): void {
    this.db
      .prepare('UPDATE users SET first_name = ?, last_name = ? WHERE id = ?')
      .run(firstName.trim(), lastName.trim(), id)
  }

  founderId(): string | null {
    const row = this.db.prepare('SELECT id FROM users ORDER BY rowid LIMIT 1').get() as
      | { id: string }
      | undefined
    return row?.id ?? null
  }

  isFounder(id: string): boolean {
    return this.founderId() === id
  }

  notePasskeysCleared(ids: string[], from: string): void {
    if (ids.length === 0) return
    const at = now()
    const mark = this.db.prepare(
      'UPDATE users SET passkeys_cleared_at = ?, passkeys_cleared_from = ? WHERE id = ?'
    )
    for (const id of ids) mark.run(at, from, id)
  }

  acknowledgePasskeysCleared(id: string): void {
    this.db
      .prepare(
        'UPDATE users SET passkeys_cleared_at = NULL, passkeys_cleared_from = NULL WHERE id = ?'
      )
      .run(id)
  }

  canAdmin(id: string): boolean {
    return this.byId(id)?.isAdmin === true
  }

  setAdmin(id: string, isAdmin: boolean): boolean {
    if (!isAdmin && this.isFounder(id)) return false
    this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id)
    return true
  }

  listAll(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY rowid').all() as unknown as UserRow[]
    return rows.map(toUser)
  }

  markVerified(id: string): void {
    this.db
      .prepare('UPDATE users SET email_verified = 1, verify_reminders_left = NULL WHERE id = ?')
      .run(id)
  }

  setEmail(id: string, email: string): void {
    this.db
      .prepare(
        'UPDATE users SET email = ?, email_verified = 1, verify_reminders_left = NULL WHERE id = ?'
      )
      .run(email, id)
  }

  spendVerifyReminder(id: string, limit: number): number {
    const row = this.db
      .prepare('SELECT verify_reminders_left AS left FROM users WHERE id = ?')
      .get(id) as { left: number | null } | undefined
    if (!row) return 0

    const had = row.left === null ? limit : Math.min(row.left, limit)
    const left = Math.max(0, had - 1)
    this.db.prepare('UPDATE users SET verify_reminders_left = ? WHERE id = ?').run(left, id)
    return left
  }

  verifyRemindersLeft(id: string, limit: number): number {
    const row = this.db
      .prepare('SELECT verify_reminders_left AS left FROM users WHERE id = ?')
      .get(id) as { left: number | null } | undefined
    if (!row) return 0
    return row.left === null ? limit : Math.min(row.left, limit)
  }

  setPassword(id: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id)
  }

  remove(id: string): string | null {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id)
    return this.ensureAnAdmin()
  }

  ensureAnAdmin(): string | null {
    const admin = this.db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get()
    if (admin) return null

    const next = this.db.prepare('SELECT id FROM users ORDER BY rowid LIMIT 1').get() as
      | { id: string }
      | undefined
    if (!next) return null

    this.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(next.id)
    return next.id
  }

  setRetainMinutes(id: string, minutes: number | null): void {
    this.db.prepare('UPDATE users SET retain_minutes = ? WHERE id = ?').run(minutes, id)
  }

  touchLogin(id: string): void {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), id)
  }

  totpSecret(id: string): string | null {
    const row = this.db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(id) as
      | { totp_secret: string | null }
      | undefined
    return decryptSecret(row?.totp_secret ?? null)
  }

  stageTotpSecret(id: string, secret: string): void {
    this.db
      .prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?')
      .run(encryptSecret(secret), id)
  }

  enableTotp(id: string): void {
    this.db
      .prepare('UPDATE users SET totp_enabled = 1 WHERE id = ? AND totp_secret IS NOT NULL')
      .run(id)
  }

  disableTotp(id: string): void {
    this.db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(id)
  }
}

export class Identities {
  constructor(private readonly db: Db) {}

  findUserId(issuer: string, subject: string): string | null {
    const row = this.db
      .prepare('SELECT user_id FROM identities WHERE issuer = ? AND subject = ?')
      .get(issuer, subject) as { user_id: string } | undefined
    return row?.user_id ?? null
  }

  link(userId: string, issuer: string, subject: string): void {
    this.db
      .prepare(
        `INSERT INTO identities (user_id, issuer, subject, linked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (issuer, subject) DO UPDATE SET user_id = excluded.user_id`
      )
      .run(userId, issuer, subject, now())
  }
}

export class EmailTokens {
  constructor(private readonly db: Db) {}

  issue(
    userId: string,
    purpose: TokenPurpose,
    email: string,
    ttlSeconds: number,
    persist = true
  ): string {
    this.db
      .prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?')
      .run(userId, purpose)
    const token = generateToken()
    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString()
    this.db
      .prepare(
        `INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at, created_at, persist)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(hashToken(token), userId, purpose, email, expires, now(), persist ? 1 : 0)
    return token
  }

  hasActive(userId: string, purpose: TokenPurpose): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM email_tokens
         WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?`
      )
      .get(userId, purpose, now())
    return row !== undefined
  }

  pending(userId: string, purpose: TokenPurpose): { email: string; expiresAt: string } | null {
    const row = this.db
      .prepare(
        `SELECT email, expires_at FROM email_tokens
         WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?`
      )
      .get(userId, purpose, now()) as { email: string; expires_at: string } | undefined
    return row ? { email: row.email, expiresAt: row.expires_at } : null
  }

  drop(userId: string, purpose: TokenPurpose): number {
    const result = this.db
      .prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?')
      .run(userId, purpose)
    return Number(result.changes)
  }

  consume(token: string, purpose: TokenPurpose): EmailToken | null {
    const hash = hashToken(token)
    const row = this.db
      .prepare('SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ?')
      .get(hash, purpose) as
      | {
          user_id: string
          purpose: TokenPurpose
          email: string
          expires_at: string
          used_at: string | null
          persist: number
        }
      | undefined
    if (!row || row.used_at) return null
    if (new Date(row.expires_at).getTime() < Date.now()) return null

    this.db.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?').run(now(), hash)
    return {
      userId: row.user_id,
      purpose: row.purpose,
      email: row.email,
      expiresAt: row.expires_at,
      persist: row.persist !== 0,
    }
  }

  purgeExpired(): number {
    const result = this.db.prepare('DELETE FROM email_tokens WHERE expires_at < ?').run(now())
    return Number(result.changes)
  }
}

export class Devices {
  constructor(private readonly db: Db) {}

  create(userId: string, label: string, proxyStore: boolean): { device: Device; token: string } {
    const id = randomUUID()
    const token = generateToken()
    this.db
      .prepare(
        `INSERT INTO devices (id, token_hash, token_enc, user_id, label, proxy_store, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, hashToken(token), encryptSecret(token), userId, label, proxyStore ? 1 : 0, now())
    return { device: this.byId(id)!, token }
  }

  byId(id: string): Device | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as
      | DeviceRow
      | undefined
    return row ? toDevice(row) : null
  }

  byToken(token: string): Device | null {
    const row = this.db
      .prepare('SELECT * FROM devices WHERE token_hash = ?')
      .get(hashToken(token)) as DeviceRow | undefined
    return row ? toDevice(row) : null
  }

  listForUser(userId: string): Device[] {
    const rows = this.db
      .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at')
      .all(userId) as unknown as DeviceRow[]
    return rows.map(toDevice)
  }

  rotateToken(id: string): string {
    const token = generateToken()
    this.db
      .prepare('UPDATE devices SET token_hash = ?, token_enc = ? WHERE id = ?')
      .run(hashToken(token), encryptSecret(token), id)
    return token
  }

  setProxyStore(id: string, proxyStore: boolean): void {
    this.db.prepare('UPDATE devices SET proxy_store = ? WHERE id = ?').run(proxyStore ? 1 : 0, id)
  }

  rename(id: string, label: string): void {
    this.db.prepare('UPDATE devices SET label = ? WHERE id = ?').run(label, id)
  }

  recordSeen(id: string, koboDeviceId?: string, koboUserId?: string): void {
    this.db
      .prepare(
        `UPDATE devices
         SET last_seen_at = ?,
             kobo_device_id = COALESCE(?, kobo_device_id),
             kobo_user_id = COALESCE(?, kobo_user_id)
         WHERE id = ?`
      )
      .run(now(), koboDeviceId ?? null, koboUserId ?? null, id)
  }

  recordSyncFailure(id: string): void {
    this.db.prepare('UPDATE devices SET last_sync_failed_at = ? WHERE id = ?').run(now(), id)
  }

  clearSyncFailure(id: string): void {
    this.db.prepare('UPDATE devices SET last_sync_failed_at = NULL WHERE id = ?').run(id)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id)
  }
}

export class Sessions {
  constructor(private readonly db: Db) {}

  create(userId: string, ttlSeconds: number, userAgent: string, ip: string): Session {
    const id = randomUUID()
    const started = now()
    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString()
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, user_agent, ip, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, userId, userAgent.slice(0, 400), ip, started, started, expires)
    return this.byId(id)!
  }

  byId(id: string): Session | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?')
      .get(id, now()) as SessionRow | undefined
    return row ? toSession(row) : null
  }

  listForUser(userId: string): Session[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC'
      )
      .all(userId, now()) as unknown as SessionRow[]
    return rows.map(toSession)
  }

  touch(id: string, ttlSeconds: number): void {
    const seen = now()
    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString()
    this.db
      .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(seen, expires, id)
  }

  revoke(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  revokeOthers(userId: string, keepId: string): number {
    const result = this.db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?')
      .run(userId, keepId)
    return Number(result.changes)
  }

  purgeExpired(): number {
    const result = this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now())
    return Number(result.changes)
  }
}

export interface Book {
  id: string
  userId: string
  name: string
  title: string
  authors: string[]
  format: string
  size: number
  path: string
  coverPath: string | null
  coverType: string | null
  source: 'send' | 'convert'
  deviceId: string | null
  archivedAt: string | null
  createdAt: string
  expiresAt: string
}

interface BookRow {
  id: string
  user_id: string
  name: string
  title: string
  authors: string
  format: string
  size: number
  path: string
  cover_path: string | null
  cover_type: string | null
  source: 'send' | 'convert'
  device_id: string | null
  archived_at: string | null
  created_at: string
  expires_at: string
}

function toBook(row: BookRow): Book {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    title: row.title,
    authors: row.authors ? row.authors.split('\n') : [],
    format: row.format,
    size: row.size,
    path: row.path,
    coverPath: row.cover_path,
    coverType: row.cover_type,
    source: row.source,
    deviceId: row.device_id,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

export class Books {
  constructor(private readonly db: Db) {}

  countByUser(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT user_id, COUNT(*) AS n FROM books GROUP BY user_id')
      .all() as unknown as { user_id: string; n: number }[]
    return new Map(rows.map((row) => [row.user_id, row.n]))
  }

  create(
    input: Omit<Book, 'createdAt' | 'deviceId' | 'archivedAt'> & {
      createdAt?: string
      deviceId?: string | null
    }
  ): Book {
    const created = input.createdAt ?? now()
    this.db
      .prepare(
        `INSERT INTO books
           (id, user_id, name, title, authors, format, size, path,
            cover_path, cover_type, source, device_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.userId,
        input.name,
        input.title,
        input.authors.join('\n'),
        input.format,
        input.size,
        input.path,
        input.coverPath,
        input.coverType,
        input.source,
        input.deviceId ?? null,
        created,
        input.expiresAt
      )
    return this.byId(input.id)!
  }

  forDevice(deviceId: string, userId: string): Book[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM books
         WHERE device_id = ? AND user_id = ? AND archived_at IS NULL AND expires_at > ?
         ORDER BY created_at ASC`
      )
      .all(deviceId, userId, now()) as unknown as BookRow[]
    return rows.map(toBook)
  }

  byIdForDevice(id: string, deviceId: string, userId: string): Book | null {
    const row = this.db
      .prepare(
        `SELECT * FROM books
         WHERE id = ? AND device_id = ? AND user_id = ? AND archived_at IS NULL
           AND expires_at > ?`
      )
      .get(id, deviceId, userId, now()) as BookRow | undefined
    return row ? toBook(row) : null
  }

  archiveForDevice(id: string, deviceId: string): void {
    this.db
      .prepare('UPDATE books SET archived_at = ? WHERE id = ? AND device_id = ?')
      .run(now(), id, deviceId)
  }

  byId(id: string): Book | null {
    const row = this.db
      .prepare('SELECT * FROM books WHERE id = ? AND expires_at > ?')
      .get(id, now()) as BookRow | undefined
    return row ? toBook(row) : null
  }

  listForUser(userId: string): Book[] {
    const rows = this.db
      .prepare('SELECT * FROM books WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC')
      .all(userId, now()) as unknown as BookRow[]
    return rows.map(toBook)
  }

  bytesForUser(userId: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(size), 0) AS total FROM books WHERE user_id = ? AND expires_at > ?'
      )
      .get(userId, now()) as { total: number }
    return Number(row.total)
  }

  bytesTotal(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(size), 0) AS total FROM books WHERE expires_at > ?')
      .get(now()) as { total: number }
    return Number(row.total)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM books WHERE id = ?').run(id)
  }

  takeExpired(): Book[] {
    const cutoff = now()
    const rows = this.db
      .prepare('SELECT * FROM books WHERE expires_at <= ?')
      .all(cutoff) as unknown as BookRow[]
    if (rows.length > 0) {
      this.db.prepare('DELETE FROM books WHERE expires_at <= ?').run(cutoff)
    }
    return rows.map(toBook)
  }

  listAll(): Book[] {
    const rows = this.db.prepare('SELECT * FROM books').all() as unknown as BookRow[]
    return rows.map(toBook)
  }

  takeAllForUser(userId: string): Book[] {
    const rows = this.db
      .prepare('SELECT * FROM books WHERE user_id = ?')
      .all(userId) as unknown as BookRow[]
    if (rows.length > 0) {
      this.db.prepare('DELETE FROM books WHERE user_id = ?').run(userId)
    }
    return rows.map(toBook)
  }
}

export interface Passkey {
  id: string
  userId: string
  label: string
  publicKey: string
  counter: number
  transports: string[]
  createdAt: string
  lastUsedAt: string | null
}

interface PasskeyRow {
  id: string
  user_id: string
  label: string
  public_key: string
  counter: number
  transports: string
  created_at: string
  last_used_at: string | null
}

function toPasskey(row: PasskeyRow): Passkey {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    publicKey: row.public_key,
    counter: row.counter,
    transports: row.transports ? row.transports.split(',') : [],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

export class Passkeys {
  constructor(private readonly db: Db) {}

  create(input: {
    id: string
    userId: string
    label: string
    publicKey: string
    counter: number
    transports: string[]
  }): Passkey {
    this.db
      .prepare(
        `INSERT INTO passkeys (id, user_id, label, public_key, counter, transports, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.userId,
        input.label,
        input.publicKey,
        input.counter,
        input.transports.join(','),
        now()
      )
    return this.byId(input.id)!
  }

  byId(id: string): Passkey | null {
    const row = this.db.prepare('SELECT * FROM passkeys WHERE id = ?').get(id) as
      | PasskeyRow
      | undefined
    return row ? toPasskey(row) : null
  }

  userIdsWithAny(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT user_id FROM passkeys').all() as unknown as {
      user_id: string
    }[]
    return rows.map((row) => row.user_id)
  }

  removeAll(): number {
    const before = this.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get() as unknown as {
      n: number
    }
    this.db.prepare('DELETE FROM passkeys').run()
    return before.n
  }

  listForUser(userId: string): Passkey[] {
    const rows = this.db
      .prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at')
      .all(userId) as unknown as PasskeyRow[]
    return rows.map(toPasskey)
  }

  countForUser(userId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?')
      .get(userId) as { n: number }
    return row.n
  }

  recordUse(id: string, counter: number): void {
    this.db
      .prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(counter, now(), id)
  }

  rename(id: string, label: string): void {
    this.db.prepare('UPDATE passkeys SET label = ? WHERE id = ?').run(label, id)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM passkeys WHERE id = ?').run(id)
  }
}

export type CodePurpose = 'second_factor' | 'account'

export class RecoveryCodes {
  constructor(private readonly db: Db) {}

  replaceAll(userId: string, codes: string[], purpose: CodePurpose = 'second_factor'): void {
    this.db
      .prepare('DELETE FROM recovery_codes WHERE user_id = ? AND purpose = ?')
      .run(userId, purpose)
    const insert = this.db.prepare(
      'INSERT INTO recovery_codes (code_hash, user_id, created_at, purpose) VALUES (?, ?, ?, ?)'
    )
    const stamp = now()
    for (const code of codes) {
      insert.run(hashToken(normaliseCode(code)), userId, stamp, purpose)
    }
  }

  matches(userId: string, code: string, purpose: CodePurpose): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM recovery_codes
         WHERE code_hash = ? AND user_id = ? AND purpose = ? AND used_at IS NULL`
      )
      .get(hashToken(normaliseCode(code)), userId, purpose)
    return row !== undefined
  }

  has(userId: string, purpose: CodePurpose): boolean {
    const row = this.db
      .prepare('SELECT 1 AS hit FROM recovery_codes WHERE user_id = ? AND purpose = ? LIMIT 1')
      .get(userId, purpose)
    return row !== undefined
  }

  consume(userId: string, code: string, purpose: CodePurpose = 'second_factor'): boolean {
    const hash = hashToken(normaliseCode(code))
    const result = this.db
      .prepare(
        `UPDATE recovery_codes SET used_at = ?
         WHERE code_hash = ? AND user_id = ? AND purpose = ? AND used_at IS NULL`
      )
      .run(now(), hash, userId, purpose)
    return Number(result.changes) === 1
  }

  counts(
    userId: string,
    purpose: CodePurpose = 'second_factor'
  ): { unused: number; total: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS unused
         FROM recovery_codes WHERE user_id = ? AND purpose = ?`
      )
      .get(userId, purpose) as { total: number; unused: number | null }
    return { unused: Number(row.unused ?? 0), total: Number(row.total) }
  }

  clear(userId: string, purpose: CodePurpose = 'second_factor'): void {
    this.db
      .prepare('DELETE FROM recovery_codes WHERE user_id = ? AND purpose = ?')
      .run(userId, purpose)
  }

  clearEverything(userId: string): void {
    this.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId)
  }
}

export function normaliseCode(code: string): string {
  return code.replace(/[\s-]/g, '').toLowerCase()
}

export class Meta {
  constructor(private readonly db: Db) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  flag(key: string): boolean {
    return this.get(key) === '1'
  }
}

export interface Repositories {
  users: Users
  identities: Identities
  emailTokens: EmailTokens
  devices: Devices
  sessions: Sessions
  books: Books
  passkeys: Passkeys
  recoveryCodes: RecoveryCodes
  meta: Meta
}

export function createRepositories(db: Db): Repositories {
  return {
    users: new Users(db),
    identities: new Identities(db),
    emailTokens: new EmailTokens(db),
    devices: new Devices(db),
    sessions: new Sessions(db),
    books: new Books(db),
    passkeys: new Passkeys(db),
    recoveryCodes: new RecoveryCodes(db),
    meta: new Meta(db),
  }
}
