import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { type Db, openDatabase } from '../src/db/index.js'
import { fillIn, I18n, i18n } from '../src/i18n.js'
import { duration, signInLinkEmail } from '../src/mail/template.js'
import { asBrowser } from './helpers.js'

const noTools = {
  kepubify: false,
  calibre: false,
  pdfcropmargins: false,
  kfxInput: false,
  kfxOutput: false,
  layoutFix: false,
}

const roots: string[] = []

function catalogDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 's2e-i18n-'))
  roots.push(dir)
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  }
  return dir
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

const german = {
  _meta: { code: 'de', name: 'Deutsch' },
  strings: {
    Send: 'Senden',
    'At least {min} characters': 'Mindestens {min} Zeichen',
    "Or drag and drop like it's hot": 'Oder einfach hineinziehen',
  },
}

describe('the catalog scan', () => {
  it('reads a language from a dropped file', () => {
    const own = new I18n([catalogDir({ 'de.json': german })])
    expect(own.installed()).toEqual([
      { code: 'en', name: 'English' },
      { code: 'de', name: 'Deutsch' },
    ])
    expect(own.isInstalled('de')).toBe(true)
    expect(own.isInstalled('fr')).toBe(false)
  })

  it('always offers English first, even with nothing installed', () => {
    const own = new I18n([join(tmpdir(), 'does-not-exist-anywhere')])
    expect(own.installed()).toEqual([{ code: 'en', name: 'English' }])
    expect(own.isInstalled('en')).toBe(true)
  })

  it('lets the data directory replace the shipped file whole', () => {
    const shipped = catalogDir({ 'de.json': german })
    const dropped = catalogDir({
      'de.json': {
        _meta: { code: 'de', name: 'Deutsch (angepasst)' },
        strings: { Send: 'Abschicken' },
      },
    })
    const own = new I18n([shipped, dropped])
    expect(own.translate('de', 'Send')).toBe('Abschicken')
    expect(own.translate('de', "Or drag and drop like it's hot")).toBe(
      "Or drag and drop like it's hot"
    )
    expect(own.installed()[1]?.name).toBe('Deutsch (angepasst)')
  })

  it('skips what it cannot trust and boots anyway', () => {
    const own = new I18n([
      catalogDir({
        'broken.json': '{not json',
        'anon.json': { strings: { Send: 'X' } },
        'en.json': { _meta: { code: 'en', name: 'English again' }, strings: { Send: 'X' } },
        'de.json': german,
      }),
    ])
    expect(own.installed().map((entry) => entry.code)).toEqual(['en', 'de'])
  })
})

describe('translate', () => {
  const own = new I18n([catalogDir({ 'de.json': german })])

  it('answers from the catalog and falls back to the English text', () => {
    expect(own.translate('de', 'Send')).toBe('Senden')
    expect(own.translate('de', 'Never translated')).toBe('Never translated')
    expect(own.translate('fr', 'Send')).toBe('Send')
    expect(own.translate('en', 'Send')).toBe('Send')
  })

  it('fills placeholders in both directions', () => {
    expect(own.translate('de', 'At least {min} characters', { min: 10 })).toBe(
      'Mindestens 10 Zeichen'
    )
    expect(own.translate('fr', 'At least {min} characters', { min: 8 })).toBe(
      'At least 8 characters'
    )
    expect(fillIn('{a} and {b}', { a: 1 })).toBe('1 and {b}')
  })
})

