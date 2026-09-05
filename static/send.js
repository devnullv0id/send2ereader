'use strict'

const SendLogic = (() => {
  const say = (text, params) =>
    typeof t === 'function'
      ? t(text, params)
      : String(text).replace(/\{(\w+)\}/g, (whole, name) =>
          !params || params[name] === undefined ? whole : String(params[name])
        )

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
      if (ext === 'epub' && tools.kepubify) return { format: 'kepub', label: say('Kobo EPUB'), via: ['kepubify'] }
      if (epubish && ext !== 'epub' && tools.calibre) {
        return { format: 'kepub', label: say('Kobo EPUB'), via: tools.kepubify ? ['calibre', 'kepubify'] : ['calibre'] }
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
        label: say('Fix layout'),
        description: say(
          'Repairs full-page images that get clipped and covers that get stretched, on Kobo, Tolino and PocketBook.'
        ),
        applies: (ext === 'epub' || ext === 'kepub' || ext === 'kfx') && epubOut,
        available: tools.layoutFix,
        why:
          ext === 'kfx'
            ? say('APPLIES TO THE EPUB WE MAKE FROM IT')
            : say('APPLIES TO EPUB ON {device}', { device: target === 'tolino' ? 'TOLINO' : 'KOBO' }),
        reason:
          target === 'kindle'
            ? say("Kindles don't have this bug.")
            : say('Only for EPUB sent to Kobo, Tolino or PocketBook.'),
      },
      {
        id: 'pdfcropmargins',
        label: say('Crop PDF margins'),
        description: say('Trims whitespace so the page fills a small screen.'),
        applies: ext === 'pdf',
        available: tools.pdfcropmargins,
        why: say('APPLIES TO PDF'),
        reason: say('Only for PDFs.'),
      },
      {
        id: 'transliteration',
        label: say('Transliterate filename'),
        description: say('Rewrite accented and non-Latin characters as ASCII.'),
        applies: nonAscii || target === 'kindle',
        available: true,
        why: nonAscii
          ? say('THIS FILENAME HAS NON-ASCII CHARACTERS')
          : say('THE KINDLE BROWSER STRIPS SPECIAL CHARACTERS'),
        reason: say('This filename is already plain ASCII.'),
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
            description: say(
              'Trims whitespace before anything else runs, so the text fills a small screen.'
            ),
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
      return say('Forces the Kobo path: EPUB becomes a Kobo EPUB, everything else is sent unchanged.')
    }
    if (chosen === 'kindle') {
      return say(
        'Forces the Kindle path: EPUB, CBZ, CBR, TXT and HTML become AZW3. Filenames lose special characters.'
      )
    }
    if (chosen === 'none') return say('Sends the bytes exactly as they are. Your device may not open them.')

    const short = label(detected)
    return short
      ? say("Auto uses whichever device generated the key — right now that's a {device}.", { device: short })
      : say('Auto uses whichever device generated the key.')
  }

  function label(target) {
    return { kobo: 'Kobo', kindle: 'Kindle', tolino: 'Tolino' }[target] || ''
  }

  function keptLine(kept, where) {
    if (!kept || typeof kept !== 'object') return null
    if (kept.kept) return { full: false, text: say('A copy is in your History.') }
    if (kept.reason !== 'user-full' && kept.reason !== 'server-full') return null

    const whose =
      kept.reason === 'server-full'
        ? say("This server's library is full")
        : say('Your library is full')
    const fate =
      where === 'send'
        ? say('The book is on its way to your eReader; nothing stays here.')
        : say('This download is the only copy — it goes as soon as you take it.')
    return { full: true, text: say('{whose}, so no copy was kept. {fate}', { whose, fate }) }
  }

  function postWithProgress(url, body, options) {
    const { headers = {}, onUpload } = options || {}
    const xhr = new XMLHttpRequest()

    const done = new Promise((resolve) => {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onUpload) onUpload(e.loaded / e.total)
      })
      xhr.upload.addEventListener('load', () => onUpload?.(1))
      xhr.addEventListener('load', () => {
        let data = null
        try {
          data = JSON.parse(xhr.responseText)
        } catch {
          data = null
        }
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data })
      })
      xhr.addEventListener('error', () => resolve({ ok: false, data: null, network: true }))
      xhr.addEventListener('abort', () => resolve({ ok: false, data: null, aborted: true }))
    })

    xhr.open('POST', url)
    xhr.withCredentials = true
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    xhr.send(body)

    return { done, abort: () => xhr.abort() }
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
    postWithProgress,
  }
})()

if (typeof module !== 'undefined') module.exports = { SendLogic }
