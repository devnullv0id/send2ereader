import { randomInt } from 'node:crypto'
import { publicUrlFor } from '../config.js'
import type { Repositories, User } from '../db/repositories.js'
import type { Mailer } from '../mail/index.js'
import {
  emailChangeEmail,
  emailMovedEmail,
  failedSignInsEmail,
  passwordChangedEmail,
  resetEmail,
  signInLinkEmail,
  verificationEmail,
  welcomeEmail,
} from '../mail/template.js'
import { qrSvg } from '../qr.js'
import { settings } from '../settings.js'
import { hashPassword, passwordProblem, verifyPassword } from './password.js'
import { makeRecoveryPhrase } from './phrase.js'
import { generateSecret, groupSecret, otpauthUri, verifyTotp } from './totp.js'
import { RP_NAME } from './webauthn.js'

export class AuthError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'AuthError'
    this.statusCode = statusCode
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export const NAME_MAX = 100

export function nameProblem(firstName: string, lastName: string): string | null {
  if (!firstName) return 'A first name is needed'
  if (!lastName) return 'A last name is needed'
  if (firstName.length > NAME_MAX || lastName.length > NAME_MAX) return 'That name is too long'
  return null
}

export interface AuthLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

export interface RequestOrigin {
  when?: string
  where?: string
}

export class AuthService {
  constructor(
    private readonly repos: Repositories,
    private readonly mailer: Mailer,
    private readonly log: AuthLogger
  ) {}

  get unclaimed(): boolean {
    return this.repos.users.isUnclaimed()
  }

  get registrationOpen(): boolean {
    return this.unclaimed || settings.bool('ALLOW_SIGNUP')
  }

  async register(
    emailRaw: string,
    password: string,
    name: { firstName?: string; lastName?: string } = {}
  ): Promise<User> {
    if (!this.registrationOpen) {
      throw new AuthError('Registration is closed on this server', 403)
    }

    const email = normaliseEmail(emailRaw)
    if (!EMAIL_RE.test(email)) throw new AuthError('That does not look like an e-mail address')
    const problem = passwordProblem(password)
    if (problem) throw new AuthError(problem)

    const firstName = (name.firstName ?? '').trim()
    const lastName = (name.lastName ?? '').trim()
    const missing = nameProblem(firstName, lastName)
    if (missing) throw new AuthError(missing)

    const passwordHash = await hashPassword(password)

    if (!this.registrationOpen) {
      throw new AuthError('Registration is closed on this server', 403)
    }
    if (this.repos.users.byEmail(email)) {
      throw new AuthError('An account with that address already exists', 409)
    }
    const user = this.repos.users.create({ email, passwordHash, firstName, lastName })
    this.log.info({ userId: user.id, first: this.repos.users.count() === 1 }, 'Created account')

    try {
      await this.sendVerification(user)
    } catch (err) {
      this.log.warn({ err, userId: user.id }, 'Could not send the verification message')
    }
    return user
  }

  async sendVerification(user: User): Promise<void> {
    if (user.emailVerified) return
    const token = this.repos.emailTokens.issue(
      user.id,
      'verify',
      user.email,
      settings.int('EMAIL_TOKEN_TTL')
    )
    const link = publicUrlFor(`/auth/verify?token=${encodeURIComponent(token)}`)
    await this.mailer.send({
      to: user.email,
      ...verificationEmail(link, settings.int('EMAIL_TOKEN_TTL')),
    })
  }

  verify(token: string): User {
    const consumed = this.repos.emailTokens.consume(token, 'verify')
    if (!consumed) throw new AuthError('That verification link is invalid or has expired', 400)
    this.repos.users.markVerified(consumed.userId)
    this.dropRecoveryPhrase(consumed.userId)
    this.log.info({ userId: consumed.userId }, 'Verified e-mail address')

    const user = this.repos.users.byId(consumed.userId)!
    void this.sendWelcome(user)
    return user
  }

  verifyNudge(user: User): { needed: boolean; remindersLeft: number } {
    const limit = settings.int('VERIFY_REMINDER_LIMIT')
    return {
      needed: !user.emailVerified && settings.bool('SMTP_ENABLED'),
      remindersLeft: this.repos.users.verifyRemindersLeft(user.id, limit),
    }
  }

  remindLater(userId: string): number {
    const limit = settings.int('VERIFY_REMINDER_LIMIT')
    if (this.repos.users.verifyRemindersLeft(userId, limit) <= 0) {
      throw new AuthError('There are no reminders left on this account', 409)
    }
    return this.repos.users.spendVerifyReminder(userId, limit)
  }