describe('translatePage', () => {
  const own = new I18n([
    catalogDir({
      'de.json': {
        _meta: { code: 'de', name: 'Deutsch' },
        strings: {
          Send: 'Senden',
          'Choose a file': 'Datei auswählen',
          "Or drag and drop like it's hot": 'Oder <einfach> hineinziehen',
          'you@example.com': 'du@beispiel.de',
        },
      },
    }),
  ])

  it('replaces whole text nodes and keeps the whitespace around them', () => {
    const page = '<html lang="en">\n\t<p>\n\t\tSend\n\t</p>\n\t<p>Half Send here</p>'
    const out = own.translatePage(page, 'de')
    expect(out).toContain('lang="de"')
    expect(out).toContain('<p>\n\t\tSenden\n\t</p>')
    expect(out).toContain('Half Send here')
  })

  it('translates only whitelisted attributes, exactly on hit', () => {
    const page =
      '<input placeholder="you@example.com" value="mobi"/><a title="Choose a file" href="Send">x</a>'
    const out = own.translatePage(page, 'de')
    expect(out).toContain('placeholder="du@beispiel.de"')
    expect(out).toContain('value="mobi"')
    expect(out).toContain('title="Datei auswählen"')
    expect(out).toContain('href="Send"')
  })

  it('escapes what a translation brings along', () => {
    const out = own.translatePage("<p>Or drag and drop like it's hot</p>", 'de')
    expect(out).toContain('<p>Oder &lt;einfach&gt; hineinziehen</p>')
  })

  it('decodes the entities copy.test normalises before looking up', () => {
    const withEntity = new I18n([
      catalogDir({
        'de.json': {
          _meta: { code: 'de', name: 'Deutsch' },
          strings: { "Don't convert": 'Nicht konvertieren' },
        },
      }),
    ])
    expect(withEntity.translatePage('<p>Don&#39;t convert</p>', 'de')).toContain(
      'Nicht konvertieren'
    )
  })

  it('leaves an uninstalled language untouched', () => {
    const page = '<html lang="en"><p>Send</p>'
    expect(own.translatePage(page, 'fr')).toBe(page)
  })
})

describe('the dictionary for the client', () => {
  const own = new I18n([catalogDir({ 'de.json': german })])

  it('hands over the catalog and the installed list', () => {
    const dict = own.dictionary('de')
    expect(dict.language).toBe('de')
    expect(dict.languages.map((entry) => entry.code)).toEqual(['en', 'de'])
    expect(dict.strings.Send).toBe('Senden')
  })

  it('degrades an unknown code to English', () => {
    const dict = own.dictionary('fr')
    expect(dict.language).toBe('en')
    expect(dict.strings).toEqual({})
  })
})

describe('the shipped German file', () => {
  it('is loaded by the real scanner', () => {
    expect(i18n.isInstalled('de')).toBe(true)
    expect(i18n.installed().length).toBeGreaterThan(1)
  })

  it('translates the send page for real', () => {
    const html = readFileSync('static/send.html', 'utf8')
    const out = i18n.translatePage(html, 'de')
    expect(out).toContain('lang="de"')
    expect(out).toContain('Sende ein Buch an deinen eReader')
    expect(out).not.toContain('Send a book to your eReader')
  })

  it('never invents placeholders a key does not have', () => {
    const parsed = JSON.parse(readFileSync('languages/de.json', 'utf8'))
    for (const [key, value] of Object.entries<string>(parsed.strings)) {
      const shape = (text: string) =>
        [...text.matchAll(/\{\w+\}/g)]
          .map((hit) => hit[0])
          .sort()
          .join(' ')
      expect(shape(value), key).toBe(shape(key))
    }
  })
})

describe('the data-side folder', () => {
  it('exists after the module loads, ready for drops', () => {
    expect(existsSync(join('data-test', 'languages'))).toBe(true)
  })
})

