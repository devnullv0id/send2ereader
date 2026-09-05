import { dirname, isAbsolute, join, resolve } from 'node:path'
import { readOrCreateSessionSecret, SECRET_FILE, WEAK_SECRET_LENGTH } from './auth/secret.js'
import { envFile, envFileLoaded } from './env.js'

export const rootDir = resolve(import.meta.dirname, '..')

export { envFile, envFileLoaded }

function raw(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined) return undefined

  const trimmed = value.trim()
  const quote = trimmed[0]
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1)
    if (end > 0) return trimmed.slice(1, end)
  }
  return trimmed
}

function str(name: string, fallback: string): string {
  const value = raw(name)
  return value === undefined || value === '' ? fallback : value
}

function int(name: string, fallback: number, options: { allowZero?: boolean } = {}): number {
  const value = raw(name)
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  const floor = options.allowZero ? 0 : 1
  if (!Number.isFinite(parsed) || parsed < floor) {
    const expected = options.allowZero ? 'a non-negative integer' : 'a positive integer'
    throw new Error(`Invalid value for ${name}: ${value} (expected ${expected})`)
  }
  return parsed
}

function bool(name: string, fallback: boolean): boolean {
  const value = raw(name)
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

const TRUTHY = ['1', 'true', 'yes', 'on']
const FALSY = ['0', 'false', 'no', 'off', 'none']

export function proxyTrust(value: string | undefined, fallback: boolean): boolean | string {
  if (value === undefined || value === '') return fallback
  const lowered = value.trim().toLowerCase()
  if (TRUTHY.includes(lowered)) return true
  if (FALSY.includes(lowered)) return false
  return value.trim()
}

function dir(name: string, fallback: string): string {
  const value = str(name, fallback)
  return isAbsolute(value) ? value : join(rootDir, value)
}

function publicBase(): string {
  const protocol = str('PROTOCOL', 'http')
  const domain = str('DOMAIN', '')
  if (domain) return `${protocol}://${domain}`

  const addr = str('HTTP_ADDR', '0.0.0.0')
  const host = addr === '0.0.0.0' || addr === '::' ? 'localhost' : addr
  return `${protocol}://${host}:${int('HTTP_PORT', 3001)}`
}

export const config = {
  httpAddr: str('HTTP_ADDR', '0.0.0.0'),
  httpPort: int('HTTP_PORT', 3001),
  protocol: str('PROTOCOL', 'http'),
  domain: str('DOMAIN', ''),
  trustProxy: proxyTrust(raw('TRUST_PROXY'), false),
  language: str('LANGUAGE', 'en'),

  dataDir: dir('DATA_DIR', 'data'),
  uploadDir: dir('UPLOAD_DIR', 'uploads'),
  staticDir: dir('STATIC_DIR', 'static'),
  cleanUploadDirOnBoot: bool('CLEAN_UPLOAD_DIR_ON_BOOT', true),

  expireSeconds: int('EXPIRE_SECONDS', 5 * 60),
  maxExpireSeconds: int('MAX_EXPIRE_SECONDS', 10 * 60),
  ereaderPollSeconds: int('EREADER_POLL_SECONDS', 2),
  maxFileSize: int('MAX_FILE_SIZE', 1024 * 1024 * 800),
  keyLength: int('KEY_LENGTH', 4),

  convertTtlSeconds: int('CONVERT_TTL', 30 * 60),

  library: {
    dir: dir('LIBRARY_DIR', 'library'),
    retainDays: int('RETAIN_DAYS', 0, { allowZero: true }),
    perUserBytes: int('STORAGE_PER_USER', 1024 * 1024 * 1024),
    totalBytes: int('STORAGE_TOTAL', 10 * 1024 * 1024 * 1024),
  },

  kobo: {
    queueDir: dir('KOBO_QUEUE_DIR', 'queue'),
    queueTtlSeconds: int('KOBO_QUEUE_TTL', 6 * 60 * 60),
    storeUrl: str('KOBO_STORE_URL', 'https://storeapi.kobo.com'),
    imageBaseUrl: str('KOBO_IMAGE_BASE_URL', 'https://cdn.kobo.com/book-images'),
    proxyTimeoutMs: int('KOBO_PROXY_TIMEOUT_MS', 10_000),
    proxyBodyLimit: int('KOBO_PROXY_BODY_LIMIT', 1024 * 1024),
  },

  conversionTimeoutMs: int('CONVERSION_TIMEOUT_MS', 10 * 60 * 1000),
  conversionOutputLimit: int('CONVERSION_OUTPUT_LIMIT', 64 * 1024),
  conversionConcurrency: int('CONVERSION_CONCURRENCY', 2),

  bin: {
    kepubify: str('KEPUBIFY_BIN', 'kepubify'),
    ebookConvert: str('EBOOK_CONVERT_BIN', 'ebook-convert'),
    pdfCropMargins: str('PDFCROPMARGINS_BIN', 'pdfcropmargins'),
    calibreCustomize: str('CALIBRE_CUSTOMIZE_BIN', 'calibre-customize'),
    layoutFix: str('EPUB_LAYOUT_FIX_BIN', 'epub-layout-fix'),
  },

  extensions: str('EXTENSIONS', ''),
  extensionPackages: str('EXTENSION_PACKAGES', ''),
  kfxPreviewerPath: str('KFX_PREVIEWER_PATH', ''),

  layoutFixDefault: bool('LAYOUT_FIX_DEFAULT', true),

  calibreOutputProfile: str('CALIBRE_OUTPUT_PROFILE', 'kindle_pw3'),

  kindleShareNotSync: bool('KINDLE_SHARE_NOT_SYNC', true),

  logLevel: str('LOG_LEVEL', 'info'),
  logPretty: bool('LOG_PRETTY', false),
  convertRateMax: int('CONVERT_RATE_MAX', 5),
  convertRateWindow: str('CONVERT_RATE_WINDOW', '1 minute'),
  logFormat: str('LOG_FORMAT', 'text'),
  logScope: str('LOG_SCOPE', ''),
  logTime: str('LOG_TIME', 'iso'),
  noColor: str('NO_COLOR', ''),

  publicUrl: publicBase().replace(/\/+$/, ''),

  db: {
    path: dir('DB_PATH', 'data/send2ereader.db'),
  },

  auth: {
    accounts: bool('ACCOUNTS', true),
    sessionSecretEnv: str('SESSION_SECRET', ''),
    allowSignup: bool('ALLOW_SIGNUP', false),
    emailTokenTtlSeconds: int('EMAIL_TOKEN_TTL', 24 * 60 * 60),
    signInLinkTtlSeconds: int('SIGNIN_LINK_TTL', 15 * 60),
    allowStaySignedIn: bool('ALLOW_STAY_SIGNED_IN', true),
    verifyReminderLimit: int('VERIFY_REMINDER_LIMIT', 5, { allowZero: true }),
    sessionTtlSeconds: int('SESSION_TTL', 30 * 24 * 60 * 60),
    scryptN: int('SCRYPT_N', 2 ** 16),

    failedSignInsBeforeAlert: int('FAILED_SIGNINS_BEFORE_ALERT', 5),
    failedSignInWindowSeconds: int('FAILED_SIGNIN_WINDOW', 15 * 60),
    failedSignInAlertEverySeconds: int('FAILED_SIGNIN_ALERT_EVERY', 60 * 60),

    minPasswordLength: int('MIN_PASSWORD_LENGTH', 10),
    maxPasswordLength: int('MAX_PASSWORD_LENGTH', 1024),

    requireUpper: bool('PASSWORD_REQUIRE_UPPER', false),
    requireLower: bool('PASSWORD_REQUIRE_LOWER', false),
    requireDigit: bool('PASSWORD_REQUIRE_DIGIT', false),
    requireSymbol: bool('PASSWORD_REQUIRE_SYMBOL', false),
  },

  oidc: {
    enabled: bool('OIDC_ENABLED', false),
    configUrl: str('OIDC_CONFIG_URL', ''),
    clientId: str('OIDC_CLIENT_ID', ''),
    clientSecret: str('OIDC_CLIENT_SECRET', ''),
    providerName: str('OIDC_PROVIDER_NAME', 'SSO'),
    adminGroup: str('OIDC_ADMIN_GROUP', ''),
  },

  mail: {
    enabled: bool('SMTP_ENABLED', false),
    host: str('SMTP_HOST', ''),
    port: int('SMTP_PORT', 587),
    username: str('SMTP_USERNAME', ''),
    password: str('SMTP_PASSWORD', ''),
    fromEmail: str('SMTP_FROM_EMAIL', ''),
    fromName: str('SMTP_FROM_NAME', 'send2ereader'),
    tls: bool('SMTP_TLS', true),
    security: str('SMTP_SECURITY', ''),
    timeoutSeconds: int('SMTP_TIMEOUT_SECONDS', 30),
    logSecrets: bool('MAIL_LOG_SECRETS', false),
  },
} as const

export type SecretOrigin = 'environment' | 'generated' | 'unset'

export const sessionKeyPath = join(dirname(config.db.path), SECRET_FILE)

let secretInForce = config.auth.sessionSecretEnv
let secretOrigin: SecretOrigin = secretInForce ? 'environment' : 'unset'

export function sessionSecret(): string {
  return secretInForce
}

export function sessionSecretOrigin(): SecretOrigin {
  return secretOrigin
}

export function sessionSecretIsWeak(): boolean {
  return secretOrigin === 'environment' && secretInForce.length < WEAK_SECRET_LENGTH
}

export function provisionSessionSecret(): { created: boolean; path: string } {
  if (secretOrigin === 'environment') return { created: false, path: '' }

  const held = readOrCreateSessionSecret(sessionKeyPath)
  secretInForce = held.secret
  secretOrigin = 'generated'
  return { created: held.created, path: sessionKeyPath }
}

export function accountsEnabled(): boolean {
  return config.auth.accounts && sessionSecret().length > 0
}

let resolvedPublicUrl = publicBase().replace(/\/+$/, '')

export function publicUrl(): string {
  return resolvedPublicUrl
}

export function fixPublicUrl(protocol: string, domain: string): void {
  if (!domain) return
  resolvedPublicUrl = `${protocol || 'http'}://${domain}`.replace(/\/+$/, '')
}

export function publicUrlFor(path: string): string {
  return publicUrl() + (path.startsWith('/') ? path : `/${path}`)
}

export function safeNext(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string' || raw === '') return fallback
  try {
    const here = new URL(publicUrl())
    const target = new URL(raw, here)
    if (target.origin !== here.origin) return fallback
    return target.pathname + target.search + target.hash
  } catch {
    return fallback
  }
}

export const keyChars = '23456789ACDEFGHJKLMNPRSTUVWXYZ'
