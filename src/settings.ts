import { config, envFile, sessionSecret, sessionSecretOrigin } from './config.js'
import type { Db } from './db/index.js'
import { decryptSecret, encryptSecret } from './db/secretbox.js'
import { i18n } from './i18n.js'

export type SettingKind = 'bool' | 'int' | 'string' | 'secret' | 'choice' | 'toggled'

export interface SettingSpec {
  key: string
  group: string
  label: string
  note?: string
  kind: SettingKind
  min?: number
  max?: number
  unit?: string
  placeholder?: string
  inlineWith?: string
  choices?: { value: string; label: string }[]
  restart?: boolean
  readOnly?: boolean
  check?: (value: string, lang?: string) => string | null
  env: () => string
}

export type SettingOrigin = 'environment' | 'default' | 'generated'

export interface SettingGroup {
  id: string
  title: string
  intro: string
}

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: 'server',
    title: 'Address',
    intro: 'The address this server calls itself. Takes a restart.',
  },
  {
    id: 'language',
    title: 'Language',
    intro: 'What this server speaks until a visitor picks their own.',
  },
  {
    id: 'accounts',
    title: 'Accounts',
    intro: 'Who may create an account here, and how long a sign-in lasts.',
  },
  {
    id: 'passwords',
    title: 'Passwords',
    intro: 'Length does more than any composition rule.',
  },
  {
    id: 'guessing',
    title: 'Failed sign-ins',
    intro: 'Nothing locks an account; the address gets a notice instead.',
  },
  {
    id: 'mail',
    title: 'Mail',
    intro: 'Without mail there is no verification, reset or sign-in link.',
  },
  {
    id: 'sso',
    title: 'Single sign-on',
    intro: 'An OpenID Connect provider does the signing in.',
  },
  {
    id: 'sending',
    title: 'Sending',
    intro: 'The key flow everyone gets, signed in or not.',
  },
  {
    id: 'converting',
    title: 'Converting',
    intro: 'What happens to a book between arriving and being collected.',
  },
  {
    id: 'library',
    title: 'Library',
    intro: 'How much may be kept, and for how long.',
  },
  {
    id: 'kobo',
    title: 'Kobo sync',
    intro: 'A Kobo talks to this server; the rest is passed through.',
  },
  {
    id: 'listen',
    title: 'Server',
    intro: 'Where the process listens. Set in the environment; takes a restart.',
  },
  {
    id: 'storage',
    title: 'Storage',
    intro: 'Where everything is kept. Set in the environment; takes a restart.',
  },
  {
    id: 'logging',
    title: 'Logging',
    intro: 'How much this server writes down. Set in the environment; takes a restart.',
  },
  {
    id: 'converters',
    title: 'Converter paths',
    intro: 'Which executable each conversion runs. Set in the environment; takes a restart.',
  },
  {
    id: 'extensions',
    title: 'Extensions',
    intro: 'Fetched in the background at start; set in the environment.',
  },
  {
    id: 'security',
    title: 'Security',
    intro: 'Set in the environment, so a browser cannot weaken them.',
  },
]

const TRUTHY_WORDS = ['1', 'true', 'yes', 'on']

const HOSTNAME =
  /^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)(?::\d{1,5})?$/

function domainProblem(value: string, lang = 'en'): string | null {
  const host = value.trim()
  if (host === '') return null

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(host)) {
    return i18n.translate(
      lang,
      'Just the name, without the https:// in front — the scheme is the field beside it'
    )
  }
  if (/[/?#\\]/.test(host)) {
    return i18n.translate(lang, 'Just the name and a port if you need one, with no path after it')
  }
  if (/\s/.test(host)) return i18n.translate(lang, 'A hostname has no spaces in it')
  if (!HOSTNAME.test(host)) return i18n.translate(lang, '{host} is not a hostname', { host })

  const port = /:(\d{1,5})$/.exec(host)
  if (port && Number(port[1]) > 65535) return i18n.translate(lang, 'That is not a port')
  return null
}

const yesNo = (value: boolean) => (value ? 'true' : 'false')

const trustEnv = (value: boolean | string) => (typeof value === 'string' ? value : yesNo(value))

