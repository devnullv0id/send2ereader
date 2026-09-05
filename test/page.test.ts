import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { config } from '../src/config.js'
import { Pages } from '../src/pages.js'

const staticDir = config.staticDir
const sendJs = readFileSync(join(staticDir, 'send.js'), 'utf8')
const sendPageJs = readFileSync(join(staticDir, 'send-page.js'), 'utf8')

// biome-ignore lint/suspicious/noExplicitAny: a plain-JS module with no types.
const logic: any = (() => {
  const sandbox: Record<string, unknown> = { module: { exports: {} } }
  vm.runInContext(sendJs, vm.createContext(sandbox))
  return (sandbox.module as { exports: { SendLogic: unknown } }).exports.SendLogic
})()

const ALL = { kepubify: true, calibre: true, pdfcropmargins: true, layoutFix: true }
const NO_KEPUBIFY = { ...ALL, kepubify: false }

describe('the target note', () => {
  it('names the paired device under Auto', () => {
    expect(logic.targetNote('kobo', 'auto')).toBe(
      "Auto uses whichever device generated the key — right now that's a Kobo."
    )
    expect(logic.targetNote('tolino', 'auto')).toContain("that's a Tolino")
  })

  it('defaults to auto before a key is entered', () => {
    expect(logic.targetNote(null, 'auto')).toBe('Auto uses whichever device generated the key.')
  })

  it('describes each forced path', () => {
    expect(logic.targetNote(null, 'kobo')).toContain('EPUB becomes a Kobo EPUB')
    expect(logic.targetNote(null, 'kindle')).toContain('become AZW3')
  })

  it('says plainly when conversion is off', () => {
    expect(logic.targetNote('kobo', 'none')).toBe(
      'Sends the bytes exactly as they are. Your device may not open them.'
    )
  })

  it('does not depend on which converters are installed', () => {
    expect(logic.targetNote('kobo', 'auto')).not.toContain('kepubify')
  })
})

describe('what the pipeline will do', () => {
  it('sends an EPUB to a Kobo through kepubify', () => {
    const out = logic.outcome('epub', 'kobo', ALL, 'azw3')
    expect(out.label).toBe('Kobo EPUB')
    expect(out.via).toEqual(['kepubify'])
  })

  it('leaves the file alone when its converter is missing', () => {
    const out = logic.outcome('epub', 'kobo', NO_KEPUBIFY, 'azw3')
    expect(out.label).toBe('EPUB')
    expect(out.via).toEqual([])
  })

  it('converts for a Kindle in the format asked for', () => {
    expect(logic.outcome('epub', 'kindle', ALL, 'mobi').label).toBe('MOBI')
    expect(logic.outcome('epub', 'kindle', ALL, 'azw3').label).toBe('AZW3')
  })

  it('leaves formats a Kindle already reads alone', () => {
    for (const ext of ['mobi', 'azw3', 'kfx', 'pdf']) {
      expect(logic.outcome(ext, 'kindle', ALL, 'azw3').via, ext).toEqual([])
    }
  })

  it('names both steps when a KFX has to be unwrapped first', () => {
    expect(logic.outcome('kfx', 'kobo', ALL, 'azw3').via).toEqual(['calibre', 'kepubify'])
  })
})

describe('which fixes are offered', () => {
  const applicable = (ext: string, target: string, name = 'book.epub') =>
    logic
      .fixes(ext, target, ALL, name)
      .filter((f: { applies: boolean; available: boolean }) => f.applies && f.available)
      .map((f: { id: string }) => f.id)

  it('offers the layout fix for an EPUB going to a Kobo', () => {
    expect(applicable('epub', 'kobo')).toContain('layoutFix')
  })

  it('does not offer it for a Kindle, whose renderer has no such defect', () => {
    expect(applicable('epub', 'kindle')).not.toContain('layoutFix')
  })

  it('offers margin cropping only for a PDF', () => {
    expect(applicable('pdf', 'none', 'book.pdf')).toContain('pdfcropmargins')
    expect(applicable('epub', 'none')).not.toContain('pdfcropmargins')
  })

  it('offers transliteration for a non-ASCII name, or any Kindle', () => {
    expect(applicable('epub', 'none', 'Ärger.epub')).toContain('transliteration')
    expect(applicable('epub', 'kindle')).toContain('transliteration')
    expect(applicable('epub', 'none')).not.toContain('transliteration')
  })

  it('reports an option as unavailable rather than dropping it', () => {
    const missing = { ...ALL, layoutFix: false }
    const fix = logic
      .fixes('epub', 'kobo', missing, 'book.epub')
      .find((f: { id: string }) => f.id === 'layoutFix')
    expect(fix.applies).toBe(true)
    expect(fix.available).toBe(false)
  })
})