  async requestEmailChange(userId: string, emailRaw: string): Promise<string> {
    const user = this.repos.users.byId(userId)
    if (!user) throw new AuthError('Unknown account', 404)

    const email = normaliseEmail(emailRaw)
    if (!EMAIL_RE.test(email)) throw new AuthError('That does not look like an e-mail address')
    if (email === user.email)
      throw new AuthError('That is already the address on this account', 409)

    const taken = this.repos.users.byEmail(email)
    if (taken) throw new AuthError('An account with that address already exists', 409)

    const token = this.repos.emailTokens.issue(
      userId,
      'email_change',
      email,
      settings.int('EMAIL_TOKEN_TTL')
    )
    const link = publicUrlFor(`/auth/email/confirm?token=${encodeURIComponent(token)}`)
    await this.mailer.send({
      to: email,
      ...emailChangeEmail(link, settings.int('EMAIL_TOKEN_TTL')),
    })
    this.log.info({ userId }, 'Asked a new address to confirm itself')
    return email
  }

  pendingEmail(userId: string): string | null {
    return this.repos.emailTokens.pending(userId, 'email_change')?.email ?? null
  }

  cancelEmailChange(userId: string): boolean {
    return this.repos.emailTokens.drop(userId, 'email_change') > 0
  }

  confirmEmailChange(token: string): User {
    const consumed = this.repos.emailTokens.consume(token, 'email_change')
    if (!consumed) throw new AuthError('That link is invalid or has expired', 400)

    const user = this.repos.users.byId(consumed.userId)
    if (!user) throw new AuthError('Unknown account', 404)

    const taken = this.repos.users.byEmail(consumed.email)
    if (taken && taken.id !== user.id) {
      throw new AuthError('An account with that address already exists', 409)
    }

    const wasAt = user.email
    this.repos.users.setEmail(user.id, consumed.email)
    this.dropRecoveryPhrase(user.id)
    this.log.warn({ userId: user.id }, 'The address on an account changed')

    void this.tellTheOldAddress(wasAt, consumed.email)
    return this.repos.users.byId(user.id)!
  }

  private async tellTheOldAddress(was: string, now: string): Promise<void> {
    try {
      await this.mailer.send({
        to: was,
        ...emailMovedEmail(publicUrlFor('/'), now, new Date().toUTCString()),
      })
    } catch (err) {
      this.log.warn({ err }, 'Could not tell the old address that it had been replaced')
    }
  }

  private async sendWelcome(user: User): Promise<void> {
    const link = publicUrlFor('/')
    const host = new URL(link).origin
    try {
      await this.mailer.send({ to: user.email, ...welcomeEmail(link, host) })
    } catch {
      this.log.warn({ userId: user.id }, 'Could not send the welcome message')
    }
  }

  async login(emailRaw: string, password: string, from: RequestOrigin = {}): Promise<User> {
    const email = normaliseEmail(emailRaw)
    const user = this.repos.users.byEmail(email)

    const stored = user?.passwordHash ?? (await dummyHash())
    const ok = await verifyPassword(password, stored)

    if (!user?.passwordHash || !ok) {
      this.log.warn({ email }, 'Failed login')
      if (user) await this.countFailure(user, from)
      throw new AuthError('Incorrect e-mail address or password', 401)
    }

    this.misses.delete(user.id)
    this.repos.users.touchLogin(user.id)
    return user
  }

  private readonly misses = new Map<string, { count: number; since: number; told: number }>()

  private async countFailure(user: User, from: RequestOrigin): Promise<void> {
    const now = Date.now()
    const window = settings.int('FAILED_SIGNIN_WINDOW') * 1000
    const previous = this.misses.get(user.id)
    const run =
      previous && now - previous.since < window
        ? { ...previous, count: previous.count + 1 }
        : { count: 1, since: now, told: 0 }
    this.misses.set(user.id, run)

    if (run.count < settings.int('FAILED_SIGNINS_BEFORE_ALERT')) return
    if (now - run.told < settings.int('FAILED_SIGNIN_ALERT_EVERY') * 1000) return

    run.told = now
    this.misses.set(user.id, run)

    try {
      await this.mailer.send({
        to: user.email,
        ...failedSignInsEmail(
          publicUrlFor('/auth/forgot'),
          run.count,
          from.when ?? new Date().toUTCString(),
          from.where ?? 'an unknown address'
        ),
      })
      this.log.warn(
        { userId: user.id, attempts: run.count },
        'Told the account about failed sign-ins'
      )
    } catch (err) {
      this.log.warn({ err, userId: user.id }, 'Could not send the failed sign-in notice')
    }
  }