export const SETTING_SPECS: SettingSpec[] = [
  {
    key: 'PROTOCOL',
    group: 'server',
    label: 'Scheme',
    note: 'Passkeys and a Secure cookie both need https.',
    kind: 'choice',
    choices: [
      { value: 'https', label: 'https' },
      { value: 'http', label: 'http' },
    ],
    inlineWith: 'DOMAIN',
    restart: true,
    env: () => config.protocol,
  },
  {
    key: 'DOMAIN',
    group: 'server',
    label: 'Scheme and domain',
    placeholder: 'books.example.com',
    note: 'A name, not an IP — no browser holds a passkey for an address.',
    kind: 'string',
    restart: true,
    check: domainProblem,
    env: () => config.domain,
  },
  {
    key: 'TRUST_PROXY',
    group: 'server',
    label: 'This server sits behind a reverse proxy',
    placeholder: '192.168.20.2',
    note: "The proxy's address, a CIDR range or loopback — believed from nowhere else.",
    kind: 'toggled',
    restart: true,
    env: () => trustEnv(config.trustProxy),
  },
  {
    key: 'LANGUAGE',
    group: 'language',
    label: 'Default language',
    note: 'Anyone can pick another; new files in the languages folder appear after a restart.',
    kind: 'choice',
    choices: i18n.installed().map((entry) => ({ value: entry.code, label: entry.name })),
    env: () => config.language,
  },
  {
    key: 'ALLOW_SIGNUP',
    group: 'accounts',
    label: 'Anyone may create an account',
    note: 'Off, nobody new can register. Existing accounts still sign in.',
    kind: 'bool',
    env: () => yesNo(config.auth.allowSignup),
  },
  {
    key: 'ALLOW_STAY_SIGNED_IN',
    group: 'accounts',
    label: 'Offer "Stay signed in on this device"',
    note: 'Off, every session ends with the browser.',
    kind: 'bool',
    env: () => yesNo(config.auth.allowStaySignedIn),
  },
  {
    key: 'SESSION_TTL',
    group: 'accounts',
    label: 'A session lasts',
    unit: 'seconds',
    kind: 'int',
    min: 300,
    max: 365 * 24 * 60 * 60,
    env: () => String(config.auth.sessionTtlSeconds),
  },
  {
    key: 'SIGNIN_LINK_TTL',
    group: 'accounts',
    label: 'An emailed sign-in link lasts',
    unit: 'seconds',
    kind: 'int',
    min: 60,
    max: 24 * 60 * 60,
    env: () => String(config.auth.signInLinkTtlSeconds),
  },
  {
    key: 'VERIFY_REMINDER_LIMIT',
    group: 'accounts',
    label: 'An unconfirmed address may put it off',
    unit: 'times',
    note: 'How often an unconfirmed account may answer "not now". Zero asks once.',
    kind: 'int',
    min: 0,
    max: 50,
    env: () => String(config.auth.verifyReminderLimit),
  },
  {
    key: 'EMAIL_TOKEN_TTL',
    group: 'accounts',
    label: 'A verification or reset link lasts',
    unit: 'seconds',
    kind: 'int',
    min: 300,
    max: 30 * 24 * 60 * 60,
    env: () => String(config.auth.emailTokenTtlSeconds),
  },

  {
    key: 'MIN_PASSWORD_LENGTH',
    group: 'passwords',
    label: 'At least',
    unit: 'characters',
    kind: 'int',
    min: 8,
    max: 128,
    env: () => String(config.auth.minPasswordLength),
  },
  {
    key: 'MAX_PASSWORD_LENGTH',
    group: 'passwords',
    label: 'At most',
    unit: 'characters',
    kind: 'int',
    min: 16,
    max: 4096,
    env: () => String(config.auth.maxPasswordLength),
  },
  {
    key: 'PASSWORD_REQUIRE_UPPER',
    group: 'passwords',
    label: 'Must contain a capital letter',
    kind: 'bool',
    env: () => yesNo(config.auth.requireUpper),
  },
  {
    key: 'PASSWORD_REQUIRE_LOWER',
    group: 'passwords',
    label: 'Must contain a small letter',
    kind: 'bool',
    env: () => yesNo(config.auth.requireLower),
  },
  {
    key: 'PASSWORD_REQUIRE_DIGIT',
    group: 'passwords',
    label: 'Must contain a digit',
    kind: 'bool',
    env: () => yesNo(config.auth.requireDigit),
  },
  {
    key: 'PASSWORD_REQUIRE_SYMBOL',
    group: 'passwords',
    label: 'Must contain a symbol',
    note: 'Not a letter, a digit or a space.',
    kind: 'bool',
    env: () => yesNo(config.auth.requireSymbol),
  },

  {
    key: 'FAILED_SIGNINS_BEFORE_ALERT',
    group: 'guessing',
    label: 'Write to the account after',
    unit: 'wrong passwords in a row',
    note: 'Above nine is never reached — sign-in stops at ten tries per five minutes.',
    kind: 'int',
    min: 2,
    max: 9,
    env: () => String(config.auth.failedSignInsBeforeAlert),
  },
  {
    key: 'FAILED_SIGNIN_WINDOW',
    group: 'guessing',
    label: 'A run is broken by a gap of',
    unit: 'seconds',
    kind: 'int',
    min: 60,
    max: 24 * 60 * 60,
    env: () => String(config.auth.failedSignInWindowSeconds),
  },
  {
    key: 'FAILED_SIGNIN_ALERT_EVERY',
    group: 'guessing',
    label: 'At most one notice per account every',
    unit: 'seconds',
    kind: 'int',
    min: 60,
    max: 7 * 24 * 60 * 60,
    env: () => String(config.auth.failedSignInAlertEverySeconds),
  },

  {
    key: 'OIDC_ENABLED',
    group: 'sso',
    label: 'Offer single sign-on',
    kind: 'bool',
    restart: true,
    env: () => yesNo(config.oidc.enabled),
  },
  {
    key: 'OIDC_PROVIDER_NAME',
    placeholder: 'Authentik',
    group: 'sso',
    label: 'Name on the button',
    note: 'Shown on the sign-in button.',
    kind: 'string',
    restart: true,
    env: () => config.oidc.providerName,
  },
  {
    key: 'OIDC_CONFIG_URL',
    placeholder: 'https://id.example.com/.well-known/openid-configuration',
    group: 'sso',
    label: 'Discovery URL',
    note: 'The .well-known/openid-configuration URL.',
    kind: 'string',
    restart: true,
    env: () => config.oidc.configUrl,
  },
  {
    key: 'OIDC_CLIENT_ID',
    placeholder: 'send2ereader',
    group: 'sso',
    label: 'Client ID',
    kind: 'string',
    restart: true,
    env: () => config.oidc.clientId,
  },
  {
    key: 'OIDC_CLIENT_SECRET',
    group: 'sso',
    label: 'Client secret',
    kind: 'secret',
    restart: true,
    env: () => config.oidc.clientSecret,
  },
  {
    key: 'OIDC_ADMIN_GROUP',
    placeholder: 'ereader-admins',
    group: 'sso',
    label: 'Group that grants admin',
    note: 'Members get admin, and lose it when they leave. The first account keeps it.',
    kind: 'string',
    env: () => config.oidc.adminGroup,
  },

  {
    key: 'SMTP_ENABLED',
    group: 'mail',
    label: 'Send mail',
    note: 'Off writes each message to the log instead.',
    kind: 'bool',
    env: () => yesNo(config.mail.enabled),
  },
  {
    key: 'SMTP_HOST',
    placeholder: 'smtp.example.com',
    group: 'mail',
    label: 'Host',
    kind: 'string',
    env: () => config.mail.host,
  },
  {
    key: 'SMTP_PORT',
    group: 'mail',
    label: 'Port and encryption',
    kind: 'int',
    min: 1,
    max: 65535,
    env: () => String(config.mail.port),
  },
  {
    key: 'SMTP_SECURITY',
    group: 'mail',
    label: 'Encryption',
    inlineWith: 'SMTP_PORT',
    note: 'STARTTLS on 587, SSL on 465. None sends your password in the clear.',
    kind: 'choice',
    choices: [
      { value: 'starttls', label: 'STARTTLS' },
      { value: 'ssl', label: 'SSL/TLS' },
      { value: 'none', label: 'None' },
    ],
    env: () => {
      if (config.mail.security) return config.mail.security
      if (!config.mail.tls) return 'none'
      return config.mail.port === 465 ? 'ssl' : 'starttls'
    },
  },
  {
    key: 'SMTP_TLS',
    group: 'mail',
    label: 'SMTP_TLS (older spelling)',
    note: 'Replaced by Encryption above. Here to explain a value you did not choose.',
    kind: 'bool',
    readOnly: true,
    env: () => yesNo(config.mail.tls),
  },
  {
    key: 'SMTP_USERNAME',
    placeholder: 'you@example.com',
    group: 'mail',
    label: 'Username',
    kind: 'string',
    env: () => config.mail.username,
  },
  {
    key: 'SMTP_PASSWORD',
    group: 'mail',
    label: 'Password',
    kind: 'secret',
    env: () => config.mail.password,
  },
  {
    key: 'SMTP_FROM_EMAIL',
    placeholder: 'books@example.com',
    group: 'mail',
    label: 'From address',
    kind: 'string',
    env: () => config.mail.fromEmail,
  },
  {
    key: 'SMTP_TIMEOUT_SECONDS',
    group: 'mail',
    label: 'Give up on the server after',
    unit: 'seconds',
    kind: 'int',
    min: 5,
    max: 300,
    env: () => String(config.mail.timeoutSeconds),
  },
  {
    key: 'MAIL_LOG_SECRETS',
    group: 'mail',
    label: 'Write sign-in links to the log in full',
    note: 'A link in a log is a live credential.',
    kind: 'bool',
    env: () => yesNo(config.mail.logSecrets),
  },
  {
    key: 'SMTP_FROM_NAME',
    placeholder: 'Send to eReader',
    group: 'mail',
    label: 'From name',
    kind: 'string',
    env: () => config.mail.fromName,
  },

  {
    key: 'RETAIN_DAYS',
    group: 'library',
    label: 'Books are kept for',
    unit: 'days',
    note: 'Zero keeps nothing unless an account asks for it.',
    kind: 'int',
    min: 0,
    max: 3650,
    env: () => String(config.library.retainDays),
  },
  {
    key: 'STORAGE_PER_USER',
    group: 'library',
    label: 'Each account may keep',
    unit: 'bytes',
    kind: 'int',
    min: 1024 * 1024,
    env: () => String(config.library.perUserBytes),
  },
  {
    key: 'STORAGE_TOTAL',
    group: 'library',
    label: 'Everyone together may keep',
    unit: 'bytes',
    kind: 'int',
    min: 1024 * 1024,
    env: () => String(config.library.totalBytes),
  },

  {
    key: 'KEY_LENGTH',
    group: 'sending',
    label: 'A key is',
    unit: 'characters long',
    note: 'Four is enough — a key lives for minutes.',
    kind: 'int',
    min: 3,
    max: 12,
    env: () => String(config.keyLength),
  },
  {
    key: 'EREADER_POLL_SECONDS',
    group: 'sending',
    label: 'A waiting eReader asks every',
    unit: 'seconds',
    note: 'How often the receiving page checks. Lower is snappier and noisier.',
    kind: 'int',
    min: 1,
    max: 60,
    env: () => String(config.ereaderPollSeconds),
  },
  {
    key: 'MAX_FILE_SIZE',
    group: 'sending',
    label: 'Largest file',
    unit: 'bytes',
    kind: 'int',
    min: 1024,
    env: () => String(config.maxFileSize),
  },
  {
    key: 'EXPIRE_SECONDS',
    group: 'sending',
    label: 'A key waits',
    unit: 'seconds',
    kind: 'int',
    min: 30,
    max: 24 * 60 * 60,
    env: () => String(config.expireSeconds),
  },
  {
    key: 'MAX_EXPIRE_SECONDS',
    group: 'sending',
    label: 'A key may be extended to',
    unit: 'seconds',
    kind: 'int',
    min: 30,
    max: 24 * 60 * 60,
    env: () => String(config.maxExpireSeconds),
  },

  {
    key: 'CONVERT_TTL',
    group: 'converting',
    label: 'A converted file is collectable for',
    unit: 'seconds',
    kind: 'int',
    min: 60,
    max: 24 * 60 * 60,
    env: () => String(config.convertTtlSeconds),
  },
  {
    key: 'CONVERSION_TIMEOUT_MS',
    group: 'converting',
    label: 'Give up on a conversion after',
    unit: 'milliseconds',
    note: 'Too low turns slow books into failed ones.',
    kind: 'int',
    min: 10_000,
    max: 60 * 60 * 1000,
    env: () => String(config.conversionTimeoutMs),
  },
  {
    key: 'CONVERSION_CONCURRENCY',
    group: 'converting',
    label: 'Convert at most',
    unit: 'books at once',
    note: 'Past the core count they queue anyway.',
    kind: 'int',
    min: 1,
    max: 32,
    env: () => String(config.conversionConcurrency),
  },
  {
    key: 'CONVERSION_OUTPUT_LIMIT',
    group: 'converting',
    label: 'Keep at most',
    unit: 'bytes',
    note: 'How much converter output is kept for the error message.',
    kind: 'int',
    min: 1024,
    max: 8 * 1024 * 1024,
    env: () => String(config.conversionOutputLimit),
  },
  {
    key: 'CALIBRE_OUTPUT_PROFILE',
    group: 'converting',
    label: 'calibre output profile for Kindle',
    placeholder: 'kindle_pw3',
    note: 'Passed as --output-profile. Empty leaves the flag off.',
    kind: 'string',
    env: () => config.calibreOutputProfile,
  },
  {
    key: 'LAYOUT_FIX_DEFAULT',
    group: 'converting',
    label: 'Fix layout, unless the sender says otherwise',
    note: 'How the option starts on Send and Convert.',
    kind: 'bool',
    env: () => yesNo(config.layoutFixDefault),
  },
  {
    key: 'KINDLE_SHARE_NOT_SYNC',
    group: 'converting',
    label: 'Tell calibre --share-not-sync for Kindle formats',
    note: 'Stops a converted book syncing over the one bought from Amazon.',
    kind: 'bool',
    env: () => yesNo(config.kindleShareNotSync),
  },

  {
    key: 'KOBO_QUEUE_TTL',
    group: 'kobo',
    label: 'A book waits for the device for',
    unit: 'seconds',
    note: 'How long a book waits for a Kobo that has not synced.',
    kind: 'int',
    min: 60,
    max: 30 * 24 * 60 * 60,
    env: () => String(config.kobo.queueTtlSeconds),
  },
  {
    key: 'KOBO_STORE_URL',
    group: 'kobo',
    label: 'Kobo store',
    placeholder: 'https://storeapi.kobo.com',
    note: 'Anything this server does not answer is passed through here.',
    kind: 'string',
    env: () => config.kobo.storeUrl,
  },
  {
    key: 'KOBO_IMAGE_BASE_URL',
    group: 'kobo',
    label: 'Kobo cover images',
    placeholder: 'https://cdn.kobo.com/book-images',
    kind: 'string',
    env: () => config.kobo.imageBaseUrl,
  },
  {
    key: 'KOBO_PROXY_TIMEOUT_MS',
    group: 'kobo',
    label: 'Give up on the store after',
    unit: 'milliseconds',
    kind: 'int',
    min: 1000,
    max: 120_000,
    env: () => String(config.kobo.proxyTimeoutMs),
  },
  {
    key: 'KOBO_PROXY_BODY_LIMIT',
    group: 'kobo',
    label: 'Largest reply to pass through',
    unit: 'bytes',
    kind: 'int',
    min: 64 * 1024,
    env: () => String(config.kobo.proxyBodyLimit),
  },

  {
    key: 'HTTP_ADDR',
    group: 'listen',
    label: 'Listen address',
    note: 'The interface to bind; 0.0.0.0 is all of them.',
    kind: 'string',
    readOnly: true,
    env: () => config.httpAddr,
  },
  {
    key: 'HTTP_PORT',
    group: 'listen',
    label: 'Listen port',
    note: 'The port inside the container; the mapping decides the outside one.',
    kind: 'int',
    min: 1,
    max: 65535,
    readOnly: true,
    env: () => String(config.httpPort),
  },
  {
    key: 'DB_PATH',
    group: 'storage',
    label: 'Database',
    note: 'Accounts, devices, sessions and everything set on this page.',
    kind: 'string',
    readOnly: true,
    env: () => config.db.path,
  },
  {
    key: 'DATA_DIR',
    group: 'storage',
    label: 'Everything that persists',
    note: 'Everything that survives a restart. Changing it means changing the mount.',
    kind: 'string',
    readOnly: true,
    env: () => config.dataDir,
  },
  {
    key: 'UPLOAD_DIR',
    group: 'storage',
    label: 'Uploads in flight',
    note: 'Where a book waits to be collected. Nothing here survives.',
    kind: 'string',
    readOnly: true,
    env: () => config.uploadDir,
  },
  {
    key: 'LIBRARY_DIR',
    group: 'storage',
    label: 'Kept books',
    kind: 'string',
    readOnly: true,
    env: () => config.library.dir,
  },
  {
    key: 'KOBO_QUEUE_DIR',
    group: 'storage',
    label: 'Waiting for a Kobo',
    kind: 'string',
    readOnly: true,
    env: () => config.kobo.queueDir,
  },
  {
    key: 'STATIC_DIR',
    group: 'storage',
    label: 'Pages and assets',
    kind: 'string',
    readOnly: true,
    env: () => config.staticDir,
  },
  {
    key: 'ENV_FILE',
    group: 'storage',
    label: 'Environment file',
    note: 'Where the read-only values here are changed. Read at boot, never written.',
    kind: 'string',
    readOnly: true,
    env: () => envFile,
  },
  {
    key: 'CLEAN_UPLOAD_DIR_ON_BOOT',
    group: 'storage',
    label: 'Empty the upload directory at boot',
    note: 'Leftovers are unreachable anyway, since keys die with a restart.',
    kind: 'bool',
    readOnly: true,
    env: () => yesNo(config.cleanUploadDirOnBoot),
  },
  {
    key: 'LOG_LEVEL',
    group: 'logging',
    label: 'Level',
    kind: 'choice',
    choices: [
      { value: 'trace', label: 'trace' },
      { value: 'debug', label: 'debug' },
      { value: 'info', label: 'info' },
      { value: 'warn', label: 'warn' },
      { value: 'error', label: 'error' },
      { value: 'fatal', label: 'fatal' },
      { value: 'silent', label: 'silent' },
    ],
    readOnly: true,
    env: () => config.logLevel,
  },
  {
    key: 'LOG_PRETTY',
    group: 'logging',
    label: 'Readable logs instead of JSON',
    note: 'The older spelling: off means JSON. LOG_FORMAT replaces it and wins.',
    kind: 'bool',
    readOnly: true,
    env: () => yesNo(config.logPretty),
  },
  {
    key: 'KEPUBIFY_BIN',
    group: 'converters',
    label: 'kepubify',
    note: 'EPUB into the KEPUB a Kobo wants.',
    kind: 'string',
    readOnly: true,
    env: () => config.bin.kepubify,
  },
  {
    key: 'EBOOK_CONVERT_BIN',
    group: 'converters',
    label: 'ebook-convert',
    note: 'Calibre, which does every other format.',
    kind: 'string',
    readOnly: true,
    env: () => config.bin.ebookConvert,
  },
  {
    key: 'CALIBRE_CUSTOMIZE_BIN',
    group: 'converters',
    label: 'calibre-customize',
    note: 'Only asked which plugins are installed, which is how KFX input is found.',
    kind: 'string',
    readOnly: true,
    env: () => config.bin.calibreCustomize,
  },
  {
    key: 'PDFCROPMARGINS_BIN',
    group: 'converters',
    label: 'pdfcropmargins',
    note: 'Trims the white border off a PDF page.',
    kind: 'string',
    readOnly: true,
    env: () => config.bin.pdfCropMargins,
  },
  {
    key: 'EPUB_LAYOUT_FIX_BIN',
    group: 'converters',
    label: 'epub-layout-fix',
    kind: 'string',
    readOnly: true,
    env: () => config.bin.layoutFix,
  },
  {
    key: 'EXTENSIONS',
    group: 'extensions',
    label: 'Extensions to install at start',
    placeholder: 'ghcr.io/devnullv0id/s2e-mod-kfx:latest',
    note: 'Ids or image names, pipe separated; queued at every start.',
    kind: 'string',
    readOnly: true,
    env: () => config.extensions,
  },
  {
    key: 'EXTENSION_PACKAGES',
    group: 'extensions',
    label: 'Debian packages to install at start',
    placeholder: 'fonts-noto-cjk|poppler-utils',
    note: 'Package names, pipe separated, apt-installed at every start.',
    kind: 'string',
    readOnly: true,
    env: () => config.extensionPackages,
  },
  {
    key: 'CONVERT_RATE_MAX',
    group: 'converters',
    label: 'Conversions allowed per window',
    note: 'Per client address, within the window below.',
    kind: 'int',
    readOnly: true,
    env: () => String(config.convertRateMax),
  },
  {
    key: 'CONVERT_RATE_WINDOW',
    group: 'converters',
    label: 'Window the count applies to',
    placeholder: '1 minute',
    note: '"30 seconds", "1 minute", or a number of milliseconds.',
    kind: 'string',
    readOnly: true,
    env: () => config.convertRateWindow,
  },
  {
    key: 'LOG_FORMAT',
    group: 'logging',
    label: 'Log output',
    note: 'text to read, json for a log collector.',
    kind: 'choice',
    choices: [
      { value: 'text', label: 'text' },
      { value: 'json', label: 'json' },
    ],
    readOnly: true,
    env: () => config.logFormat,
  },
  {
    key: 'LOG_SCOPE',
    group: 'logging',
    label: 'Only these scopes',
    placeholder: 'convert,layoutfix',
    note: 'Comma separated, -name to exclude. Empty means everything.',
    kind: 'string',
    readOnly: true,
    env: () => config.logScope,
  },
  {
    key: 'LOG_TIME',
    group: 'logging',
    label: 'Timestamp style',
    note: 'iso, short without the date, rel from start, or none.',
    kind: 'choice',
    choices: [
      { value: 'iso', label: 'iso' },
      { value: 'short', label: 'short' },
      { value: 'rel', label: 'rel' },
      { value: 'none', label: 'none' },
    ],
    readOnly: true,
    env: () => config.logTime,
  },
  {
    key: 'NO_COLOR',
    group: 'logging',
    label: 'Never colour the log',
    note: 'Set to anything and colour is off. See no-color.org.',
    kind: 'string',
    readOnly: true,
    env: () => config.noColor,
  },
  {
    key: 'KFX_PREVIEWER_PATH',
    group: 'extensions',
    label: 'Path to Kindle Previewer',
    placeholder: '/data/kfx/wine/drive_c/.../Kindle Previewer 3.exe',
    note: 'Only needed when the Previewer did not come from the kfx extension.',
    kind: 'string',
    readOnly: true,
    env: () => config.kfxPreviewerPath,
  },
  {
    key: 'ACCOUNTS',
    group: 'security',
    label: 'Accounts exist on this server',
    note: 'Off removes sign-in, the library and this page.',
    kind: 'bool',
    readOnly: true,
    env: () => yesNo(config.auth.accounts),
  },
  {
    key: 'SESSION_SECRET',
    group: 'security',
    label: 'Session secret',
    note: 'Signs sessions and encrypts Kobo tokens. Lose it and everyone is signed out.',
    kind: 'secret',
    readOnly: true,
    env: () => sessionSecret(),
  },
  {
    key: 'SCRYPT_N',
    group: 'security',
    label: 'Password hashing cost',
    note: 'Higher is slower to attack and slower to sign in.',
    kind: 'int',
    min: 2 ** 12,
    max: 2 ** 22,
    readOnly: true,
    env: () => String(config.auth.scryptN),
  },
  {
    key: 'LOCKED_SETTINGS',
    group: 'security',
    label: 'Keys this page may not touch',
    placeholder: 'ALLOW_SIGNUP, SMTP_HOST',
    note: 'Names, space or comma separated. Each is shown here but cannot be changed.',
    kind: 'string',
    readOnly: true,
    env: () => process.env.LOCKED_SETTINGS ?? '',
  },
]