describe('what the page says about the copy that was kept', () => {
  it('says nothing at all when the question never arose', () => {
    expect(logic.keptLine(null, 'convert')).toBeNull()
    expect(logic.keptLine(undefined, 'send')).toBeNull()
  })

  it('says nothing to an account that chose to keep nothing', () => {
    expect(logic.keptLine({ kept: false, reason: 'off' }, 'convert')).toBeNull()
  })

  it('confirms the copy when there is one', () => {
    const line = logic.keptLine({ kept: true, id: 'x', expiresAt: '2030-01-01' }, 'convert')
    expect(line).toEqual({ full: false, text: 'A copy is in your History.' })
  })

  it('warns that the download is the only copy when the account is full', () => {
    const line = logic.keptLine({ kept: false, reason: 'user-full' }, 'convert')
    expect(line.full).toBe(true)
    expect(line.text).toContain('Your library is full')
    expect(line.text).toContain('no copy was kept')
    expect(line.text).toContain('only copy')
  })

  it('blames the server rather than the reader when the disk is full', () => {
    const line = logic.keptLine({ kept: false, reason: 'server-full' }, 'convert')
    expect(line.full).toBe(true)
    expect(line.text).toContain("This server's library is full")
    expect(line.text).not.toContain('Your library')
  })

  it('says where the book went, which differs between the two pages', () => {
    const sent = logic.keptLine({ kept: false, reason: 'user-full' }, 'send')
    const converted = logic.keptLine({ kept: false, reason: 'user-full' }, 'convert')
    expect(sent.text).toContain('on its way to your eReader')
    expect(sent.text).not.toContain('download')
    expect(converted.text).toContain('download')
  })

  it('is not fooled by a reason it has never heard of', () => {
    expect(logic.keptLine({ kept: false, reason: 'something-new' }, 'send')).toBeNull()
  })
})

describe('what the dropzone accepts', () => {
  it('reads .kepub.epub as one extension', () => {
    expect(logic.extensionOf('My Book.kepub.epub')).toBe('kepub')
    expect(logic.extensionOf('My Book.epub')).toBe('epub')
  })

  it('accepts every format the server does, and nothing else', () => {
    for (const name of ['a.epub', 'a.kepub.epub', 'a.azw3', 'a.kfx', 'a.pdf', 'a.cbz']) {
      expect(logic.isAccepted(name), name).toBe(true)
    }
    for (const name of ['a.docx', 'a.zip', 'a']) {
      expect(logic.isAccepted(name), name).toBe(false)
    }
  })
})

describe('setup page', () => {
  const setup = readFileSync(join(staticDir, 'setup.html'), 'utf8')

  const claimWording = /(?<!un)claim/i

  it('asks for an administrator, not to "claim" anything', () => {
    expect(setup).toContain('Administrator e-mail')
    expect(setup).not.toMatch(claimWording)
  })

  it('confirms the password, because a typo here is a lockout', () => {
    expect(setup).toContain('id="confirm"')
    const signin = readFileSync(join(staticDir, 'signin.js'), 'utf8')
    expect(signin).toContain("$('password').value !== $('confirm').value")
    expect(signin).toContain("Those two don't match.")
  })

  it('warns that an unset-up server is open to whoever reaches it first', () => {
    expect(setup).toMatch(/anyone who can reach this server/i)
  })

  it('leaves no "claim" wording on the other pages', () => {
    for (const page of ['register.html', 'send.html', 'login.html', 'settings.html']) {
      expect(readFileSync(join(staticDir, page), 'utf8'), page).not.toMatch(claimWording)
    }
  })
})

