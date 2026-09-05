import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { config, proxyTrust, safeNext } from '../src/config.js'
import { type ConversionPlan, planConversion, type ToolAvailability } from '../src/convert/index.js'
import { detectDevice, isEreader } from '../src/device.js'
import {
  decodeOriginalName,
  formatFromName,
  kindleSafeName,
  transliterateName,
  withExtension,
} from '../src/files.js'
import { readOptions } from '../src/routes/upload.js'
import { type ConversionOptions, resolveTarget } from '../src/types.js'

const allTools: ToolAvailability = {
  kepubify: true,
  calibre: true,
  pdfcropmargins: true,
  kfxInput: true,
  kfxOutput: false,
  layoutFix: true,
}
const noKepubify: ToolAvailability = { ...allTools, kepubify: false }
const noTools: ToolAvailability = {
  kepubify: false,
  calibre: false,
  pdfcropmargins: false,
  kfxInput: false,
  kfxOutput: false,
  layoutFix: false,
}

const defaults: ConversionOptions = {
  target: 'auto',
  kindleFormat: 'azw3',
  pdfcropmargins: false,
  transliteration: false,
  layoutFix: true,
}
const noFix: ConversionOptions = { ...defaults, layoutFix: false }

describe('detectDevice', () => {
  it.each([
    ['Mozilla/5.0 (Linux; U; Kobo Touch)', 'kobo'],
    ['Mozilla/5.0 (X11; U; Linux armv7l) Kindle/3.0', 'kindle'],
    ['Mozilla/5.0 (Linux; Android) Silk/104', 'kindle'],
    ['Mozilla/5.0 tolino epos 3', 'tolino'],
    ['Mozilla/5.0 (Linux) eReader', 'tolino'],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/120', 'generic'],
    ['', 'generic'],
  ])('classifies %s', (agent, expected) => {
    expect(detectDevice(agent)).toBe(expected)
  })

  it('treats a missing user-agent as generic', () => {
    expect(detectDevice(undefined)).toBe('generic')
    expect(isEreader(undefined)).toBe(false)
  })
})

describe('formatFromName', () => {
  it.each([
    ['book.epub', 'epub'],
    ['book.kepub.epub', 'kepub'],
    ['BOOK.EPUB', 'epub'],
    ['book.mobi', 'mobi'],
    ['book.azw3', 'azw3'],
    ['book.kfx', 'kfx'],
    ['BOOK.KFX', 'kfx'],
    ['book.kfx-zip', 'kfxZip'],
    ['comic.cbz', 'cbz'],
    ['comic.cbr', 'cbr'],
    ['notes.txt', 'txt'],
    ['page.htm', null],
    ['page.html', null],
    ['book.htmlz', 'htmlz'],
    ['scan.pdf', 'pdf'],
  ])('maps %s', (name, expected) => {
    expect(formatFromName(name)).toBe(expected)
  })

  it('rejects unknown extensions', () => {
    expect(formatFromName('payload.exe')).toBeNull()
    expect(formatFromName('noextension')).toBeNull()
  })
})

const steps = (plan: ConversionPlan): string[] => plan.steps.map((s) => s.converter)

describe('resolveTarget', () => {
  it.each([
    ['kobo', 'kobo'],
    ['kindle', 'kindle'],
    ['tolino', 'none'],
    ['generic', 'none'],
  ] as const)('auto on a %s device resolves to %s', (device, expected) => {
    expect(resolveTarget('auto', device)).toBe(expected)
  })

  it('lets an explicit choice override detection', () => {
    expect(resolveTarget('kindle', 'kobo')).toBe('kindle')
    expect(resolveTarget('kobo', 'kindle')).toBe('kobo')
    expect(resolveTarget('none', 'kobo')).toBe('none')
  })
})

