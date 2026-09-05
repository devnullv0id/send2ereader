import { config, envFile, sessionSecret, sessionSecretOrigin } from './config.js'
import type { Db } from './db/index.js'
import { decryptSecret, encryptSecret } from './db/secretbox.js'

export type SettingKind = 'bool' | 'int' | 'string' | 'secret' | 'choice'

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
    intro:
      'The address this server calls itself. It goes in every link it sends, it is the relying party a passkey is bound to, it is the redirect the SSO provider has to have on file, and it is the sync endpoint stored on every paired Kobo. Nothing here takes effect until the server restarts, on purpose: the cookie flags and the security headers are settled at boot, and an address that moved underneath half of them would be worse than one that did not move at all.',
  },
  {
    id: 'accounts',
    title: 'Accounts',
    intro: 'Who may create an account here, and how long a sign-in lasts.',
  },
  {
    id: 'passwords',
    title: 'Passwords',
    intro:
      'Length does more for a password than any composition rule, which is why the length is first and the rest start off.',
  },
  {
    id: 'guessing',
    title: 'Failed sign-ins',
    intro:
      'Nothing here locks an account. A run of wrong passwords writes to the address it was aimed at and says how to change it.',
  },
  {
    id: 'mail',
    title: 'Mail',
    intro:
      'Without mail there is no address verification, no reset link and no sign-in link, so this comes before anything else that needs one. The password is stored encrypted and never sent back to this page.',
  },
  {
    id: 'sso',
    title: 'Single sign-on',
    intro:
      'An OpenID Connect provider, for letting an existing directory do the signing in. The client secret is stored encrypted and is never sent back to this page.',
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
    intro: 'How much may be kept, and for how long, when an account keeps its books.',
  },
  {
    id: 'kobo',
    title: 'Kobo sync',
    intro:
      'A Kobo talks to this server instead of to Kobo, and this server passes the rest through. Only change these if you know why.',
  },
  {
    id: 'listen',
    title: 'Server',
    intro:
      'Where the process listens, which is the inside of the box and never appears in a link. Shown here so you can see what is in force; these are set in the environment file and take a restart to change.',
  },
  {
    id: 'storage',
    title: 'Storage',
    intro:
      'Where everything is kept. A running server holds its database and its books open, so these cannot move underneath it: they are set in the environment file and take a restart to change.',
  },
  {
    id: 'logging',
    title: 'Logging',
    intro:
      'How much this server writes down. The logger is built once, at boot, so these are set in the environment file and take a restart to change.',
  },
  {
    id: 'converters',
    title: 'Converters',
    intro:
      'Which executable each conversion actually runs. A browser form is the wrong place to choose what a server executes, so these are set in the environment file and take a restart to change.',
  },
  {
    id: 'extensions',
    title: 'Extensions',
    intro:
      'Things this image deliberately does not carry, installed at container start by whoever wants them. They are read before the server exists, by the script that starts it, so they are set in the environment file and take a restart — a value stored here could never be seen by the thing that acts on it.',
  },
  {
    id: 'security',
    title: 'Security',
    intro:
      'The parts nothing else works without. They are shown so you can see what is protecting this server, and set in the environment file so a browser cannot weaken it. Changing one takes a restart.',
  },
]

const yesNo = (value: boolean) => (value ? 'true' : 'false')