const BY_KEY = new Map(SETTING_SPECS.map((spec) => [spec.key, spec]))

export function specFor(key: string): SettingSpec | undefined {
  return BY_KEY.get(key)
}

const lockedKeys: ReadonlySet<string> = new Set(
  (process.env.LOCKED_SETTINGS ?? '')
    .split(/[\s,]+/)
    .map((name) => name.trim().toUpperCase())
    .filter((name) => BY_KEY.has(name))
)

export function isLocked(key: string): boolean {
  return lockedKeys.has(key)
}

export function isReadOnly(key: string): boolean {
  return BY_KEY.get(key)?.readOnly === true
}

export function originOf(key: string): SettingOrigin {
  const given = process.env[key]
  if (given !== undefined && given.trim() !== '') return 'environment'
  if (key === 'SESSION_SECRET' && sessionSecretOrigin() === 'generated') return 'generated'
  return 'default'
}

export function boundsFor(spec: SettingSpec): { min: number | null; max: number | null } {
  const min = spec.min ?? null
  const max = spec.max ?? null
  if (spec.kind !== 'int') return { min, max }

  const fromEnv = Number.parseInt(spec.env(), 10)
  if (!Number.isFinite(fromEnv)) return { min, max }

  return {
    min: min === null ? null : Math.min(min, fromEnv),
    max: max === null ? null : Math.max(max, fromEnv),
  }
}