describe('planConversion', () => {
  it('kepubifies EPUB for a Kobo target', () => {
    const plan = planConversion('kobo', 'epub', noFix, allTools)
    expect(steps(plan)).toEqual(['kepubify'])
    expect(plan.targetFormat).toBe('kepub')
  })

  it('leaves an existing KEPUB alone', () => {
    expect(steps(planConversion('kobo', 'kepub', noFix, allTools))).toEqual([])
  })

  it('falls back to pass-through when kepubify is missing', () => {
    const plan = planConversion('kobo', 'epub', noFix, noTools)
    expect(steps(plan)).toEqual([])
    expect(plan.targetFormat).toBe('epub')
  })

  it.each(['epub', 'kepub', 'cbz', 'cbr', 'txt', 'html'] as const)(
    'converts %s to AZW3 for a Kindle target',
    (format) => {
      const plan = planConversion('kindle', format, noFix, allTools)
      expect(steps(plan)).toEqual(['calibre'])
      expect(plan.targetFormat).toBe('azw3')
    }
  )

  it('honours the legacy MOBI choice', () => {
    const opts: ConversionOptions = { ...noFix, kindleFormat: 'mobi' }
    expect(planConversion('kindle', 'epub', opts, allTools).targetFormat).toBe('mobi')
  })

  it.each(['mobi', 'azw3'] as const)('passes %s through to a Kindle untouched', (format) => {
    expect(steps(planConversion('kindle', format, noFix, allTools))).toEqual([])
  })

  it('never produces a Kobo format for a Kindle target, or the reverse', () => {
    expect(planConversion('kindle', 'epub', defaults, allTools).targetFormat).not.toBe('kepub')
    expect(planConversion('kobo', 'epub', defaults, allTools).targetFormat).not.toBe('azw3')
    expect(steps(planConversion('kindle', 'epub', defaults, allTools))).not.toContain('kepubify')
  })

  it('converts nothing when the target is none', () => {
    for (const format of ['epub', 'kepub', 'cbz', 'txt', 'html', 'mobi'] as const) {
      const plan = planConversion('none', format, noFix, allTools)
      expect(steps(plan)).toEqual([])
      expect(plan.targetFormat).toBe(format)
    }
  })

  it('crops PDFs only when asked, whatever the target', () => {
    const opts = { ...defaults, pdfcropmargins: true }
    expect(steps(planConversion('kindle', 'pdf', opts, allTools))).toEqual(['pdfcropmargins'])
    expect(steps(planConversion('kobo', 'pdf', opts, allTools))).toEqual(['pdfcropmargins'])
    expect(steps(planConversion('none', 'pdf', opts, allTools))).toEqual(['pdfcropmargins'])
    expect(steps(planConversion('kobo', 'pdf', defaults, allTools))).toEqual([])
    expect(steps(planConversion('kobo', 'pdf', opts, noTools))).toEqual([])
  })
})

describe('planConversion — EPUB layout fix', () => {
  it('repairs the EPUB before kepubify packages it', () => {
    expect(steps(planConversion('kobo', 'epub', defaults, allTools))).toEqual([
      'layoutfix',
      'kepubify',
    ])
  })

  it('runs on a plain EPUB with no other conversion', () => {
    expect(steps(planConversion('none', 'epub', defaults, allTools))).toEqual(['layoutfix'])
    expect(steps(planConversion('kobo', 'epub', defaults, noKepubify))).toEqual(['layoutfix'])
  })

  it('runs on an existing KEPUB', () => {
    expect(steps(planConversion('kobo', 'kepub', defaults, allTools))).toEqual(['layoutfix'])
  })

  it.each(['txt', 'html', 'cbz', 'cbr'] as const)(
    'repairs the EPUB produced from %s for a Kobo',
    (format) => {
      expect(steps(planConversion('kobo', format, defaults, allTools))).toEqual([])
    }
  )

  it('is skipped for AZW3 output, which is not a zip the fixer can open', () => {
    expect(steps(planConversion('kindle', 'epub', defaults, allTools))).toEqual(['calibre'])
    expect(steps(planConversion('kindle', 'cbz', defaults, allTools))).toEqual(['calibre'])
  })

  it('is skipped for MOBI output, which the fix does not cover', () => {
    const toMobi = { ...defaults, kindleFormat: 'mobi' as const }
    expect(steps(planConversion('kindle', 'epub', toMobi, allTools))).toEqual(['calibre'])
  })

  it('is skipped for PDFs', () => {
    expect(steps(planConversion('kobo', 'pdf', defaults, allTools))).toEqual([])
  })

  it('is skipped when the option is off', () => {
    expect(steps(planConversion('kobo', 'epub', noFix, allTools))).toEqual(['kepubify'])
  })

  it('is skipped when the engine is not installed', () => {
    const tools = { ...allTools, layoutFix: false }
    expect(steps(planConversion('kobo', 'epub', defaults, tools))).toEqual(['kepubify'])
  })

  it('is marked optional, so a failure cannot fail the upload', () => {
    const plan = planConversion('kobo', 'epub', defaults, allTools)
    const fix = plan.steps.find((s) => s.converter === 'layoutfix')
    expect(fix?.optional).toBe(true)
    expect(plan.steps.find((s) => s.converter === 'kepubify')?.optional).toBeFalsy()
  })
})