describe('password policy in the forms', () => {
  const pages = ['setup.html', 'register.html', 'reset.html']

  it.each(pages)('marks the note in %s so it can be rewritten', (page) => {
    const source = readFileSync(join(staticDir, page), 'utf8')
    expect(source).toContain('data-password-note')
    expect(source).toContain('signin.js')
  })

  it('is applied by the script those pages load', () => {
    expect(readFileSync(join(staticDir, 'signin.js'), 'utf8')).toContain('applyPasswordPolicy(')
  })

  it('states the policy once per page, in the field', () => {
    for (const page of pages) {
      const source = readFileSync(join(staticDir, page), 'utf8')
      expect([...source.matchAll(/data-password-note/g)], page).toHaveLength(1)
      expect(source, `${page}: the marker belongs on the field`).toMatch(
        /<input[^>]*data-password-note/
      )
    }
  })
})

describe('forms that ask for a password twice', () => {
  const pages = ['setup.html', 'register.html', 'reset.html']
  const signin = readFileSync(join(staticDir, 'signin.js'), 'utf8')

  it.each(pages)('%s starts with its submit disabled', (page) => {
    const source = readFileSync(join(staticDir, page), 'utf8')
    expect(source).toMatch(/id="submitbtn"[^>]*\bdisabled\b/)
    expect(source, 'and has a second field to compare').toContain('id="confirm"')
  })

  it('gates sign in on both its fields too, though it asks only once', () => {
    const login = readFileSync(join(staticDir, 'login.html'), 'utf8')
    expect(login).toMatch(/id="submitbtn"[^>]*\bdisabled\b/)
    expect(login, 'the password must count towards validity').toMatch(
      /id="password"[^>]*\brequired\b/
    )
    expect(signin).toMatch(/required = option\.dataset\.mode === 'password'/)
  })

  it('enables it on validity and a matching pair, not on a field count', () => {
    expect(signin).toContain('form.checkValidity()')
    expect(signin).toMatch(/confirm\.value === password\.value/)
  })

  it.each(pages)('%s can reveal what was typed, from inside the field', (page) => {
    const source = readFileSync(join(staticDir, page), 'utf8')
    expect(source).toContain('data-reveal')
    expect(source, 'the control sits in the field, not beside the label').toMatch(
      /<div class="auth__field-wrap">[\s\S]*?data-reveal/
    )
  })

  it('reveals every password field together, not one of a pair', () => {
    expect(signin).toContain('input[autocomplete$="password"]')
  })

  it('rewrites the note and the minlength from the server policy', () => {
    const notes: { textContent: string }[] = []
    const inputs: { minLength: number; type: string }[] = [
      { minLength: 10, type: 'password' },
      { minLength: 10, type: 'password' },
    ]
    const ctx = {
      document: {
        querySelectorAll: (selector: string) =>
          selector.includes('password-note') ? notes : inputs,
      },
    }
    notes.push({ textContent: 'At least 10 characters. Length beats punctuation.' })

    const auth = readFileSync(join(staticDir, 'auth.js'), 'utf8')
    const fn = new Function('document', `${auth}; return applyPasswordPolicy`)(ctx.document) as (
      status: unknown
    ) => void

    fn({ minPasswordLength: 5 })
    expect(notes[0]!.textContent).toBe('At least 5 characters. Length beats punctuation.')
    expect(inputs.every((i) => i.minLength === 5)).toBe(true)
  })

  it('rewrites the placeholder when the marker is on the field itself', () => {
    const field = { tagName: 'INPUT', placeholder: 'At least eight characters', minLength: 0 }
    const auth = readFileSync(join(staticDir, 'auth.js'), 'utf8')
    const fn = new Function('document', `${auth}; return applyPasswordPolicy`)({
      querySelectorAll: () => [field],
    }) as (status: unknown) => void

    fn({ minPasswordLength: 10 })
    expect(field.placeholder).toBe('At least 10 characters')
    expect(field.minLength).toBe(10)
  })

  it('leaves the markup default alone when the server says nothing', () => {
    const notes = [{ textContent: 'At least 10 characters. Length beats punctuation.' }]
    const auth = readFileSync(join(staticDir, 'auth.js'), 'utf8')
    const fn = new Function('document', `${auth}; return applyPasswordPolicy`)({
      querySelectorAll: () => notes,
    }) as (status: unknown) => void

    fn(null)
    fn({})
    expect(notes[0]!.textContent).toBe('At least 10 characters. Length beats punctuation.')
  })
})