describe('the account language', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let db: Db

  beforeEach(async () => {
    db = openDatabase(':memory:')
    app = asBrowser(await buildApp({ tools: noTools, logger: false, accounts: true, db }))
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    db.close()
  })

  function cookieFrom(res: { headers: Record<string, unknown> }): string {
    const raw = res.headers['set-cookie']
    const all = Array.isArray(raw) ? raw : [raw]
    return (
      all
        .map(String)
        .find((c) => c.startsWith('s2e_session='))
        ?.split(';')[0] ?? ''
    )
  }

  async function signedIn(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'reader@example.com',
        password: 'a-perfectly-fine-password',
        firstName: 'Lese',
        lastName: 'Ratte',
      },
    })
    return cookieFrom(res)
  }

  it('stores a choice, refuses a stranger, and clears back to the default', async () => {
    const cookie = await signedIn()

    const set = await app.inject({
      method: 'POST',
      url: '/auth/language',
      headers: { cookie },
      payload: { language: 'de' },
    })
    expect(set.json()).toMatchObject({ ok: true, language: 'de' })
    expect(app.repos.users.byEmail('reader@example.com')?.language).toBe('de')

    const status = await app.inject({ url: '/auth/status', headers: { cookie } })
    expect(status.json().language).toBe('de')
    expect(status.json().languages.map((entry: { code: string }) => entry.code)).toContain('de')

    const page = await app.inject({ url: '/send', headers: { cookie } })
    expect(page.body).toContain('lang="de"')

    const refused = await app.inject({
      method: 'POST',
      url: '/auth/language',
      headers: { cookie },
      payload: { language: 'fr' },
    })
    expect(refused.statusCode).toBe(400)

    const cleared = await app.inject({
      method: 'POST',
      url: '/auth/language',
      headers: { cookie },
      payload: { language: null },
    })
    expect(cleared.json()).toMatchObject({ ok: true, language: null })
    expect(app.repos.users.byEmail('reader@example.com')?.language).toBeNull()
  })

  it('lets the account choice beat the browser cookie', async () => {
    const cookie = await signedIn()
    await app.inject({
      method: 'POST',
      url: '/auth/language',
      headers: { cookie },
      payload: { language: 'de' },
    })
    const page = await app.inject({
      url: '/send',
      headers: { cookie: `${cookie}; s2e_lang=en` },
    })
    expect(page.body).toContain('lang="de"')
  })

  it('needs a signed-in caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/language',
      payload: { language: 'de' },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('serving in a chosen language', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    app = await buildApp({ tools: noTools, logger: false, accounts: false })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('translates a page for the cookie and leaves the default English', async () => {
    const german = await app.inject({ url: '/send', headers: { cookie: 's2e_lang=de' } })
    expect(german.body).toContain('lang="de"')
    expect(german.body).toContain('Sende ein Buch an deinen eReader')

    const english = await app.inject({ url: '/send' })
    expect(english.body).toContain('lang="en"')
    expect(english.body).toContain('Send a book to your eReader')
  })

  it('ignores a cookie for a language nobody installed', async () => {
    const res = await app.inject({ url: '/send', headers: { cookie: 's2e_lang=fr' } })
    expect(res.body).toContain('lang="en"')
  })

  it('keeps the asset stamps inside a translated page', async () => {
    const res = await app.inject({ url: '/send', headers: { cookie: 's2e_lang=de' } })
    expect(res.body).toMatch(/app\.css\?v=[0-9a-f]{10}/)
  })

  it('offers the installed languages as the admin default choices', async () => {
    const { SETTING_SPECS } = await import('../src/settings.js')
    const spec = SETTING_SPECS.find((entry) => entry.key === 'LANGUAGE')
    expect(spec?.kind).toBe('choice')
    const values = (spec?.choices ?? []).map((choice) => choice.value)
    expect(values).toContain('en')
    expect(values).toContain('de')
    const { problemWith } = await import('../src/settings.js')
    expect(problemWith(spec!, 'de')).toBeNull()
    expect(problemWith(spec!, 'not-a-choice')).toBeTruthy()
  })

  it('hands the client its dictionary, and English for a stranger', async () => {
    const german = await app.inject({ url: '/i18n/de' })
    expect(german.statusCode).toBe(200)
    const dict = german.json()
    expect(dict.language).toBe('de')
    expect(dict.strings.Send).toBe('Senden')
    expect(dict.languages.map((entry: { code: string }) => entry.code)).toContain('de')

    const unknown = await app.inject({ url: '/i18n/fr' })
    expect(unknown.json().language).toBe('en')

    const nonsense = await app.inject({ url: '/i18n/___' })
    expect(nonsense.statusCode).toBe(404)
  })
})

describe('mail speaks the language it is given', () => {
  it('renders the sign-in link mail in German', () => {
    const mail = signInLinkEmail('https://books.example/auth/link?token=x', 900, 'de')
    expect(mail.subject).toBe('Dein Anmeldelink')
    expect(mail.text).toContain('15 Minuten gültig und einmal verwendbar.')
    expect(mail.text).toContain('Gesendet von deiner eigenen Instanz auf https://books.example.')
    expect(mail.html).toContain('<html lang="de">')
  })

  it('falls back to English without a language', () => {
    const mail = signInLinkEmail('https://books.example/auth/link?token=x', 900)
    expect(mail.subject).toBe('Your sign-in link')
    expect(mail.text).toContain('Good for 15 minutes and one use.')
    expect(mail.html).toContain('<html lang="en">')
  })

  it('spells durations in the asked language', () => {
    expect(duration(900)).toBe('15 minutes')
    expect(duration(900, 'de')).toBe('15 Minuten')
    expect(duration(60, 'de')).toBe('1 Minute')
    expect(duration(86400, 'de')).toBe('24 Stunden')
  })
})