  async requestReset(emailRaw: string): Promise<void> {
    const email = normaliseEmail(emailRaw)
    const user = this.repos.users.byEmail(email)
    if (!user) {
      this.log.info({ email }, 'Password reset requested for an unknown address')
      return
    }
    const token = this.repos.emailTokens.issue(
      user.id,
      'reset',
      user.email,
      settings.int('EMAIL_TOKEN_TTL')
    )
    const link = publicUrlFor(`/auth/reset?token=${encodeURIComponent(token)}`)
    try {
      await this.mailer.send({
        to: user.email,
        ...resetEmail(link, settings.int('EMAIL_TOKEN_TTL')),
      })
    } catch (err) {
      this.log.warn({ err, userId: user.id }, 'Could not send the reset message')
    }
  }

  async requestSignInLink(emailRaw: string, persist = true): Promise<void> {
    const email = normaliseEmail(emailRaw)
    const user = this.repos.users.byEmail(email)
    if (!user) {
      this.log.info({ email }, 'Sign-in link requested for an unknown address')
      return
    }

    if (this.repos.emailTokens.hasActive(user.id, 'signin')) {
      this.log.info({ userId: user.id }, 'A sign-in link is already out; not sending another')
      return
    }

    const token = this.repos.emailTokens.issue(
      user.id,
      'signin',
      user.email,
      settings.int('SIGNIN_LINK_TTL'),
      persist
    )
    const link = publicUrlFor(`/auth/link?token=${encodeURIComponent(token)}`)
    try {
      await this.mailer.send({
        to: user.email,
        ...signInLinkEmail(link, settings.int('SIGNIN_LINK_TTL')),
      })
      this.log.info({ userId: user.id }, 'Sent a sign-in link')
    } catch (err) {
      this.log.warn({ err, userId: user.id }, 'Could not send the sign-in link')
    }
  }

  consumeSignInLink(token: string): { user: User; persist: boolean } {
    const consumed = this.repos.emailTokens.consume(token, 'signin')
    if (!consumed) throw new AuthError('That sign-in link is invalid or has expired', 400)

    this.repos.users.markVerified(consumed.userId)
    this.repos.users.touchLogin(consumed.userId)
    this.log.info({ userId: consumed.userId }, 'Signed in from a link')
    return { user: this.repos.users.byId(consumed.userId)!, persist: consumed.persist }
  }

  async resetPassword(token: string, password: string): Promise<User> {
    const problem = passwordProblem(password)
    if (problem) throw new AuthError(problem)

    const consumed = this.repos.emailTokens.consume(token, 'reset')
    if (!consumed) throw new AuthError('That reset link is invalid or has expired', 400)

    this.repos.users.setPassword(consumed.userId, await hashPassword(password))
    this.repos.users.markVerified(consumed.userId)
    this.log.info({ userId: consumed.userId }, 'Password reset')
    return this.repos.users.byId(consumed.userId)!
  }

  async changePassword(
    userId: string,
    current: string,
    next: string,
    from: RequestOrigin = {}
  ): Promise<void> {
    const user = this.repos.users.byId(userId)
    if (!user) throw new AuthError('Unknown account', 404)

    if (user.passwordHash) {
      const ok = await verifyPassword(current, user.passwordHash)
      if (!ok) {
        this.log.warn({ userId }, 'Password change refused: current password did not match')
        throw new AuthError('That is not your current password', 403)
      }
    }

    const problem = passwordProblem(next)
    if (problem) throw new AuthError(problem)

    this.repos.users.setPassword(userId, await hashPassword(next))
    this.log.info({ userId }, 'Password changed')

    try {
      await this.mailer.send({
        to: user.email,
        ...passwordChangedEmail(
          publicUrlFor('/auth/forgot'),
          from.when ?? new Date().toISOString(),
          from.where ?? 'an unknown address'
        ),
      })
    } catch {
      this.log.warn({ userId }, 'Could not send the password-changed notice')
    }
  }

  async reauthenticate(userId: string, password?: string, code?: string): Promise<boolean> {
    const user = this.repos.users.byId(userId)
    if (!user) return false

    if (!user.passwordHash && !user.totpEnabled) return true

    if (user.passwordHash && password && (await verifyPassword(password, user.passwordHash))) {
      return true
    }
    if (user.totpEnabled && code && this.verifySecondFactor(userId, code) !== null) return true

    this.log.warn({ userId }, 'Could not confirm it was the account holder')
    return false
  }

  reauthenticationNeeds(userId: string): { password: boolean; code: boolean } {
    const user = this.repos.users.byId(userId)
    return { password: user?.passwordHash !== null, code: user?.totpEnabled === true }
  }

  beginTotp(userId: string): { secret: string; typed: string; uri: string; svg: string | null } {
    const user = this.repos.users.byId(userId)
    if (!user) throw new AuthError('Unknown account', 404)
    if (user.totpEnabled) throw new AuthError('Two-factor is already on for this account', 409)

    const secret = generateSecret()
    this.repos.users.stageTotpSecret(userId, secret)

    const uri = otpauthUri(secret, user.email, RP_NAME)
    let svg: string | null = null
    try {
      svg = qrSvg(uri)
    } catch {
      this.log.warn({ userId }, 'That address is too long to fit in a QR code')
    }
    return { secret, typed: groupSecret(secret), uri, svg }
  }

