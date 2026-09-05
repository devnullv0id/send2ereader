import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  duration,
  passwordChangedEmail,
  resetEmail,
  signInLinkEmail,
  verificationEmail,
  welcomeEmail,
} from '../src/mail/template.js'

const DAY = 24 * 60 * 60
const LINK = 'http://host.local:3001/auth/verify?token=abc-123_XYZ'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('the mail palette and the page palette', () => {
  const css = readFileSync(join(root, 'static/app.css'), 'utf8')
  const template = readFileSync(join(root, 'src/mail/template.ts'), 'utf8')

  const token = (name: string) =>
    new RegExp(`^\\s{2}--${name}:\\s*(#[0-9a-f]{3,8});`, 'im').exec(css)?.[1]?.toLowerCase()
  const constant = (name: string) =>
    new RegExp(`^const ${name} = '(#[0-9a-f]{3,8})'`, 'im').exec(template)?.[1]?.toLowerCase()

  it.each([
    ['BTN', 'btn-dark'],
    ['BTN_TEXT', 'btn-dark-text'],
    ['ACCENT', 'accent-text'],
    ['PAGE', 'bg'],
    ['CARD', 'surface'],
  ])('%s matches --%s', (name, cssName) => {
    expect(constant(name), `${name} is not a plain hex in template.ts`).toBeTruthy()
    expect(constant(name)).toBe(token(cssName))
  })
})

describe('e-mail rendering', () => {
  const mails = [
    ['verification', verificationEmail(LINK, DAY)],
    ['reset', resetEmail(LINK, DAY)],
    ['welcome', welcomeEmail(LINK, 'http://host.local:3001')],
    ['password changed', passwordChangedEmail(LINK, '6 Aug 2026, 14:19 UTC', '10.10.10.7')],
    ['sign-in link', signInLinkEmail(LINK, 15 * 60)],
  ] as const

  it.each(mails)('%s carries a plain-text alternative', (_name, mail) => {
    expect(mail.text.length).toBeGreaterThan(40)
    expect(mail.text).toContain(LINK)
    expect(mail.text).not.toContain('<')
  })

  it.each(mails)('%s puts the link in the button and in copyable text', (_name, mail) => {
    const occurrences = mail.html.split(LINK).length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })

  it.each(mails)('%s loads nothing from the network', (_name, mail) => {
    expect(mail.html).not.toMatch(/<img|background-image|url\(/)
    const externals = mail.html.match(/(?:src|href)="https?:\/\/[^"]*"/g) ?? []
    expect(externals.every((href) => href.includes(LINK))).toBe(true)
  })

  it.each(mails)('%s survives a client that strips <style>', (_name, mail) => {
    expect(mail.html).not.toContain('<style')
    expect(mail.html).toContain('style="')
  })

  it.each(mails)('%s uses table layout for Outlook', (_name, mail) => {
    expect(mail.html).toContain('role="presentation"')
    expect(mail.html).toMatch(/bgcolor="[^"]+"[^>]*>\s*<a/)
  })

  it.each(mails)('%s has a subject and an inbox preheader', (_name, mail) => {
    expect(mail.subject).toBeTruthy()
    expect(mail.subject).not.toMatch(/[<>]/)
    expect(mail.html).toMatch(/display:none;max-height:0/)
  })

  it.each(mails)('%s names the instance that sent it, with its scheme', (_name, mail) => {
    expect(mail.html).toContain('http://host.local:3001')
    expect(mail.text).toMatch(/your own instance at http:\/\/host\.local:3001/i)
  })

  it.each(mails)('%s wears the app palette, not a neutral one', (_name, mail) => {
    expect(mail.html).toContain('#f2ece0')
    expect(mail.html).toContain('#1f1c16')
  })

  it('escapes anything that reaches the markup', () => {
    const nasty = 'http://host/x?token=a"><script>alert(1)</script>'
    const mail = verificationEmail(nasty, DAY)
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).toContain('&quot;&gt;&lt;script&gt;')
  })

  it('escapes values inside a block, not only the link', () => {
    const mail = passwordChangedEmail(LINK, '<b>now</b>', '"><script>alert(1)</script>')
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).not.toContain('<b>now</b>')
  })

  it('says how long the link lasts, in the words of the setting', () => {
    for (const [, mail] of [mails[0], mails[1]]) {
      expect(mail.text).toMatch(/expires in 24 hours/i)
      expect(mail.html).toMatch(/expires in 24 hours/i)
    }
    expect(verificationEmail(LINK, 2 * 60 * 60).text).toMatch(/expires in 2 hours/i)
    expect(resetEmail(LINK, 90 * 60).text).toMatch(/expires in 2 hours/i)
    expect(signInLinkEmail(LINK, 15 * 60).text).toMatch(/15 minutes/)
  })

  it.each([
    [60, '1 minute'],
    [15 * 60, '15 minutes'],
    [60 * 60, '1 hour'],
    [24 * 60 * 60, '24 hours'],
    [7 * 24 * 60 * 60, '7 days'],
  ])('reads %i seconds as "%s"', (seconds, words) => {
    expect(duration(seconds)).toBe(words)
  })

  it('calls the sign-in link what it is: single use, and short', () => {
    const mail = signInLinkEmail(LINK, 15 * 60)
    expect(mail.text).toMatch(/one use/i)
    expect(mail.subject).toBe('Your sign-in link')
  })

  it('tells a reset recipient their password is unchanged', () => {
    expect(resetEmail(LINK, DAY).text).toMatch(/password keeps working/i)
  })
})

describe('the blocks a message is built from', () => {
  it('renders numbered steps, with the address as text', () => {
    const mail = welcomeEmail(LINK, 'http://host.local:3001')

    expect(mail.html).not.toMatch(/<img/)
    expect(mail.html).toContain('host.local:3001')
    expect(mail.text).toMatch(/1\. Open the browser/)
    expect(mail.text).toMatch(/3\. Type them on your computer/)
  })

  it('renders a facts grid in both parts', () => {
    const mail = passwordChangedEmail(LINK, '6 Aug 2026, 14:19 UTC', '10.10.10.7 — Firefox')
    expect(mail.html).toContain('6 Aug 2026, 14:19 UTC')
    expect(mail.text).toContain('When: 6 Aug 2026, 14:19 UTC')
    expect(mail.text).toContain('Where: 10.10.10.7 — Firefox')
  })

  it('outlines the button on a notice rather than filling it', () => {
    const mail = passwordChangedEmail(LINK, 'now', 'here')
    expect(mail.html).toMatch(/border:1\.5px solid #8a6a1f/)
    expect(mail.subject).toBe('Your password was changed')
  })

  it('fills the button on everything that asks for an action', () => {
    for (const mail of [
      verificationEmail(LINK, DAY),
      resetEmail(LINK, DAY),
      welcomeEmail(LINK, 'h'),
    ]) {
      expect(mail.html).toMatch(/bgcolor="#8a6a1f"/)
    }
  })
})