describe('the hidden attribute actually hides', () => {
  const css = readFileSync(join(staticDir, 'app.css'), 'utf8')

  it('has a [hidden] reset that outranks class rules', () => {
    const reset = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/
    expect(css).toMatch(reset)
  })

  it('places the reset before the rules that set display', () => {
    const resetAt = css.search(/\[hidden\]\s*\{/)
    const firstDisplay = css.slice(resetAt).search(/^\s+display:/m)
    expect(resetAt).toBeGreaterThan(-1)
    expect(firstDisplay).toBeGreaterThan(0)
  })

  it('still hides every element the pages start hidden', () => {
    const expected: Record<string, string[]> = {
      'settings.html': [
        'koboOn',
        'delConfirm',
        'codesModal',
        'passkeyList',
        'emailUnconfirmed',
        'emailConfirmed',
        'tfaModal',
        'tfaOn',
        'emailPending',
      ],
      'login.html': ['ssofield', 'registerlink'],
      'send.html': ['pairedBranch', 'syncBranch', 'overlay', 'refusal', 'filerow'],
      'convert.html': ['filerow', 'refusal', 'donepanel', 'errorpanel'],
    }
    for (const [page, ids] of Object.entries(expected)) {
      const source = readFileSync(join(staticDir, page), 'utf8')
      for (const id of ids) {
        expect(source, `${page} #${id}`).toMatch(new RegExp(`id="${id}"[^>]*hidden`))
      }
    }
  })
})

const PORTED = [
  'send.html',
  'linked.html',
  'convert.html',
  'history.html',
  'waiting.html',
  'settings.html',
  'login.html',
  'register.html',
  'forgot.html',
  'reset.html',
  'setup.html',
]

describe('the ported pages keep style out of the markup', () => {
  it.each(PORTED)('has no style attribute or style block in %s', (page) => {
    const source = readFileSync(join(staticDir, page), 'utf8')
    expect(
      [...source.matchAll(/\sstyle="[^"]*"/g)].map((m) => m[0]),
      'inline style'
    ).toEqual([])
    expect(source, 'style block').not.toMatch(/<style[\s>]/)
  })

  it.each([
    'send-page.js',
    'convert.js',
    'history-page.js',
    'waiting.js',
    'settings.js',
    'signin.js',
    'shell.js',
  ])('writes no declaration into an element in %s', (file) => {
    const source = readFileSync(join(staticDir, file), 'utf8')
    expect(
      [...source.matchAll(/\.style\.(?!setProperty\b)[a-zA-Z]+/g)].map((m) => m[0]),
      'property write'
    ).toEqual([])
    expect(
      [...source.matchAll(/setProperty\(\s*['"](?!--)/g)].map((m) => m[0]),
      'named property'
    ).toEqual([])
  })
})

describe('every class in the ported markup has a rule', () => {
  const sheets = ['app.css', 'screens.css', 'fonts/phosphor.css']
    .map((f) => readFileSync(join(staticDir, f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  it.each(PORTED)('defines every class %s uses', (page) => {
    const source = readFileSync(join(staticDir, page), 'utf8')
    const used = new Set<string>()
    for (const m of source.matchAll(/class="([^"]+)"/g)) {
      for (const name of (m[1] as string).split(/\s+/)) {
        if (name && !name.startsWith('is-')) used.add(name)
      }
    }

    expect(used.size, 'suspiciously few classes for a real page').toBeGreaterThan(5)
    const missing = [...used].filter((name) => !sheets.includes(`.${name}`))
    expect(missing).toEqual([])
  })
})

describe('controls the design draws that this server cannot back', () => {
  const EXPECTED: Record<string, string[]> = {
    'send.html': [],
    'settings.html': [],
    'login.html': [],
  }

  it.each(Object.entries(EXPECTED))('%s disables exactly the ones listed', (page, ids) => {
    const source = readFileSync(join(staticDir, page), 'utf8')
    const marked = [...source.matchAll(/id="([\w-]+)"[^>]*\bdata-unbacked=/g)].map((m) => m[1])
    expect(marked.sort()).toEqual([...ids].sort())
  })

  it('disables every control it marks, on every page', () => {
    for (const page of readdirSync(staticDir).filter((f) => f.endsWith('.html'))) {
      const source = readFileSync(join(staticDir, page), 'utf8')
      for (const m of source.matchAll(/<[^>]*\bdata-unbacked=[^>]*>/g)) {
        expect(m[0], `${page}: marked unbacked but not disabled`).toMatch(/\bdisabled\b/)
      }
    }
  })

  it('says on each one what it is waiting for', () => {
    for (const page of readdirSync(staticDir).filter((f) => f.endsWith('.html'))) {
      const source = readFileSync(join(staticDir, page), 'utf8')
      for (const m of source.matchAll(/data-unbacked="([^"]*)"/g)) {
        expect((m[1] as string).length, `${page}: empty reason`).toBeGreaterThan(10)
      }
    }
  })

  it('looks inert, not merely behaves inertly', () => {
    const css = readFileSync(join(staticDir, 'app.css'), 'utf8')
    expect(css).toMatch(/\[data-unbacked\]\s*\{[^}]*cursor/)
  })

  it('leaves every sign-in method it offers selectable', () => {
    const login = readFileSync(join(staticDir, 'login.html'), 'utf8')
    for (const mode of ['password', 'link']) {
      const tag = new RegExp(`data-mode="${mode}"[^>]*`).exec(login)?.[0] ?? ''
      expect(tag, mode).toBeTruthy()
      expect(tag, mode).not.toMatch(/\bdisabled\b/)
    }

    const tabs = [...login.matchAll(/data-mode="([\w-]+)"/g)].map((m) => m[1]).sort()
    const panes = [...login.matchAll(/data-pane="([\w-]+)"/g)].map((m) => m[1]).sort()
    expect(panes).toEqual(tabs)

    expect(tabs).not.toContain('code')
  })
})

describe('the shared chrome', () => {
  const chromed = readdirSync(staticDir).filter(
    (f) => f.endsWith('.html') && readFileSync(join(staticDir, f), 'utf8').includes('shell.js')
  )

  it('is asked for by more than one page', () => {
    expect(chromed.length).toBeGreaterThan(1)
  })

  it.each(chromed)('leaves shell.js somewhere to render in %s', (page) => {
    const source = readFileSync(join(staticDir, page), 'utf8')
    expect(source, 'header').toMatch(/<header[^>]*class="header"/)
    expect(source, 'footer').toMatch(/<footer[^>]*class="footer"/)
  })
})

describe('asset cache busting', () => {
  const pages = readdirSync(staticDir).filter((f) => f.endsWith('.html'))
  const rendered = new Pages(staticDir, false)

  const ASSET_REF = /(?:href|src)="(\/[\w./-]+\.(?:css|js))([^"]*)"/g

  // download.html is the page a Kobo's own browser renders and loads the legacy
  // stylesheet by a relative path. It is left exactly as it is, on purpose.
  const stamped = pages.filter((page) => page !== 'download.html')

  it('carries no hand-written version, because nobody bumps one any more', () => {
    for (const page of stamped) {
      const source = readFileSync(join(staticDir, page), 'utf8')
      for (const m of source.matchAll(ASSET_REF)) {
        expect(m[2], `${page} -> ${m[1]} still has a version written into the file`).toBe('')
      }
    }
  })

  it('stamps every asset with a hash of that asset when the page is served', () => {
    for (const page of stamped) {
      const html = rendered.html(page)!
      const refs = [...html.matchAll(ASSET_REF)]
      expect(refs.length, `${page} references nothing`).toBeGreaterThan(0)

      for (const m of refs) {
        expect(m[2], `${page} -> ${m[1]}`).toMatch(/^\?v=[0-9a-f]{10}$/)
      }
    }
  })

  it('gives one asset the same stamp on every page that names it', () => {
    const stamps = new Map<string, Set<string>>()
    for (const page of stamped) {
      for (const m of rendered.html(page)!.matchAll(ASSET_REF)) {
        const seen = stamps.get(m[1]!) ?? new Set<string>()
        seen.add(m[2]!)
        stamps.set(m[1]!, seen)
      }
    }
    for (const [asset, seen] of stamps) {
      expect([...seen], `${asset} is stamped differently on different pages`).toHaveLength(1)
    }
  })

  it('changes the stamp when the asset changes, and not before', () => {
    const asset = join(staticDir, 'app.css')
    const before = readFileSync(asset, 'utf8')
    const fresh = () =>
      /app\.css\?v=([0-9a-f]+)/.exec(new Pages(staticDir, false).html('send.html')!)?.[1]

    const first = fresh()
    expect(fresh(), 'same bytes, same stamp').toBe(first)

    writeFileSync(asset, `${before}\n/* a comment nobody will miss */\n`)
    try {
      expect(fresh(), 'different bytes, different stamp').not.toBe(first)
    } finally {
      writeFileSync(asset, before)
    }
    expect(fresh(), 'and back again once it is put back').toBe(first)
  })
})

describe('what the page will call a valid address', () => {
  const source = readFileSync(join(staticDir, 'auth.js'), 'utf8')
  const server = readFileSync(join(staticDir, '..', 'src/auth/service.ts'), 'utf8')

  const pattern = (text: string) => /^const EMAIL_RE = (\/.+\/)$/m.exec(text)?.[1]

  // biome-ignore lint/suspicious/noExplicitAny: a plain-JS module with no types.
  const auth: any = (() => {
    const sandbox: Record<string, unknown> = { module: { exports: {} } }
    vm.runInContext(source, vm.createContext(sandbox))
    return (sandbox.module as { exports: unknown }).exports
  })()

  it('is character for character the rule the server applies', () => {
    expect(pattern(source), 'auth.js has no plain EMAIL_RE literal').toBeTruthy()
    expect(pattern(source)).toBe(pattern(server))
  })

  it.each(['you@example.com', 'a.b+tag@sub.example.co.uk'])('accepts %s', (address) => {
    expect(auth.looksLikeEmail(address)).toBe(true)
  })

  it.each(['test@te', 'test@', '@example.com', 'no-at-sign', 'two@@example.com', 'a b@c.com', ''])(
    'rejects %s',
    (address) => {
      expect(auth.looksLikeEmail(address)).toBe(false)
    }
  )

  it('ignores surrounding whitespace, as the server does', () => {
    expect(auth.looksLikeEmail('  you@example.com  ')).toBe(true)
  })

  it('is what gates the submit, not checkValidity alone', () => {
    const signin = readFileSync(join(staticDir, 'signin.js'), 'utf8')
    expect(signin).toContain('looksLikeEmail(email.value)')
    expect(signin).toContain('field.checkValidity() && looksLikeEmail(field.value)')
  })
})

describe('the mark inside a field', () => {
  const signin = readFileSync(join(staticDir, 'signin.js'), 'utf8')
  const css = readFileSync(join(staticDir, 'screens.css'), 'utf8')

  it.each([
    'This is a valid email address.',
    'This is not a valid email address.',
    'The passwords match.',
    'The passwords do not match.',
  ])('says "%s" on hover', (text) => {
    expect(signin).toContain(text)
  })

  it('answers on every keystroke, with nothing waiting for blur', () => {
    expect(signin).toContain("for (const event of ['input', 'change'])")
    expect(signin, 'no mark may be gated on losing focus').not.toMatch(
      /addEventListener\('blur', \(\) => mark/
    )
  })

  it('paints once at wiring time, for a field the browser autofilled', () => {
    expect(signin).toMatch(/^\s+markEmail\(field\)$/m)
    expect(signin).toMatch(/^\s+markMatch\(\)$/m)
  })

  it('can be hovered at all, and does not eat the click', () => {
    expect(css).not.toMatch(/\.auth__status \{[^}]*pointer-events:\s*none/s)
    expect(signin).toContain("mark.parentElement.querySelector('input')?.focus()")
  })
})

describe('the shared sign-out', () => {
  it('can clear the history everywhere the modal appears', () => {
    for (const page of readdirSync(staticDir).filter((f) => f.endsWith('.html'))) {
      const source = readFileSync(join(staticDir, page), 'utf8')
      if (!source.includes('shell.js')) continue
      expect(source, `${page} shows the sign-out modal but never loads history.js`).toContain(
        'history.js'
      )
    }
  })

  it('does not add a document listener per render', () => {
    const shell = readFileSync(join(staticDir, 'shell.js'), 'utf8').replace(/\r\n/g, '\n')
    const start = shell.indexOf('function wireAccountMenu')
    const wiring = shell.slice(start, shell.indexOf('\n}\n', start))
    expect(start, 'wireAccountMenu has been renamed').toBeGreaterThan(-1)
    expect(wiring).not.toContain('document.addEventListener')
  })
})

describe('a page script hangs nothing that outlives its page', () => {
  it.each([
    'send-page.js',
    'convert.js',
    'history-page.js',
    'waiting.js',
    'settings.js',
    'signin.js',
  ])('%s', (file) => {
    const source = readFileSync(join(staticDir, file), 'utf8')
    expect(
      [...source.matchAll(/(?:document|window)\.addEventListener\(/g)].map((m) => m[0]),
      'use page.on(target, …)'
    ).toEqual([])
    expect(
      [...source.matchAll(/(?<![\w.])setInterval\(/g)].map((m) => m[0]),
      'use page.every(ms, …)'
    ).toEqual([])
    expect(
      [...source.matchAll(/(?<![\w.])setTimeout\(/g)].map((m) => m[0]),
      'use page.after(ms, …)'
    ).toEqual([])
    expect(
      [...source.matchAll(/(?<![\w.])requestAnimationFrame\(/g)].map((m) => m[0]),
      'use page.frame(…)'
    ).toEqual([])
  })
})

describe('the confirmation state is on the page', () => {
  const settings = readFileSync(join(staticDir, 'settings.js'), 'utf8')
  const markup = readFileSync(join(staticDir, 'settings.html'), 'utf8')

  it('draws both states, and starts with neither showing', () => {
    for (const id of ['emailUnconfirmed', 'emailConfirmed']) {
      expect(markup, id).toMatch(new RegExp(`id="${id}"[^>]*hidden`))
    }
  })

  it('decides from the server, not from the query string', () => {
    expect(settings).toContain('state.user?.emailVerified === true')
  })

  it('gives the resend endpoint its first caller', () => {
    expect(settings).toContain("postJson('/auth/verify/resend'")
  })

  it('says why the endpoint button is off, without calling it unbacked', () => {
    expect(settings).toMatch(/generate\.disabled = !settled/)
    expect(markup).not.toMatch(/id="koboGenerate"[^>]*data-unbacked/)
  })

  it('does not ask for a confirmation the server cannot send', () => {
    expect(settings, 'the page reads whether asking is even possible').toContain(
      'state.verificationNeeded'
    )
    expect(settings, 'and treats unasked as settled').toMatch(/confirmed \|\| !asked/)
  })

  it('keeps the marker through a sign-in it forces', () => {
    expect(settings).toContain('window.location.search + window.location.hash')
  })
})

describe('what the send request carries', () => {
  it('sends an explicit off for every fix rather than omitting it', () => {
    expect(sendPageJs).toMatch(/body\.append\(id,\s*on\s*\?\s*'on'\s*:\s*'off'\)/)
  })

  it('names all three fixes, so none of them can silently stop being sent', () => {
    const listed = /for \(const id of \[([^\]]+)\]\)/.exec(sendPageJs)?.[1] ?? ''
    for (const id of ['layoutFix', 'pdfcropmargins', 'transliteration']) {
      expect(listed, id).toContain(id)
    }
  })

  it('offers exactly the four destinations, Kobo first', () => {
    const html = readFileSync(join(staticDir, 'send.html'), 'utf8')
    const values = [...html.matchAll(/data-target="([^"]+)"/g)].map((m) => m[1])
    expect(values).toEqual(['kobo', 'kindle', 'other', 'none'])
  })

  it('maps every destination onto a target the server accepts', () => {
    const html = readFileSync(join(staticDir, 'send.html'), 'utf8')
    const accepted = ['auto', 'kobo', 'kindle', 'none']
    const sent = (t: string) => (t === 'other' ? 'none' : t)
    for (const m of html.matchAll(/data-target="([^"]+)"/g)) {
      expect(accepted, `${m[1]} maps outside the server's targets`).toContain(sent(m[1]!))
    }
    expect(sendPageJs, 'other must be rewritten before it is sent').toMatch(
      /target === 'other' \? 'none' : target/
    )
  })

  it('sends the chosen output format alongside the target', () => {
    expect(sendPageJs).toMatch(/body\.append\('format', state\.format\)/)
  })
})
