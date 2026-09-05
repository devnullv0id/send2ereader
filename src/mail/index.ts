import nodemailer, { type Transporter } from 'nodemailer'
import { settings } from '../settings.js'

export interface Message {
  to: string
  subject: string
  text: string
  html?: string
}

export interface Mailer {
  readonly enabled: boolean
  send(message: Message): Promise<void>
  close(): Promise<void>
}

export interface MailLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export function withoutTokens(text: string): string {
  return text.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')
}

function smtpSettings() {
  return {
    host: settings.str('SMTP_HOST'),
    port: settings.int('SMTP_PORT'),
    security: settings.str('SMTP_SECURITY'),
    username: settings.str('SMTP_USERNAME'),
    password: settings.str('SMTP_PASSWORD'),
    timeoutSeconds: settings.int('SMTP_TIMEOUT_SECONDS'),
  }
}

class LiveMailer implements Mailer {
  private transport: Transporter | null = null
  private builtFrom = ''
  private lastComplaint = ''

  constructor(private readonly log: MailLogger) {}

  get enabled(): boolean {
    return settings.bool('SMTP_ENABLED') && smtpProblem() === null
  }

  private transportNow(): Transporter {
    const mail = smtpSettings()
    const shape = JSON.stringify(mail)
    if (this.transport && this.builtFrom === shape) return this.transport

    if (this.transport) {
      this.transport.close()
      this.log.info({ host: mail.host, port: mail.port }, 'SMTP settings changed, reconnecting')
    }

    const timeout = mail.timeoutSeconds * 1000
    this.transport = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.security === 'ssl',
      requireTLS: mail.security === 'starttls',
      ignoreTLS: mail.security === 'none',
      auth: mail.username ? { user: mail.username, pass: mail.password } : undefined,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    })
    this.builtFrom = shape
    return this.transport
  }

  private toTheLog(message: Message): void {
    const body = settings.bool('MAIL_LOG_SECRETS') ? message.text : withoutTokens(message.text)
    this.log.warn(
      { to: message.to, subject: message.subject, body },
      'SMTP is not configured, e-mail written to the log instead of sent'
    )
  }

  async send(message: Message): Promise<void> {
    if (!settings.bool('SMTP_ENABLED')) return this.toTheLog(message)

    const problem = smtpProblem()
    if (problem) {
      if (problem !== this.lastComplaint) {
        this.log.error({ problem }, 'SMTP is enabled but incomplete, falling back to logging links')
        this.lastComplaint = problem
      }
      return this.toTheLog(message)
    }
    this.lastComplaint = ''

    try {
      await this.transportNow().sendMail({ from: senderHeader(), ...message })
      this.log.info({ to: message.to, subject: message.subject }, 'Sent e-mail')
    } catch (err) {
      this.log.error({ to: message.to, err: (err as Error).message }, 'Failed to send e-mail')
      throw err
    }
  }

  async close(): Promise<void> {
    if (!this.transport) return
    this.transport.close()
    this.transport = null
    this.builtFrom = ''
  }
}

export function senderAddress(): string {
  const fromEmail = settings.str('SMTP_FROM_EMAIL')
  if (fromEmail) return fromEmail
  const username = settings.str('SMTP_USERNAME')
  return username.includes('@') ? username : ''
}

export function senderHeader(): string {
  const address = senderAddress()
  const name = settings.str('SMTP_FROM_NAME')
  return name ? `${name} <${address}>` : address
}

export function smtpProblem(): string | null {
  if (!settings.bool('SMTP_ENABLED')) return null
  if (!settings.str('SMTP_HOST')) return 'Mail is on, but there is no server to send it through yet'

  const username = settings.str('SMTP_USERNAME')
  if (!senderAddress()) {
    return username
      ? 'There is no From address, and the username is not one to fall back on'
      : 'Mail is on, but there is no From address to send it from'
  }
  if (username && !settings.str('SMTP_PASSWORD')) {
    return 'There is a username to sign in with, but no password beside it'
  }
  return null
}

export function createMailer(log: MailLogger): Mailer {
  const mailer = new LiveMailer(log)

  if (!settings.bool('SMTP_ENABLED')) {
    const loud = settings.bool('MAIL_LOG_SECRETS')
    log.warn(
      { logSecrets: loud },
      loud
        ? 'SMTP is disabled, sign-in and reset links go to this log in full'
        : 'SMTP is disabled, mail goes to this log with the links redacted'
    )
    return mailer
  }

  if (settings.str('SMTP_SECURITY') === 'none' && settings.str('SMTP_PASSWORD')) {
    log.error(
      { host: settings.str('SMTP_HOST'), port: settings.int('SMTP_PORT') },
      'SMTP_SECURITY is none and a password is set, so those credentials go out in the clear'
    )
  }

  const problem = smtpProblem()
  if (problem) {
    log.error({ problem }, 'SMTP is enabled but incomplete, falling back to logging links')
  }
  return mailer
}
