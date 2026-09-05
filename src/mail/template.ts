import { i18n } from '../i18n.js'

export interface EmailContent {
  subject: string
  text: string
  html: string
}

export type Block =
  | { kind: 'text'; lines: string[] }
  | { kind: 'steps'; steps: { title: string; code?: string }[] }
  | { kind: 'facts'; rows: [string, string][] }
  | { kind: 'link'; label: string; url: string }

interface Template {
  subject: string
  preheader: string
  heading: string
  blocks: Block[]
  action?: { label: string; url: string; variant?: 'solid' | 'outline' }
  footnote: string[]
  instance?: string
  lang?: string
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const INK = '#1f1c16'
const MUTED = '#6f685a'
const FAINT = '#8a8272'
const LINE = '#e4dccb'
const BORDER = '#ddd3bf'
const PAGE = '#f2ece0'
const CARD = '#fbf8f2'
const WELL = '#ece5d6'
const ACCENT = '#8f6d15'
const ACCENT_SURFACE = '#f7edd6'
const ACCENT_BORDER = '#e0cf9a'
const ACCENT_INK = '#8a6a1f'
const BTN = '#8a6a1f'
const BTN_TEXT = '#faf6ec'

const SERIF = "'Instrument Serif','Iowan Old Style',Georgia,serif"
const SANS = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'

function paragraph(line: string, colour = MUTED): string {
  return `<p style="margin:0 0 14px;font-family:${SANS};font-size:14px;line-height:1.7;color:${colour};">${escapeHtml(line)}</p>`
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case 'text':
      return block.lines.map((line) => paragraph(line)).join('\n')

    case 'steps':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 14px;">
${block.steps
  .map(
    (step, index) => `<tr>
<td width="26" valign="top" style="padding:0 14px 18px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="26" height="26" align="center" bgcolor="${ACCENT_SURFACE}" style="width:26px;height:26px;border:1px solid ${ACCENT_BORDER};border-radius:13px;font-family:${SANS};font-size:12px;font-weight:600;line-height:24px;color:${ACCENT_INK};">${index + 1}</td>
</tr></table>
</td>
<td valign="top" style="padding:0 0 18px;font-family:${SANS};font-size:13.5px;font-weight:600;line-height:1.4;color:${INK};">
${escapeHtml(step.title)}
${
  step.code
    ? `<div style="margin-top:9px;padding:14px 16px;background:${ACCENT_SURFACE};border:1px solid ${ACCENT_BORDER};border-radius:6px;font-family:${MONO};font-size:17px;font-weight:700;line-height:1;color:${INK};letter-spacing:.02em;">${escapeHtml(step.code)}</div>`
    : ''
}
</td>
</tr>`
  )
  .join('\n')}
</table>`

    case 'facts':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 14px;">
<tr><td bgcolor="${WELL}" style="padding:16px 18px;border-radius:7px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
${block.rows
  .map(
    ([label, value]) => `<tr>
<td width="76" valign="top" style="padding:0 14px 7px 0;font-family:${SANS};font-size:11.5px;font-weight:600;line-height:1.5;color:${FAINT};">${escapeHtml(label)}</td>
<td valign="top" style="padding:0 0 7px;font-family:${SANS};font-size:11.5px;line-height:1.5;color:${MUTED};">${escapeHtml(value)}</td>
</tr>`
  )
  .join('\n')}
</table>
</td></tr>
</table>`

    case 'link':
      return `<p style="margin:0 0 14px;font-family:${SANS};font-size:13px;font-weight:600;line-height:1;color:${ACCENT};">
<a href="${escapeHtml(block.url)}" style="color:${ACCENT};text-decoration:none;">${escapeHtml(block.label)} &#8594;</a>
</p>`
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case 'text':
      return block.lines.join('\n\n')
    case 'steps':
      return block.steps
        .map((step, i) => `${i + 1}. ${step.title}${step.code ? `\n   ${step.code}` : ''}`)
        .join('\n')
    case 'facts':
      return block.rows.map(([label, value]) => `${label}: ${value}`).join('\n')
    case 'link':
      return `${block.label}:\n  ${block.url}`
  }
}