export const SETTING_SPECS: SettingSpec[] = [
  {
    key: 'PROTOCOL',
    group: 'server',
    label: 'Scheme',
    note: 'Passkeys need https. So does a Secure cookie. http is for a machine nobody else can reach.',
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
    note: 'A name, not an address and not a URL. A browser will not accept an IP as the relying party for a passkey, whatever certificate is on it. Empty falls back to the listen address and port, which is fine for a laptop and wrong for anything else.',
    kind: 'string',
    restart: true,
    env: () => config.domain,
  },
  {
    key: 'TRUST_PROXY',
    group: 'server',
    label: 'This server sits behind a reverse proxy',
    note: 'On, the client address is taken from X-Forwarded-For. Turn it on with no proxy in front and anyone can put whatever they like in that header — which is then the address the rate limiter counts and the address a failed sign-in notice names. Off with a proxy in front and every request looks like it came from the proxy, so one impatient reader can rate limit everybody.',
    kind: 'bool',
    restart: true,
    env: () => yesNo(config.trustProxy),
  },
  {
    key: 'ALLOW_SIGNUP',
    group: 'accounts',
    label: 'Anyone may create an account',
    note: 'Off means the create page refuses everyone. Existing accounts still sign in, and the first account can always be made.',
    kind: 'bool',
    env: () => yesNo(config.auth.allowSignup),
  },
  {
    key: 'ALLOW_STAY_SIGNED_IN',
    group: 'accounts',
    label: 'Offer "Stay signed in on this device"',
    note: 'Off hides the box everywhere and every session ends when the browser closes.',
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
    note: 'Once mail works, every account that never confirmed its address is asked to. This is how many times they may answer "not now" before the only ways on are to confirm it or change it. Zero asks once and means it.',
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
    note: 'Anything that is not a letter, a digit or a space.',
    kind: 'bool',
    env: () => yesNo(config.auth.requireSymbol),
  },

  {
    key: 'FAILED_SIGNINS_BEFORE_ALERT',
    group: 'guessing',
    label: 'Write to the account after',
    unit: 'wrong passwords in a row',
    note: 'Sign-in is rate limited to ten tries per five minutes and the turned-away ones never reach the check, so a number above nine would never be met.',
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
    note: 'What the sign-in page calls it. "Continue with —".',
    kind: 'string',
    restart: true,
    env: () => config.oidc.providerName,
  },
  {
    key: 'OIDC_CONFIG_URL',
    placeholder: 'https://id.example.com/.well-known/openid-configuration',
    group: 'sso',
    label: 'Discovery URL',
    note: "The provider's .well-known/openid-configuration.",
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
    note: 'A claim from the provider. Members get admin on every sign-in and lose it when they leave the group. The first account keeps admin either way.',
    kind: 'string',
    env: () => config.oidc.adminGroup,
  },

  {
    key: 'SMTP_ENABLED',
    group: 'mail',
    label: 'Send mail',
    note: 'Off writes each message to the log instead, which is enough to sign in on a server with no mail.',
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
    note: 'STARTTLS opens in the clear on 587 and upgrades. SSL is encrypted from the first byte, which is what 465 expects. None sends your password in the clear and is only ever right on a socket nobody else can reach.',
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
    note: 'Read only when Encryption above is unset: true meant SSL on 465 and STARTTLS anywhere else, false meant none. Encryption says the same thing without guessing, so this is here to explain a value you did not choose, not to be changed.',
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
    note: 'Only matters while mail is off. A link in a log is a live credential, so this is for getting in on a fresh server, not for leaving on.',
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
    note: 'Zero means nothing is kept unless an account asks for it. An account may still choose less.',
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
    note: 'Longer is harder to guess and harder to type. Four is enough because a key lives for minutes, not days.',
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
    note: 'How often the receiving page checks for the file. Lower is snappier and noisier.',
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
    note: 'A big PDF through calibre is slow. Too low turns slow books into failed ones.',
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
    note: 'Each conversion is a process of its own. Past the core count they queue behind each other anyway.',
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
    note: 'How much of a converter\u2019s output is kept for the error message when it fails.',
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
    note: 'Passed to calibre as --output-profile. Empty leaves the flag off entirely.',
    kind: 'string',
    env: () => config.calibreOutputProfile,
  },
  {
    key: 'LAYOUT_FIX_DEFAULT',
    group: 'converting',
    label: 'Fix layout, unless the sender says otherwise',
    note: 'The state the option starts in on the Send and Convert pages.',
    kind: 'bool',
    env: () => yesNo(config.layoutFixDefault),
  },
  {
    key: 'KINDLE_SHARE_NOT_SYNC',
    group: 'converting',
    label: 'Tell calibre --share-not-sync for Kindle formats',
    note: 'Keeps a converted book from being mistaken for one bought from Amazon, which is what stops it syncing over the top of the real thing.',
    kind: 'bool',
    env: () => yesNo(config.kindleShareNotSync),
  },

  {
    key: 'KOBO_QUEUE_TTL',
    group: 'kobo',
    label: 'A book waits for the device for',
    unit: 'seconds',
    note: 'A Kobo syncs when it feels like it. This is how long a book is held for one before it is given up on.',
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
    note: 'Everything this server does not answer itself is passed through to here.',
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
    note: 'The interface the process binds. 0.0.0.0 is every one of them, which is what a container wants. This is not the address the server calls itself — that is Address, above.',
    kind: 'string',
    readOnly: true,
    env: () => config.httpAddr,
  },
  {
    key: 'HTTP_PORT',
    group: 'listen',
    label: 'Listen port',
    note: 'The port inside the container. What the outside reaches it on is decided by the port mapping, not here.',
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
    note: 'Accounts, devices, sessions and everything set on this page. The generated session key, if there is one, sits beside it.',
    kind: 'string',
    readOnly: true,
    env: () => config.db.path,
  },
  {
    key: 'DATA_DIR',
    group: 'storage',
    label: 'Everything that persists',
    note: 'The volume the database, the library and anything an extension installs live under. It is the directory the container is given; changing it means changing the mount.',
    kind: 'string',
    readOnly: true,
    env: () => config.dataDir,
  },
  {
    key: 'UPLOAD_DIR',
    group: 'storage',
    label: 'Uploads in flight',
    note: 'Where a book waits between arriving and being collected. Nothing here is meant to survive.',
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
    note: 'The file every read-only value on this page is changed in. It is read at boot and never written by this server.',
    kind: 'string',
    readOnly: true,
    env: () => envFile,
  },
  {
    key: 'CLEAN_UPLOAD_DIR_ON_BOOT',
    group: 'storage',
    label: 'Empty the upload directory at boot',
    note: 'A key does not survive a restart, so anything left in there is already unreachable. Off keeps it for looking at.',
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
    note: 'Development only. It needs pino-pretty, which is not in the Docker image, and turning it on where it is missing stops the server rather than the logging.',
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
    note: 'Calibre, which does every other format. Missing, and the Convert page offers only what does not need it.',
    kind: 'string',
    readOnly: true,
    env: () => config.bin.ebookConvert,
  },
  {
    key: 'CALIBRE_CUSTOMIZE_BIN',
    group: 'converters',
    label: 'calibre-customize',
    note: 'Only asked which plugins are installed, which is how KFX input is detected.',
    kind: 'string',
    readOnly: true,
    env: () => config.bin.calibreCustomize,
  },
  {
    key: 'PDFCROPMARGINS_BIN',
    group: 'converters',
    label: 'pdfcropmargins',
    note: 'Trims the white border off a PDF page, which is most of what makes a PDF readable on e-ink.',
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
    note: 'Image names, separated by pipes. Each is downloaded at container start and unpacked over the filesystem, then any script it left in /etc/s2e/extensions is run once. They are fetched every start, so an image that disappears takes its extension with it.',
    kind: 'string',
    readOnly: true,
    env: () => config.extensions,
  },
  {
    key: 'EXTENSION_PACKAGES',
    group: 'extensions',
    label: 'Debian packages to install at start',
    placeholder: 'fonts-noto-cjk|poppler-utils',
    note: 'Package names, separated by pipes, installed with apt before the server starts. Convenient, and slower every start; anything permanent belongs in an image of your own.',
    kind: 'string',
    readOnly: true,
    env: () => config.extensionPackages,
  },
  {
    key: 'CONVERT_RATE_MAX',
    group: 'converters',
    label: 'Conversions allowed per window',
    note: 'Per client address. The window below decides how long that is. Raise it for a test rig that converts in a loop; the default is sized for people, not scripts.',
    kind: 'int',
    readOnly: true,
    env: () => String(config.convertRateMax),
  },
  {
    key: 'CONVERT_RATE_WINDOW',
    group: 'converters',
    label: 'Window the count applies to',
    placeholder: '1 minute',
    note: 'Anything @fastify/rate-limit understands, so "30 seconds" or "1 minute" or a number of milliseconds.',
    kind: 'string',
    readOnly: true,
    env: () => config.convertRateWindow,
  },
  {
    key: 'LOG_FORMAT',
    group: 'logging',
    label: 'Log output',
    note: 'text is the readable default. json emits one structured line per event, which is what a log collector wants.',
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
    note: 'Comma separated. A name prefixed with - is excluded instead. Empty means everything.',
    kind: 'string',
    readOnly: true,
    env: () => config.logScope,
  },
  {
    key: 'LOG_TIME',
    group: 'logging',
    label: 'Timestamp style',
    note: 'iso is the date, clock and offset. short drops the date, rel counts from start, none leaves it out.',
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
    note: 'Set to anything at all and colour is off, whatever --log-color says. The convention is not ours; see no-color.org.',
    kind: 'string',
    readOnly: true,
    env: () => config.noColor,
  },
  {
    key: 'KFX_PREVIEWER_PATH',
    group: 'extensions',
    label: 'Path to Kindle Previewer',
    placeholder: '/data/kfx/wine/drive_c/.../Kindle Previewer 3.exe',
    note: "calibre's KFX Output plugin is in the image, but it can only write KFX with Amazon's Previewer behind it, so KFX is offered only when one is there. The kfx extension records the path it installed and this is not needed. Set it when the Previewer came from somewhere else.",
    kind: 'string',
    readOnly: true,
    env: () => config.kfxPreviewerPath,
  },
  {
    key: 'ACCOUNTS',
    group: 'security',
    label: 'Accounts exist on this server',
    note: 'Off is the bare key-transfer app: no sign-in, no library, and no admin page — so no way back to this switch except the environment file. That is why it lives there.',
    kind: 'bool',
    readOnly: true,
    env: () => yesNo(config.auth.accounts),
  },
  {
    key: 'SESSION_SECRET',
    group: 'security',
    label: 'Session secret',
    note: 'Signs every session and encrypts stored Kobo tokens and two-factor secrets. Left unset, one is generated on first boot and kept beside the database — losing that file signs everyone out and makes what it encrypted unreadable.',
    kind: 'secret',
    readOnly: true,
    env: () => sessionSecret(),
  },
  {
    key: 'SCRYPT_N',
    group: 'security',
    label: 'Password hashing cost',
    note: 'The scrypt work factor. Higher is slower to attack and slower to sign in; lowering it does not weaken passwords already stored, which keep the cost they were hashed at.',
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
    note: 'Names, separated by spaces or commas. Each one is shown here with its environment value and no way to change it, whatever an admin does.',
    kind: 'string',
    readOnly: true,
    env: () => process.env.LOCKED_SETTINGS ?? '',
  },
]

const BY_KEY = new Map(SETTING_SPECS.map((spec) => [spec.key, spec]))

export function specFor(key: string): SettingSpec | undefined {
  return BY_KEY.get(key)
}

export const lockedKeys: ReadonlySet<string> = new Set(
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

export function problemWith(spec: SettingSpec, value: string): string | null {
  if (spec.kind === 'bool') {
    return ['true', 'false'].includes(value) ? null : 'Expected true or false'
  }
  if (spec.kind === 'int') {
    if (!/^-?\d+$/.test(value)) return 'Expected a whole number'
    const parsed = Number.parseInt(value, 10)
    const bounds = boundsFor(spec)
    if (bounds.min !== null && parsed < bounds.min) return `Must be at least ${bounds.min}`
    if (bounds.max !== null && parsed > bounds.max) return `Must be at most ${bounds.max}`
    return null
  }
  if (spec.kind === 'choice') {
    return spec.choices?.some((c) => c.value === value) ? null : 'Not one of the choices'
  }
  if (value.length > 4096) return 'Too long'
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