export function problemWith(spec: SettingSpec, value: string, lang = 'en'): string | null {
  const own = spec.check?.(value, lang)
  if (own) return own

  if (spec.kind === 'bool') {
    return ['true', 'false'].includes(value) ? null : i18n.translate(lang, 'Expected true or false')
  }
  if (spec.kind === 'int') {
    if (!/^-?\d+$/.test(value)) return i18n.translate(lang, 'Expected a whole number')
    const parsed = Number.parseInt(value, 10)
    const bounds = boundsFor(spec)
    if (bounds.min !== null && parsed < bounds.min) {
      return i18n.translate(lang, 'Must be at least {n}', { n: bounds.min })
    }
    if (bounds.max !== null && parsed > bounds.max) {
      return i18n.translate(lang, 'Must be at most {n}', { n: bounds.max })
    }
    return null
  }
  if (spec.kind === 'choice') {
    return spec.choices?.some((c) => c.value === value)
      ? null
      : i18n.translate(lang, 'Not one of the choices')
  }
  if (spec.kind === 'toggled') {
    const lowered = value.trim().toLowerCase()
    if (lowered === '') return i18n.translate(lang, 'Give an address, or switch it off')
    if (TRUTHY_WORDS.includes(lowered)) {
      return i18n.translate(
        lang,
        '{value} would believe anyone who reaches this port — give the address it should believe instead',
        { value }
      )
    }
    return null
  }
  if (value.length > 4096) return i18n.translate(lang, 'Too long')
  return null
}