describe('planConversion — KFX', () => {
  it('sends a plain KFX to a Kindle untouched', () => {
    const plan = planConversion('kindle', 'kfx', defaults, allTools)
    expect(steps(plan)).toEqual([])
    expect(plan.targetFormat).toBe('kfx')
  })

  it('unwraps a .kfx-zip for a Kindle, since no device can open that container', () => {
    const plan = planConversion('kindle', 'kfxZip', defaults, allTools)
    expect(steps(plan)).toEqual(['calibre'])
    expect(plan.targetFormat).toBe('azw3')
  })

  it.each(['kfx', 'kfxZip'] as const)(
    'converts %s to EPUB for a Kobo and repairs the result',
    (format) => {
      const plan = planConversion('kobo', format, defaults, allTools)
      expect(steps(plan)).toEqual(['calibre', 'layoutfix', 'kepubify'])
      expect(plan.targetFormat).toBe('kepub')
    }
  )

  it.each(['kfx', 'kfxZip'] as const)('repairs %s converted for a Tolino', (format) => {
    const plan = planConversion('none', format, defaults, allTools)
    expect(steps(plan)).toEqual([])
    expect(plan.targetFormat).toBe(format)
  })

  it.each(['kfx', 'kfxZip'] as const)(
    'passes %s through when the KFX Input plugin is absent',
    (format) => {
      const tools = { ...allTools, kfxInput: false }
      const plan = planConversion('kobo', format, defaults, tools)
      expect(steps(plan)).toEqual([])
      expect(plan.targetFormat).toBe(format)
      expect(steps(planConversion('kindle', format, defaults, tools))).toEqual([])
    }
  )
})

describe('readOptions', () => {
  const parse = (pairs: [string, string][]) => readOptions(new Map(pairs))

  it('defaults the layout fix on when the field is absent', () => {
    expect(parse([]).layoutFix).toBe(true)
  })

  it('turns the layout fix off when the form says so', () => {
    expect(parse([['layoutFix', 'off']]).layoutFix).toBe(false)
    expect(parse([['layoutFix', 'false']]).layoutFix).toBe(false)
    expect(parse([['layoutFix', '']]).layoutFix).toBe(false)
  })

  it('keeps the layout fix on when the checkbox is ticked', () => {
    expect(parse([['layoutFix', 'on']]).layoutFix).toBe(true)
  })

  it('defaults the opt-in extras off', () => {
    expect(parse([]).pdfcropmargins).toBe(false)
    expect(parse([]).transliteration).toBe(false)
  })

  it('falls back to auto for a missing or bogus target', () => {
    expect(parse([]).target).toBe('auto')
    expect(parse([['target', 'nonsense']]).target).toBe('auto')
    expect(parse([['target', 'kindle']]).target).toBe('kindle')
  })

  it('only accepts mobi as an alternative Kindle format', () => {
    expect(parse([]).kindleFormat).toBe('azw3')
    expect(parse([['kindleFormat', 'mobi']]).kindleFormat).toBe('mobi')
    expect(parse([['kindleFormat', 'kfx']]).kindleFormat).toBe('azw3')
  })
})

describe('filename handling', () => {
  it('re-decodes latin1-mangled UTF-8 names', () => {
    const mangled = Buffer.from('Ärlig Bok.epub', 'utf8').toString('latin1')
    expect(decodeOriginalName(mangled)).toBe('Ärlig Bok.epub')
  })

  it('leaves already-correct names alone', () => {
    expect(decodeOriginalName('Plain Book.epub')).toBe('Plain Book.epub')
  })

  it('strips path traversal', () => {
    expect(decodeOriginalName('../../etc/passwd.epub')).not.toContain('/')
    expect(decodeOriginalName('..\\..\\win.epub')).not.toContain('\\')
  })

  it('transliterates the stem but keeps the extension', () => {
    expect(transliterateName('Æblegrød.epub')).toBe('AEblegrod.epub')
    expect(transliterateName('日本語.kepub.epub')).toMatch(/\.epub$/)
  })

  it('scrubs names for the Kindle browser', () => {
    expect(kindleSafeName('Ärlig Bok & Co.epub')).toBe('_rlig_Bok___Co.epub')
  })

  it('swaps extensions, collapsing .kepub.epub', () => {
    expect(withExtension('book.epub', 'kepub')).toBe('book.kepub.epub')
    expect(withExtension('book.kepub.epub', 'epub')).toBe('book.epub')
    expect(withExtension('book.epub', 'azw3')).toBe('book.azw3')
    expect(withExtension('my.book.v2.epub', 'mobi')).toBe('my.book.v2.mobi')
    expect(withExtension('book.kfx-zip', 'epub')).toBe('book.epub')
    expect(withExtension('book.kfx', 'azw3')).toBe('book.azw3')
  })
})

