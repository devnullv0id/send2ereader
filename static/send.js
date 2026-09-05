'use strict'

const SendLogic = (() => {
  const ACCEPTED = ['epub', 'pdf', 'mobi', 'azw3', 'kfx', 'kfx-zip', 'kepub', 'cbz', 'cbr', 'txt', 'htmlz']

  function extensionOf(filename) {
    const lower = String(filename || '').toLowerCase()
    if (lower.endsWith('.kepub.epub')) return 'kepub'
    const dot = lower.lastIndexOf('.')
    return dot < 0 ? '' : lower.slice(dot + 1)
  }

  function isAccepted(filename) {
    return ACCEPTED.includes(extensionOf(filename))
  }

  function outcome(ext, target, tools, kindleFormat) {
    const epubish = ext === 'epub' || ext === 'kfx' || ext === 'kfx-zip'

    if (target === 'kobo') {
      if (ext === 'epub' && tools.kepubify) return { format: 'kepub', label: 'Kobo EPUB', via: ['kepubify'] }
      if (epubish && ext !== 'epub' && tools.calibre) {
        return { format: 'kepub', label: 'Kobo EPUB', via: tools.kepubify ? ['calibre', 'kepubify'] : ['calibre'] }
      }
      return { format: ext, label: ext.toUpperCase(), via: [] }
    }

    if (target === 'kindle') {
      const native = ext === 'mobi' || ext === 'azw3' || ext === 'kfx' || ext === 'pdf'
      const convertible = ['epub', 'kepub', 'cbz', 'cbr', 'txt', 'html', 'htm', 'htmlz'].includes(ext)
      if (!native && convertible && tools.calibre) {
        return { format: kindleFormat, label: kindleFormat.toUpperCase(), via: ['calibre'] }
      }
      return { format: ext, label: ext.toUpperCase(), via: [] }
    }

    return { format: ext, label: ext.toUpperCase(), via: [] }
  }

  function fixes(ext, target, tools, filename) {
    const epubOut = target === 'kobo' || target === 'none' || target === 'tolino'
    const nonAscii = /[^ -~]/.test(String(filename || ''))

    return [
      {
        id: 'layoutFix',
        label: 'Fix layout',
        description:
          'Repairs full-page images that get clipped and covers that get stretched, on Kobo, Tolino and PocketBook.',
        applies: (ext === 'epub' || ext === 'kepub' || ext === 'kfx') && epubOut,
        available: tools.layoutFix,
        why:
          ext === 'kfx'
            ? 'APPLIES TO THE EPUB WE MAKE FROM IT'
            : `APPLIES TO EPUB ON ${target === 'tolino' ? 'TOLINO' : 'KOBO'}`,
        reason:
          target === 'kindle'
            ? "Kindles don't have this bug."
            : 'Only for EPUB sent to Kobo, Tolino or PocketBook.',
      },
      {
        id: 'pdfcropmargins',
        label: 'Crop PDF margins',
        description: 'Trims whitespace so the page fills a small screen.',
        applies: ext === 'pdf',
        available: tools.pdfcropmargins,
        why: 'APPLIES TO PDF',
        reason: 'Only for PDFs.',
      },
      {
        id: 'transliteration',
        label: 'Transliterate filename',
        description: 'Rewrite accented and non-Latin characters as ASCII.',
        applies: nonAscii || target === 'kindle',
        available: true,
        why: nonAscii
          ? 'THIS FILENAME HAS NON-ASCII CHARACTERS'
          : 'THE KINDLE BROWSER STRIPS SPECIAL CHARACTERS',
        reason: 'This filename is already plain ASCII.',
      },
    ]
  }

  const LAYOUT_FIX_TARGETS = ['epub', 'kepub', 'azw3']

  function convertFixes(ext, out, tools, filename) {
    const layoutApplies = LAYOUT_FIX_TARGETS.includes(out)
    const cropApplies = out === 'pdf'

    return fixes(ext, 'none', tools, filename)
      .filter((fix) => {
        if (fix.id === 'layoutFix') return layoutApplies
        if (fix.id === 'pdfcropmargins') return cropApplies
        return true
      })
      .map((fix) => {
        if (fix.id === 'layoutFix') {
          return { ...fix, applies: true, why: '' }
        }
        if (fix.id === 'pdfcropmargins') {
          return {
            ...fix,
            applies: true,
            why: '',
            description:
              'Trims whitespace before anything else runs, so the text fills a small screen.',
          }
        }
        if (fix.id === 'transliteration') {
          return { ...fix, why: '' }
        }
        return fix
      })
  }

  function targetNote(detected, chosen) {
    if (chosen === 'kobo') {
      return 'Forces the Kobo path: EPUB becomes a Kobo EPUB, everything else is sent unchanged.'
    }
    if (chosen === 'kindle') {
      return 'Forces the Kindle path: EPUB, CBZ, CBR, TXT and HTML become AZW3. Filenames lose special characters.'
    }
    if (chosen === 'none') return 'Sends the bytes exactly as they are. Your device may not open them.'

    const short = label(detected)
    return short
      ? `Auto uses whichever device generated the key — right now that's a ${short}.`
      : 'Auto uses whichever device generated the key.'
  }

  function label(target) {
    return { kobo: 'Kobo', kindle: 'Kindle', tolino: 'Tolino' }[target] || ''
  }

  function keptLine(kept, where) {
    if (!kept || typeof kept !== 'object') return null
    if (kept.kept) return { full: false, text: 'A copy is in your History.' }
    if (kept.reason !== 'user-full' && kept.reason !== 'server-full') return null

    const whose =
      kept.reason === 'server-full' ? "This server's library is full" : 'Your library is full'
    const fate =
      where === 'send'
        ? 'The book is on its way to your eReader; nothing stays here.'
        : 'This download is the only copy — it goes as soon as you take it.'
    return { full: true, text: `${whose}, so no copy was kept. ${fate}` }
  }

  return {
    ACCEPTED,
    extensionOf,
    isAccepted,
    outcome,
    fixes,
    convertFixes,
    targetNote,
    label,
    keptLine,
  }
})()

if (typeof module !== 'undefined') module.exports = { SendLogic }