interface Row {
  key: string
  value: string
  updated_at: string
  updated_by: string | null
}

export class Settings {
  private db: Db | null = null
  private readonly cache = new Map<string, string>()

  attach(db: Db): void {
    this.db = db
    this.reload()
  }

  detach(): void {
    this.db = null
    this.cache.clear()
  }

  reload(): void {
    this.cache.clear()
    if (!this.db) return
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as unknown as Row[]
    for (const row of rows) {
      if (!BY_KEY.has(row.key)) continue
      this.cache.set(row.key, row.value)
    }
  }

  private stored(key: string): string | undefined {
    if (isLocked(key) || isReadOnly(key)) return undefined
    return this.cache.get(key)
  }

  raw(key: string): string {
    const spec = BY_KEY.get(key)
    if (!spec) throw new Error(`Unknown setting ${key}`)
    const held = this.stored(key)
    if (held === undefined) return spec.env()
    return spec.kind === 'secret' ? (decryptSecret(held) ?? spec.env()) : held
  }

  str(key: string): string {
    return this.raw(key)
  }

  int(key: string): number {
    const parsed = Number.parseInt(this.raw(key), 10)
    if (Number.isFinite(parsed)) return parsed
    return Number.parseInt(BY_KEY.get(key)!.env(), 10)
  }