const HOST_TOKEN = '@@HOST@@'

function render(t: Template): EmailContent {
  const lang = t.lang ?? 'en'
  const url = t.action ? escapeHtml(t.action.url) : ''
  const outline = t.action?.variant === 'outline'

  const instanceSaid = t.instance
    ? i18n.translate(lang, 'Sent by your own instance at {host}.', { host: HOST_TOKEN })
    : ''
  const [instanceBefore = '', instanceAfter = ''] = instanceSaid.split(HOST_TOKEN)

  const button = t.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
<tr>
<td align="center" bgcolor="${outline ? CARD : BTN}" style="border-radius:7px;${outline ? `border:1.5px solid ${BTN};` : ''}">
<a href="${url}" style="display:inline-block;padding:${outline ? '13px 19px' : '15px 22px'};font-family:${SANS};font-size:${outline ? '13.5px' : '14px'};font-weight:600;color:${outline ? INK : BTN_TEXT};text-decoration:none;border-radius:7px;">${escapeHtml(t.action.label)}</a>
</td>
</tr>
</table>

<p style="margin:0 0 6px;font-family:${SANS};font-size:11.5px;line-height:1.7;color:${FAINT};">${escapeHtml(i18n.translate(lang, 'Or paste this into a browser:'))}</p>
<p style="margin:0;font-family:${MONO};font-size:11.5px;line-height:1.7;color:${ACCENT};word-break:break-all;">
<a href="${url}" style="color:${ACCENT};text-decoration:none;">${url}</a>
</p>`
    : ''

  const html = `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<meta name="supported-color-schemes" content="light"/>
<title>${escapeHtml(t.subject)}</title>
</head>
<body bgcolor="${PAGE}" style="margin:0;padding:0;background:${PAGE};color:${INK};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(t.preheader)}</div>
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background:${PAGE};">
<tr>
<td align="center" style="padding:32px 16px;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
<tr>
<td bgcolor="${CARD}" style="background:${CARD};border:1px solid ${BORDER};border-radius:9px;padding:40px 44px 34px;">

<div style="font-family:${SERIF};font-size:15px;line-height:1;color:${FAINT};letter-spacing:.01em;">Send to eReader</div>

<h1 style="margin:26px 0 0;font-family:${SERIF};font-size:30px;font-weight:400;line-height:1.15;color:${INK};">
${escapeHtml(t.heading)}
</h1>

<div style="margin-top:14px;">
${t.blocks.map(blockHtml).join('\n')}
</div>

${button}

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:30px;border-top:1px solid ${LINE};">
<tr><td style="padding-top:20px;">
${t.footnote
  .map(
    (line) =>
      `<p style="margin:0 0 8px;font-family:${SANS};font-size:11.5px;line-height:1.7;color:${FAINT};">${escapeHtml(line)}</p>`
  )
  .join('\n')}
${
  t.instance
    ? `<p style="margin:10px 0 0;font-family:${SANS};font-size:11px;line-height:1.7;color:#9a9182;">${escapeHtml(instanceBefore)}<span style="font-family:${MONO};">${escapeHtml(t.instance)}</span>${escapeHtml(instanceAfter)}</p>`
    : ''
}
</td></tr>
</table>

</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`

  const text = [
    t.heading,
    '',
    ...t.blocks.map(blockText),
    ...(t.action ? ['', t.action.url] : []),
    '',
    ...t.footnote,
    ...(t.instance
      ? ['', i18n.translate(lang, 'Sent by your own instance at {host}.', { host: t.instance })]
      : []),
  ].join('\n')

  return { subject: t.subject, text, html }
}

function instanceOf(link: string): string | undefined {
  try {
    return new URL(link).origin
  } catch {
    return undefined
  }
}

export function duration(seconds: number, lang = 'en'): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return minutes === 1
      ? i18n.translate(lang, '1 minute')
      : i18n.translate(lang, '{n} minutes', { n: minutes })
  }
  const hours = Math.round(minutes / 60)
  if (hours < 48) {
    return hours === 1
      ? i18n.translate(lang, '1 hour')
      : i18n.translate(lang, '{n} hours', { n: hours })
  }
  const days = Math.round(hours / 24)
  return i18n.translate(lang, '{n} days', { n: days })
}

export function verificationEmail(link: string, ttlSeconds: number, lang = 'en'): EmailContent {
  const lasts = duration(ttlSeconds, lang)
  const tr = (text: string, params?: Record<string, string | number>) =>
    i18n.translate(lang, text, params)
  return render({
    subject: tr('Confirm your email for Send to eReader'),
    preheader: tr('Takes one tap. Nothing changes until you do.'),
    heading: tr('Confirm your email'),
    blocks: [
      {
        kind: 'text',
        lines: [tr('Confirm and this instance remembers your devices, defaults and history.')],
      },
    ],
    action: { label: tr('Confirm email address'), url: link },
    instance: instanceOf(link),
    footnote: [tr('The link expires in {lasts}.', { lasts })],
    lang,
  })
}

export function resetEmail(link: string, ttlSeconds: number, lang = 'en'): EmailContent {
  const lasts = duration(ttlSeconds, lang)
  const tr = (text: string, params?: Record<string, string | number>) =>
    i18n.translate(lang, text, params)
  return render({
    subject: tr('Reset your password'),
    preheader: tr('Valid {lasts}. Nothing has changed yet.', { lasts }),
    heading: tr('Reset your password'),
    blocks: [
      {
        kind: 'text',
        lines: [tr('Someone asked to reset your password on this instance.')],
      },
    ],
    action: { label: tr('Choose a new password'), url: link },
    instance: instanceOf(link),
    footnote: [
      tr('Your current password keeps working and this link expires in {lasts}.', { lasts }),
    ],
    lang,
  })
}

export function signInLinkEmail(link: string, ttlSeconds: number, lang = 'en'): EmailContent {
  const lasts = duration(ttlSeconds, lang)
  const tr = (text: string, params?: Record<string, string | number>) =>
    i18n.translate(lang, text, params)
  return render({
    subject: tr('Your sign-in link'),
    preheader: tr('Good for {lasts}, one use.', { lasts }),
    heading: tr('Sign in'),
    blocks: [
      {
        kind: 'text',
        lines: [tr('Someone asked for a sign-in link for this address a moment ago.')],
      },
    ],
    action: { label: tr('Sign in'), url: link },
    instance: instanceOf(link),
    footnote: [tr('Good for {lasts} and one use.', { lasts })],
    lang,
  })
}

export function welcomeEmail(link: string, host: string, lang = 'en'): EmailContent {
  const tr = (text: string, params?: Record<string, string | number>) =>
    i18n.translate(lang, text, params)
  return render({
    subject: tr("You're set. Here's how to get a book onto your eReader."),
    preheader: tr('Three steps, about a minute.'),
    heading: tr('Welcome'),
    blocks: [
      {
        kind: 'text',
        lines: [tr('The account means this instance remembers your devices and options.')],
      },
      {
        kind: 'steps',
        steps: [
          { title: tr('Open the browser on your eReader and go to'), code: host },
          { title: tr('It shows four characters. Leave that page on screen.') },
          { title: tr('Type them on your computer, pick a file, send.') },
        ],
      },
    ],
    action: { label: tr('Send your first book'), url: link },
    instance: instanceOf(link),
    footnote: [],
    lang,
  })
}

export function setupTestEmail(host: string, lang = 'en'): EmailContent {
  const tr = (text: string, params?: Record<string, string | number>) =>
    i18n.translate(lang, text, params)
  return render({
    subject: tr('Mail works'),
    preheader: tr('Sent from the setup assistant.'),
    heading: tr('Mail works'),
    blocks: [
      {
        kind: 'text',
        lines: [tr('Reading this means the SMTP settings you just entered are right.')],
      },
    ],
    instance: instanceOf(host),
    footnote: [tr('Nothing on the server changed because of this message.')],
    lang,
  })
}

export function emailChangeEmail(link: string, ttlSeconds: number, lang = 'en'): EmailContent {
  const lasts = duration(ttlSeconds, lang)
  const tr = (text: string, params?: Record<string, string | number>) =>
    i18n.translate(lang, text, params)
  return render({
    subject: tr('Confirm this is your address'),
    preheader: tr('Valid {lasts}. The account still answers to the old one until you do.', {
      lasts,
    }),
    heading: tr('Confirm your new address'),
    blocks: [
      {
        kind: 'text',
        lines: [tr('Confirm and this becomes the address the account signs in with.')],
      },
    ],
    action: { label: tr('Confirm this address'), url: link },
    instance: instanceOf(link),
    footnote: [tr('The link expires in {lasts} and can be used once.', { lasts })],
    lang,
  })
}

export function emailMovedEmail(host: string, to: string, when: string, lang = 'en'): EmailContent {
  const tr = (text: string, params?: Record<string, string | number>) =>
    i18n.translate(lang, text, params)
  return render({
    subject: tr('This account now uses a different address'),
    preheader: tr('If this was you, nothing to do.'),
    heading: tr('The address on this account changed'),
    blocks: [
      {
        kind: 'text',
        lines: [tr('This address no longer signs in to that account.')],
      },
      {
        kind: 'facts',
        rows: [
          [tr('Now'), to],
          [tr('When'), when],
        ],
      },
    ],
    instance: instanceOf(host),
    footnote: [tr('Not you? Ask whoever runs this server to put the account back.')],
    lang,
  })
}

export function failedSignInsEmail(
  link: string,
  attempts: number,
  when: string,
  where: string,
  lang = 'en'
): EmailContent {
  const tr = (text: string, params?: Record<string, string | number>) =>
    i18n.translate(lang, text, params)
  return render({
    subject: tr('Someone is guessing at your password'),
    preheader: tr('Several sign-ins failed on your account.'),
    heading: tr('Failed sign-ins on your account'),
    blocks: [
      {
        kind: 'text',
        lines: [
          tr('Nobody got in — {n} wrong passwords in a row were turned away.', { n: attempts }),
        ],
      },
      {
        kind: 'facts',
        rows: [
          [tr('Attempts'), String(attempts)],
          [tr('Last one'), when],
          [tr('From'), where],
        ],
      },
    ],
    action: { label: tr('Change your password'), url: link, variant: 'solid' },
    instance: instanceOf(link),
    footnote: [tr('Not you? Change the password — the address is already known.')],
    lang,
  })
}

export function passwordChangedEmail(
  link: string,
  when: string,
  where: string,
  lang = 'en'
): EmailContent {
  const tr = (text: string, params?: Record<string, string | number>) =>
    i18n.translate(lang, text, params)
  return render({
    subject: tr('Your password was changed'),
    preheader: tr('If this was you, nothing to do.'),
    heading: tr('Password changed'),
    blocks: [
      {
        kind: 'text',
        lines: [tr('The password on this account changed a few seconds ago.')],
      },
      {
        kind: 'facts',
        rows: [
          [tr('When'), when],
          [tr('Where'), where],
        ],
      },
    ],
    action: { label: tr("This wasn't me"), url: link, variant: 'outline' },
    instance: instanceOf(link),
    footnote: [tr('That link goes straight to a password reset.')],
    lang,
  })
}