  confirmTotp(userId: string, code: string): string[] {
    const user = this.repos.users.byId(userId)
    if (!user) throw new AuthError('Unknown account', 404)
    if (user.totpEnabled) throw new AuthError('Two-factor is already on for this account', 409)

    const secret = this.repos.users.totpSecret(userId)
    if (!secret) throw new AuthError('Start the setup again — there is no secret to confirm', 409)
    if (!verifyTotp(secret, code)) throw new AuthError('That code did not match', 400)

    this.repos.users.enableTotp(userId)
    this.log.info({ userId }, 'Turned on two-factor')
    return this.issueRecoveryCodes(userId)
  }

  disableTotp(userId: string): void {
    const user = this.repos.users.byId(userId)
    if (!user) throw new AuthError('Unknown account', 404)
    this.repos.users.disableTotp(userId)
    this.repos.recoveryCodes.clear(userId)
    this.log.info({ userId }, 'Turned off two-factor')
  }

  issueRecoveryCodes(userId: string): string[] {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => makeRecoveryCode())
    this.repos.recoveryCodes.replaceAll(userId, codes)
    return codes
  }

  recoveryCodeCounts(userId: string): { unused: number; total: number } {
    return this.repos.recoveryCodes.counts(userId)
  }

  get recoveryPhraseNeeded(): boolean {
    return !settings.bool('SMTP_ENABLED')
  }

  issueRecoveryPhrase(userId: string): string {
    const phrase = makeRecoveryPhrase()
    this.repos.recoveryCodes.replaceAll(userId, [phrase], 'account')
    this.log.info({ userId }, 'Issued an account recovery phrase')
    return phrase
  }

  hasRecoveryPhrase(userId: string): boolean {
    return this.repos.recoveryCodes.has(userId, 'account')
  }

  dropRecoveryPhrase(userId: string): void {
    this.repos.recoveryCodes.clear(userId, 'account')
  }

  async signInWithPhrase(
    emailRaw: string,
    phrase: string,
    from: RequestOrigin = {}
  ): Promise<User> {
    const email = normaliseEmail(emailRaw)
    const user = this.repos.users.byEmail(email)

    if (!user || !this.repos.recoveryCodes.matches(user.id, phrase, 'account')) {
      this.log.warn({ email }, 'Recovery phrase did not match')
      if (user) await this.countFailure(user, from)
      throw new AuthError('That recovery phrase does not match that address', 401)
    }

    this.log.warn({ userId: user.id }, 'Signed in with the account recovery phrase')
    this.misses.delete(user.id)
    this.repos.users.touchLogin(user.id)
    return user
  }

  verifySecondFactor(userId: string, code: string): 'totp' | 'recovery' | null {
    const secret = this.repos.users.totpSecret(userId)
    if (secret && verifyTotp(secret, code)) return 'totp'
    if (this.repos.recoveryCodes.consume(userId, code)) {
      this.log.warn({ userId }, 'Signed in with a recovery code')
      return 'recovery'
    }
    this.log.warn({ userId }, 'Second factor did not match')
    return null
  }

  linkOidcUser(input: {
    issuer: string
    subject: string
    email?: string
    emailVerified?: boolean
  }): User {
    const linked = this.repos.identities.findUserId(input.issuer, input.subject)
    if (linked) {
      const user = this.repos.users.byId(linked)
      if (user) return user
    }

    const email = input.email ? normaliseEmail(input.email) : null
    if (!email) throw new AuthError('The identity provider did not supply an e-mail address', 400)

    const existing = this.repos.users.byEmail(email)
    if (existing) {
      if (!input.emailVerified) {
        throw new AuthError(
          'That address already has an account here, and your identity provider did not confirm it',
          409
        )
      }
      this.repos.identities.link(existing.id, input.issuer, input.subject)
      return existing
    }

    const user = this.repos.users.create({
      email,
      passwordHash: null,
      emailVerified: input.emailVerified === true,
    })
    this.repos.identities.link(user.id, input.issuer, input.subject)
    this.log.info({ userId: user.id, issuer: input.issuer }, 'Created account from SSO')
    return user
  }
}

const RECOVERY_CODE_COUNT = 10
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function makeRecoveryCode(): string {
  let out = ''
  for (let i = 0; i < 10; i++) {
    if (i === 5) out += '-'
    out += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]
  }
  return out
}

let dummy: Promise<string> | null = null

function dummyHash(): Promise<string> {
  dummy ??= hashPassword('no account has this password')
  return dummy
}