describe('safeNext', () => {
  const BACKSLASH = String.fromCharCode(92)

  const hostile: [string, unknown][] = [
    ['a protocol-relative host', '//evil.example.com'],
    ['a backslash standing in for a slash', `/${BACKSLASH}evil.example.com`],
    ['both slashes backwards', `${BACKSLASH}${BACKSLASH}evil.example.com`],
    ['a backslash after two slashes', `//${BACKSLASH}evil.example.com`],
    ['an absolute url', 'https://evil.example.com/steal'],
    ['a scheme with no host', 'javascript:alert(1)'],
    ['nothing at all', ''],
    ['a value that is not a string', 42],
  ]

  const ourOrigin = new URL(config.publicUrl).origin

  for (const [what, value] of hostile) {
    it(`cannot be steered off this origin by ${what}`, () => {
      const out = safeNext(value)

      expect(out.startsWith('/'), `${JSON.stringify(out)} is a path`).toBe(true)
      expect(new URL(out, config.publicUrl).origin, 'lands back on us').toBe(ourOrigin)
      expect(/^[/\\]{2}/.test(out), 'never begins with an authority').toBe(false)
    })
  }

  it('keeps a path on this site, with its query and hash', () => {
    expect(safeNext('/settings#profile')).toBe('/settings#profile')
    expect(safeNext('/history?page=2')).toBe('/history?page=2')
  })

  it('takes the caller’s fallback when it refuses outright', () => {
    expect(safeNext('//evil.example.com', '/account')).toBe('/account')
    expect(safeNext('', '/account')).toBe('/account')
  })

  it('reduces a same-origin absolute url to its path', () => {
    expect(safeNext(`${config.publicUrl}/settings`)).toBe('/settings')
  })
})

describe('the copy of safeNext that ships to the browser', () => {
  const source = readFileSync(join(process.cwd(), 'static', 'auth.js'), 'utf8')
  const origin = 'https://books.example'
  const BACKSLASH = String.fromCharCode(92)

  const run = (next: string): string => {
    const location = { search: `?next=${encodeURIComponent(next)}`, origin }
    return new Function('window', `${source}; return safeNext`)({ location, URL })('/') as string
  }

  it('hands window.location.href nothing that can leave this origin', () => {
    const tries = [
      `/${BACKSLASH}evil.example.com`,
      '//evil.example.com',
      'https://evil.example.com',
    ]
    for (const next of tries) {
      const out = run(next)
      expect(new URL(out, origin).origin, `${next} stayed put`).toBe(origin)
      expect(/^[/\\]{2}/.test(out)).toBe(false)
    }
  })

  it('still lets a real destination through', () => {
    expect(run('/settings#profile')).toBe('/settings#profile')
  })
})

describe('what TRUST_PROXY is allowed to mean', () => {
  it('still reads the words it always did', () => {
    for (const yes of ['true', 'yes', 'on', '1', 'TRUE', ' true ']) {
      expect(proxyTrust(yes, false), yes).toBe(true)
    }
    for (const no of ['false', 'no', 'off', '0', 'none', 'FALSE']) {
      expect(proxyTrust(no, true), no).toBe(false)
    }
  })

  it('falls back when it is unset or empty', () => {
    expect(proxyTrust(undefined, false)).toBe(false)
    expect(proxyTrust('', true)).toBe(true)
  })

  it('hands anything else to fastify verbatim, which is the point', () => {
    expect(proxyTrust('192.168.20.2', false)).toBe('192.168.20.2')
    expect(proxyTrust('10.0.0.0/8', false)).toBe('10.0.0.0/8')
    expect(proxyTrust('loopback', false)).toBe('loopback')
    expect(proxyTrust(' 192.168.20.2, 10.0.0.1 ', false)).toBe('192.168.20.2, 10.0.0.1')
  })

  it('never turns an address into a bare true, which would trust everybody', () => {
    expect(proxyTrust('192.168.20.2', false)).not.toBe(true)
  })
})