  bool(key: string): boolean {
    return ['1', 'true', 'yes', 'on'].includes(this.raw(key).toLowerCase())
  }

  isOverridden(key: string): boolean {
    return this.stored(key) !== undefined
  }

  envValue(key: string): string {
    const spec = BY_KEY.get(key)
    if (!spec) throw new Error(`Unknown setting ${key}`)
    return spec.env()
  }

  changedBy(key: string): { at: string; by: string | null } | null {
    if (!this.db || this.stored(key) === undefined) return null
    const row = this.db
      .prepare('SELECT updated_at, updated_by FROM settings WHERE key = ?')
      .get(key) as { updated_at: string; updated_by: string | null } | undefined
    return row ? { at: row.updated_at, by: row.updated_by } : null
  }

  set(key: string, value: string, byUserId: string | null): void {
    const spec = BY_KEY.get(key)
    if (!spec) throw new Error(`Unknown setting ${key}`)
    if (isLocked(key)) throw new Error(`${key} is locked in the environment`)
    if (isReadOnly(key)) throw new Error(`${key} is set in the environment, not from a browser`)
    if (!this.db) throw new Error('Settings are not attached to a database')

    if (value === spec.env()) {
      this.clear(key)
      return
    }

    const kept = spec.kind === 'secret' ? encryptSecret(value) : value
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                         updated_at = excluded.updated_at,
                                         updated_by = excluded.updated_by`
      )
      .run(key, kept, new Date().toISOString(), byUserId)
    this.cache.set(key, kept)
  }

  clear(key: string): void {
    if (!this.db) throw new Error('Settings are not attached to a database')
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    this.cache.delete(key)
  }
}

export const settings = new Settings()
