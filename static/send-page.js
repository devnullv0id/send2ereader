'use strict'

onPage('send', (page) => {
  const $ = (id) => document.getElementById(id)

  function spell(seconds) {
    if (seconds >= 60 && seconds % 60 === 0) {
      const minutes = seconds / 60
      return minutes === 1 ? '1 minute' : `${minutes} minutes`
    }
    return `${seconds} seconds`
  }

  function deadlineFrom(expiresInMs) {
    return Date.now() + (expiresInMs ?? 0)
  }

  function clock(deadline) {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  }

  const SYNC_STATUS = {
    ok: {
      className: 'is-ok',
      text: () => `HELD ${queueHours()} OR UNTIL DOWNLOADED`,
      menuText: (device) => `LAST SYNCED ${ago(device.lastSeenAt)}`,
    },
    failed: {
      className: 'is-error',
      text: 'LAST SYNC FAILED — IT MAY NOT ARRIVE',
      menuText: (device) => `SYNC FAILED ${ago(device.lastSeenAt)}`,
    },
    never: {
      className: 'is-warn',
      text: 'NEVER SYNCED — CONNECT THE DEVICE FIRST',
      menuText: () => 'NEVER SYNCED',
    },
    syncing: {
      className: 'is-syncing',
      text: 'SYNCING NOW — IT WILL PICK THIS UP',
      menuText: () => 'SYNCING NOW',
    },
  }

  const PREFS_KEY = 's2e_prefs_v1'
  const PREF_DEFAULTS = {
    kindleFormat: 'mobi',
    koboFormat: 'kepub',
    layoutFix: true,
    transliteration: false,
    lfFixImages: true,
    lfPreserveAnchors: true,
    lfFixCaptioned: false,
    lfFixMultiImage: false,
    lfFixCovers: true,
    lfDarkCover: true,
    lfMinWidthPercent: 80,
    lfCoverColor: '#000000',
  }

  const LAYOUT_FIELDS = {
    lfFixImages: 'layoutFixImages',
    lfPreserveAnchors: 'layoutPreserveAnchors',
    lfFixCaptioned: 'layoutFixCaptioned',
    lfFixMultiImage: 'layoutFixMultiImage',
    lfFixCovers: 'layoutFixCovers',
    lfDarkCover: 'layoutDarkCover',
    lfMinWidthPercent: 'layoutMinWidthPercent',
    lfCoverColor: 'layoutCoverColor',
  }

  function appendLayoutSettings(body) {
    for (const [pref, field] of Object.entries(LAYOUT_FIELDS)) {
      const value = state.prefs[pref]
      if (value === PREF_DEFAULTS[pref]) continue
      body.append(field, typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value))
    }
  }

  function readPrefs() {
    try {
      return { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }
    } catch {
      return { ...PREF_DEFAULTS }
    }
  }

  const state = {
    prefs: readPrefs(),
    method: 'key',
    key: '',
    checking: false,
    paired: null,
    file: null,
    target: 'none',
    format: '',
    targets: [],
    devices: [],
    deviceId: '',
    tools: { kepubify: false, calibre: false, pdfcropmargins: false, layoutFix: false },
    maxFileSize: 0,
    chosen: {},
    phase: 'idle',
    opened: 0,
    openOption: '',
    signedIn: false,
    verified: false,
    queueTtl: 0,
    menuOpen: false,
  }

  let inFlight = null
  page.leave(() => inFlight?.abort())

  let verdict = null

  function askVerdict() {
    show($('cancelModal'), true)
    $('cancelKeep').focus()
    if (!verdict) verdict = { asked: true, settled: null, waiters: [] }
    verdict.asked = true
  }

  function decide(choice) {
    show($('cancelModal'), false)
    if (!verdict) verdict = { asked: true, settled: null, waiters: [] }
    verdict.settled = choice
    for (const resolve of verdict.waiters.splice(0)) resolve(choice)
  }

  function whenDecided() {
    if (!verdict?.asked) return Promise.resolve('deliver')
    if (verdict.settled) return Promise.resolve(verdict.settled)
    return new Promise((resolve) => verdict.waiters.push(resolve))
  }

  function size(bytes) {
    const mb = bytes / (1024 * 1024)
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
  }

  function show(el, visible) {
    if (el) el.hidden = !visible
  }

  function queueHours() {
    const hours = Math.round((state.queueTtl || 24 * 3600) / 3600)
    return hours === 1 ? '1 HOUR' : `${hours} HOURS`
  }

  function ago(iso) {
    const seconds = Math.floor((Date.now() - Date.parse(iso)) / 1000)
    if (!Number.isFinite(seconds) || seconds < 60) return 'JUST NOW'
    if (seconds < 3600) return `${Math.floor(seconds / 60)} MIN AGO`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} HR AGO`
    return `${Math.floor(seconds / 86400)} DAYS AGO`
  }

  function device() {
    return state.devices.find((d) => d.id === state.deviceId) || null
  }

  function ready() {
    return state.method === 'sync'
      ? Boolean(state.deviceId && state.file)
      : Boolean(state.paired && state.file)
  }

  function badge(el, done, current, mark) {
    el.className = `step__badge${done ? ' is-complete' : current ? ' is-current' : ''}`
    el.textContent = done ? '✓' : mark
  }

  function renderMethod() {
    for (const btn of document.querySelectorAll('.method')) {
      btn.classList.toggle('is-selected', btn.dataset.method === state.method)
    }

    const key = state.method === 'key'
    show($('keyBranch'), key && !state.paired)
    show($('pairedBranch'), key && Boolean(state.paired))
    show($('syncBranch'), !key)

    renderStep1()
  }

  const DEVICE_FORMATS = {
    kobo: [
      { format: 'kepub', label: 'KEPUB' },
      { format: 'epub', label: 'EPUB' },
    ],
    kindle: [
      { format: 'mobi', label: 'MOBI' },
      { format: 'azw3', label: 'AZW3' },
      { format: 'kfx', label: 'KFX' },
    ],
    other: [
      { format: 'epub', label: 'EPUB' },
      { format: 'pdf', label: 'PDF' },
    ],
    none: [],
  }

  const FORMAT_CAVEAT = {
    azw3: [
      [
        'The Kindle doesn’t display the cover for a downloaded AZW3 file. The cover is embedded in the file, but the device simply ignores it.',
      ],
      ['The same book in MOBI format displays the cover correctly.'],
    ],
  }

  function caveatOf(format) {
    return FORMAT_CAVEAT[format] || null
  }

  function caveatLine(format) {
    const paragraphs = caveatOf(format)
    return paragraphs ? paragraphs.flat().join(' ') : ''
  }

  const FORMAT_NOTE = {
    mobi: 'The oldest of the three Kindle formats, and the one whose cover the device actually shows.',
  }

  const FORMAT_BLOCKED = {
    kfx: 'The Kindle browser cannot download a KFX file.',
  }

  function askCaveat(item, paragraphs) {
    $('caveatTitle').textContent = `Send as ${item.label}?`
    $('caveatText').replaceChildren(
      ...paragraphs.map((lines) => {
        const p = document.createElement('p')
        p.className = 'modal__text'
        lines.forEach((line, at) => {
          if (at > 0) p.append(document.createElement('br'))
          p.append(document.createTextNode(line))
        })
        return p
      })
    )
    $('caveatConfirm').textContent = `Send as ${item.label}`
    const fallback = formatsFor().find((f) => f.format === state.format)
    $('caveatCancel').textContent = fallback ? `Keep ${fallback.label}` : 'Cancel'
    state.pendingFormat = item.format
    show($('caveatModal'), true)
    $('caveatCancel').focus()
  }

  function closeCaveat(accepted) {
    if (accepted && state.pendingFormat) {
      state.format = state.pendingFormat
      renderStep3()
    }
    state.pendingFormat = ''
    show($('caveatModal'), false)
  }

  function formatsFor() {
    return DEVICE_FORMATS[targetOf()] || []
  }

  function targetOf() {
    return state.method === 'sync' ? 'kobo' : state.target
  }

  function skipsFormat() {
    return targetOf() === 'none'
  }

  function passthroughFormat() {
    return Boolean(state.format) && Boolean(refusalFor(state.format))
  }

  function linkLost() {
    return state.method === 'key' && Boolean(state.paired) && !state.paired.connected
  }

  function recognised() {
    const device = state.method === 'sync' ? 'kobo' : state.paired?.device
    return device === 'kobo' || device === 'kindle'
  }

  function openStep() {
    if (state.opened) return state.opened
    if (!step1Done()) return 1
    if (!state.file) return 2
    if (!recognised()) return 3
    return 5
  }

  function renderRail() {
    const open = openStep()
    const done = [step1Done(), Boolean(state.file), ready(), ready(), ready()]
    for (const dot of document.querySelectorAll('.step-rail__dot')) {
      const n = Number(dot.dataset.step)
      const skipped = n === 4 && skipsFormat()
      const lost = n === 1 && linkLost()
      dot.classList.toggle('is-current', n === open)
      dot.classList.toggle('is-done', n !== open && !skipped && !lost && done[n - 1])
      dot.classList.toggle('is-lost', lost)
      dot.classList.toggle('is-skipped', skipped)
      dot.disabled = skipped
      dot.setAttribute('aria-selected', String(n === open))
    }
  }

  function goToStep(n) {
    let next = Math.min(5, Math.max(1, n))
    if (next === 4 && skipsFormat()) next = openStep() < 4 ? 5 : 3
    state.opened = next
    renderStep1()
    if (state.opened === 1) keyCells.focus()
  }

  function targetLabel() {
    return { kobo: 'Kobo', kindle: 'Kindle', other: 'Other devices', none: "Don't convert" }[
      targetOf()
    ]
  }

  function optionsSummary() {
    if (!ready()) return 'Waiting for a file'
    const on = offeredFixes()
      .filter((fix) => fix.applies && fix.available && chosen(fix.id))
      .map((fix) => fix.label)
    return on.length ? on.join(', ') : 'Nothing extra'
  }

  function warningTriangle() {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('class', 'warn-tri')

    const body = document.createElementNS(ns, 'path')
    body.setAttribute('d', 'M8 1.8 15.1 14.2H0.9z')
    body.setAttribute('fill', 'none')
    body.setAttribute('stroke', 'currentColor')
    body.setAttribute('stroke-width', '1.5')
    body.setAttribute('stroke-linejoin', 'round')

    const stem = document.createElementNS(ns, 'path')
    stem.setAttribute('d', 'M8 6.4v3.4')
    stem.setAttribute('stroke', 'currentColor')
    stem.setAttribute('stroke-width', '1.5')
    stem.setAttribute('stroke-linecap', 'round')

    const dot = document.createElementNS(ns, 'circle')
    dot.setAttribute('cx', '8')
    dot.setAttribute('cy', '12')
    dot.setAttribute('r', '0.95')
    dot.setAttribute('fill', 'currentColor')

    svg.append(body, stem, dot)
    return svg
  }

  function renderFormats() {
    const offered = formatsFor()
    const grid = $('formats')

    const usable = offered.filter((item) => !FORMAT_BLOCKED[item.format])
    if (!usable.some((item) => item.format === state.format)) {
      const wanted = { kindle: state.prefs.kindleFormat, kobo: state.prefs.koboFormat }[targetOf()]
      const preferred = usable.find((item) => item.format === wanted)
      state.format = (preferred || usable[0])?.format || ''
    }

    grid.replaceChildren(
      ...offered.map((item) => {
        const blocked = FORMAT_BLOCKED[item.format] || ''
        const refusal = blocked ? '' : refusalFor(item.format)
        const caveat = blocked ? '' : caveatLine(item.format)
        const warn = Boolean(refusal) || Boolean(caveat)
        const tile = document.createElement('button')
        tile.type = 'button'
        tile.className = [
          'format',
          item.format === state.format ? 'is-selected' : '',
          blocked ? 'is-na' : '',
          warn ? 'is-warn' : '',
        ]
          .filter(Boolean)
          .join(' ')
        tile.disabled = Boolean(blocked) || state.phase === 'sending'
        const label = document.createElement('span')
        label.className = 'format__label'
        label.textContent = item.label
        tile.append(label)
        if (warn) label.append(warningTriangle())
        const note = blocked || (refusal ? `Delivered as-is, not converted. ${refusal}.` : caveat)
        if (note) {
          tile.title = note
          tile.setAttribute('aria-description', note)
        }
        tile.addEventListener('click', () => {
          if (caveat && item.format !== state.format) {
            askCaveat(item, caveatOf(item.format))
            return
          }
          state.format = item.format
          renderStep3()
        })
        return tile
      })
    )

    const chosen = offered.find((item) => item.format === state.format)
    const refused = chosen && refusalFor(chosen.format)
    const warned = refused
      ? `${chosen.label} is delivered as it is — nothing is converted. ${refused}.`
      : chosen
        ? caveatLine(chosen.format)
        : ''
    const plain = warned || !chosen ? '' : FORMAT_NOTE[chosen.format] || ''

    const line = $('formatWarn')
    line.classList.toggle('format-warn--plain', Boolean(plain))
    show(line, Boolean(warned || plain))
    if (warned) line.replaceChildren(warningTriangle(), document.createTextNode(warned))
    else if (plain) line.replaceChildren(document.createTextNode(plain))
  }

  function outcome() {
    const ext = SendLogic.extensionOf(state.file?.name || '')
    if (skipsFormat()) return { label: ext.toUpperCase(), via: [] }
    const item = state.targets.find((t) => t.format === state.format)
    if (!item || item.refusal) return { label: ext.toUpperCase(), via: [] }
    return { label: item.label, via: item.via || [] }
  }

  function refusalFor(format) {
    if (!state.file) return ''
    const item = state.targets.find((t) => t.format === format)
    return item ? item.refusal || '' : ''
  }

  function renderStep1() {
    const open = openStep()

    for (const n of [1, 2, 3, 4, 5]) {
      show($(`step${n}`), open === n)
      show($(`step${n}Summary`), open !== n)
      badge($(`badge${n}`), false, true, String(n))
    }

    $('step1Value').textContent = !step1Done()
      ? 'Not set up yet'
      : state.method === 'sync'
        ? `Kobo sync · ${device()?.label || 'your Kobo'}`
        : `${state.paired.label} · KEY ${state.paired.key}`

    $('step2Value').textContent = state.file
      ? `${state.file.name} · ${size(state.file.size)}`
      : 'No file yet'

    $('step3Value').textContent = targetLabel()
    $('step4Value').textContent = skipsFormat()
      ? 'Not converting'
      : formatsFor().find((f) => f.format === state.format)?.label || 'Pick one'
    $('step5Value').textContent = optionsSummary()

    if (linkLost()) {
      $('badge1Summary').className = 'step__badge step__badge--lost'
      $('badge1Summary').textContent = '✕'
    } else {
      badge($('badge1Summary'), step1Done(), false, '1')
    }
    badge($('badge2Summary'), Boolean(state.file), false, '2')
    badge($('badge3Summary'), ready(), false, '3')
    if (skipsFormat()) {
      $('badge4Summary').className = 'step__badge step__badge--skipped'
      $('badge4Summary').textContent = '→'
    } else {
      badge($('badge4Summary'), ready(), false, '4')
    }
    badge($('badge5Summary'), ready(), false, '5')

    renderRail()
    showCta()
  }

  const keyCells = attachCodeCells($('cells'), {
    length: 4,
    label: 'The four characters your eReader shows',
    onInput: (value) => {
      state.key = value
      clearOverlay()
      renderKeyStatus(null)
    },
    onComplete: () => lookupKey(),
  })

  function renderCells() {
    if (keyCells.value !== state.key) keyCells.clear()
  }

  function renderKeyStatus(bad) {
    show($('keyIdle'), !state.checking && !bad)
    show($('keyChecking'), state.checking)
    show($('keyBadInline'), Boolean(bad))
    if (bad) $('badKeyInline').textContent = bad
    keyCells.markBad(bad)
  }

  function overlay(kind, key) {
    const warn = kind === 'expired'
    $('overlayBox').className = `branch-overlay__box${warn ? ' is-warn' : ''}`
    $('overlayBang').className = `bang bang--md${warn ? ' bang--warn' : ''}`
    $('overlayTitle').textContent = warn ? 'That key ran out' : `No eReader is showing ${key}`
    $('overlayText').textContent = warn
      ? 'Keys live five minutes, and only while the page is on screen. Reload it on your eReader for a fresh one.'
      : 'The characters change every time the page loads. Reload it on your eReader and read the new ones.'

    const action = $('overlayAction')
    action.className = `btn btn--sm ${warn ? 'btn--accent' : 'btn--danger'}`
    action.textContent = warn ? 'New key' : 'Try again'
    show($('overlay'), true)
  }

  function clearOverlay() {
    show($('overlay'), false)
  }

  async function lookupKey() {
    state.checking = true
    renderKeyStatus(null)
    const key = state.key

    let res
    try {
      res = await fetch(`/key/${encodeURIComponent(key)}`, { credentials: 'same-origin' })
    } catch {
      state.checking = false
      renderKeyStatus(null)
      return
    }

    state.checking = false
    if (!res.ok) {
      renderKeyStatus(null)
      overlay('notfound', key)
      return
    }

    const info = await res.json()
    if (!page.alive) return
    state.paired = {
      key,
      label: info.label,
      device: info.device,
      connected: info.connected,
      expiresAt: deadlineFrom(info.expiresInMs),
    }
    state.opened = 0
    state.target = info.device === 'kobo' || info.device === 'kindle' ? info.device : 'none'
    state.format = ''
    renderKeyStatus(null)
    clearOverlay()
    renderPaired()
    renderMethod()
    renderStep3()
    renderSend()
    pollLink()
  }

  function renderPaired() {
    if (!state.paired) return
    $('pairedTitle').textContent = `Paired with ${state.paired.label}`
    const connected = state.paired.connected

    $('pairedMeta').textContent = connected
      ? `KEY ${state.paired.key}`
      : `KEY ${state.paired.key} · EXPIRES IN ${clock(state.paired.expiresAt)}`
    $('linkRow').className = connected
      ? 'status-box live-row status-box--well'
      : 'status-box live-row is-error'
    $('linkDot').className = `status-box__dot live-row__dot${connected ? ' is-live' : ''}`
    $('linkTitle').textContent = connected ? 'Still connected' : 'Connection lost'
    $('linkMeta').textContent = connected
      ? `${state.paired.label.toUpperCase()} HAS THE KEY PAGE OPEN`
      : 'THE DEVICE STOPPED ANSWERING — WIFI OR SLEEP'
    show($('linkRetry'), !connected)
    renderStep1()
  }

  let linkTimer = null
  function pollLink() {
    if (linkTimer) clearInterval(linkTimer)
    linkTimer = page.every(1500, checkLink)
  }

  async function checkLink() {
    if (!state.paired || state.phase === 'sending') return
    try {
      const res = await fetch(`/key/${encodeURIComponent(state.paired.key)}`)
      if (!page.alive) return
      if (!res.ok) {
        state.paired = null
        clearInterval(linkTimer)
        renderMethod()
        renderSend()
        overlay('expired', '')
        return
      }
      const info = await res.json()
      state.paired.connected = info.connected
      state.paired.expiresAt = deadlineFrom(info.expiresInMs)
      renderPaired()
    } catch {
    }
  }

  function statusOf(device) {
    return SYNC_STATUS[device?.paired ? 'ok' : 'never']
  }

  function renderSync() {
    const chosen = state.devices.find((d) => d.id === state.deviceId) || null

    show($('syncSelect'), state.devices.length > 0)
    show($('syncNone'), state.devices.length === 0)

    if (chosen) {
      const status = statusOf(chosen)
      $('syncTrigger').className = `status-box sync-select__trigger ${status.className}`
      $('syncLabel').textContent = chosen.label
      $('syncMeta').textContent = typeof status.text === 'function' ? status.text() : status.text
    }

    const tpl = $('syncRowTpl')
    $('syncMenu').replaceChildren(
      ...state.devices.map((device) => {
        const status = statusOf(device)
        const row = tpl.content.firstElementChild.cloneNode(true)
        row.className = `status-box sync-menu__item ${status.className}`
        if (device.id === state.deviceId) row.classList.add('is-current')
        row.setAttribute('aria-selected', String(device.id === state.deviceId))
        row.querySelector('.status-box__title').textContent = device.label
        row.querySelector('.status-box__meta').textContent = status.menuText(device)
        row.addEventListener('click', () => {
          state.deviceId = device.id
          state.opened = 0
          setSyncMenu(false)
          renderSync()
          renderStep1()
          renderStep3()
          renderSend()
        })
        return row
      })
    )
  }

  function setSyncMenu(open) {
    state.menuOpen = open
    $('syncSelect').classList.toggle('is-open', open)
    $('syncTrigger').setAttribute('aria-expanded', String(open))
    show($('syncMenu'), open)
  }

  function refuse(title, text) {
    state.file = null
    state.opened = 2
    $('refusalTitle').textContent = title
    $('refusalText').textContent = text
    show($('refusal'), true)
    show($('filerow'), false)
    show($('dropzone'), false)
    renderStep2()
    renderStep3()
    renderSend()
  }

  function setFile(file) {
    if (!file) return

    if (!SendLogic.isAccepted(file.name)) {
      refuse(
        `.${SendLogic.extensionOf(file.name)} isn't one we handle`,
        "Convert it to EPUB first, or paste a link and we'll build one for you."
      )
      return
    }
    if (state.maxFileSize && file.size > state.maxFileSize) {
      refuse(
        `That file is ${size(file.size)}, over this server's limit`,
        `This server accepts up to ${size(state.maxFileSize)}.`
      )
      return
    }

    state.file = file
    state.opened = 0
    show($('refusal'), false)
    show($('dropzone'), false)
    show($('filerow'), true)
    $('filename').textContent = file.name
    $('filemeta').textContent = `${size(file.size)} · ${SendLogic.extensionOf(file.name).toUpperCase()}`
    renderStep2()
    renderStep3()
    renderSend()
    loadTargets()
  }

  async function loadTargets() {
    const from = state.file ? SendLogic.extensionOf(state.file.name) : ''
    if (!from) {
      state.targets = []
      return
    }
    try {
      const res = await fetch(`/api/convert/targets?from=${encodeURIComponent(from)}`)
      if (!res.ok) return
      const groups = (await res.json()).groups || []
      if (!page.alive) return
      state.targets = groups.flatMap((group) => group.items)
    } catch {
      return
    }
    renderStep3()
    renderSend()
  }

  function clearFile() {
    state.file = null
    state.opened = 0
    show($('dropzone'), true)
    show($('filerow'), false)
    show($('refusal'), false)
    $('fileinput').value = ''
    renderStep2()
    renderStep3()
    renderSend()
  }

  function renderStep2() {
    renderStep1()
  }

  function step1Done() {
    return state.method === 'sync' ? Boolean(state.deviceId) : Boolean(state.paired)
  }

  const TARGET_NOTES = {
    kobo: 'Kobo, Tolino and PocketBook. KEPUB is their own format; EPUB is read by everything.',
    kindle: 'Kindle. AZW3 is the safe choice — KFX can only be written by Amazon’s own tool.',
    other: 'Phones, tablets, other readers. EPUB is read by everything; PDF keeps fixed pages.',
    none: 'Sends the bytes exactly as they are. Your device may not open them.',
  }

  function renderTargets() {
    const locked = state.method === 'sync' || state.phase === 'sending'
    const current = targetOf()

    for (const tile of document.querySelectorAll('#targets .format')) {
      const target = tile.dataset.target
      tile.classList.toggle('is-selected', target === current)
      tile.classList.toggle('is-na', locked && target !== current)
      tile.disabled = locked
      const note = TARGET_NOTES[target] || ''
      tile.title = note
      tile.setAttribute('aria-description', note)
      tile.setAttribute('aria-pressed', String(target === current))
    }
  }

  function renderStep3() {
    renderTargets()
    renderFormats()

    const live = ready()
    show($('pipeArrow'), live)

    if (live) {
      const ext = SendLogic.extensionOf(state.file.name)
      const out = outcome()
      $('pipeFrom').textContent = ext.toUpperCase()
      $('pipeTo').textContent = out.label
      $('pipeTool').textContent = out.via.length ? `· ${out.via.join(', then ')}` : ''
    } else {
      $('pipeFrom').textContent = ''
      $('pipeTo').textContent = ''
      $('pipeTool').textContent = ''
    }

    renderFixes()
    renderStep1()
  }

  function offeredFixes() {
    if (!ready()) return SendLogic.fixes('', 'none', state.tools, '')
    const ext = SendLogic.extensionOf(state.file.name)
    if (skipsFormat()) {
      return SendLogic.convertFixes(ext, ext, state.tools, state.file.name).filter(
        (fix) => fix.id !== 'pdfcropmargins'
      )
    }
    return SendLogic.convertFixes(ext, state.format, state.tools, state.file.name)
  }

  function renderFixes() {
    const live = ready()
    const offered = offeredFixes()

    if (!offered.some((fix) => fix.id === state.openOption)) {
      state.openOption = offered[0]?.id || ''
    }

    $('optionsLive').replaceChildren(
      ...offered.map((fix) => {
        const enabled = live && fix.applies && Boolean(fix.available)
        return buildOption($('optionTpl'), {
          label: fix.label,
          desc: optionText(fix, live, enabled),
          enabled,
          on: chosen(fix.id),
          open: !live || fix.id === state.openOption,
          toggle: () => {
            state.chosen[fix.id] = !chosen(fix.id)
            renderFixes()
            renderSend()
          },
          expand: () => {
            state.openOption = fix.id
            renderFixes()
          },
        })
      })
    )
  }

  function chosen(id) {
    if (id in state.chosen) return state.chosen[id] === true
    return state.prefs[id] === true
  }

  function optionText(fix, live, enabled) {
    const why =
      live && !enabled ? (fix.available ? fix.reason : 'Not installed on this server.') : ''
    return [fix.description || '', why].filter(Boolean).join(' ')
  }

  function buildOption(tpl, { label, desc, enabled, on, open, toggle, expand }) {
    const row = tpl.content.firstElementChild.cloneNode(true)

    row.classList.toggle('is-na', !enabled)
    row.classList.toggle('is-open', open)
    row.setAttribute('aria-checked', String(on))
    if (!enabled) {
      row.setAttribute('aria-disabled', 'true')
      row.removeAttribute('tabindex')
    }

    const box = row.querySelector('.checkbox')
    box.classList.toggle('is-on', on)
    box.textContent = on ? '✓' : ''

    row.querySelector('.option__label').textContent = label
    row.querySelector('.option__desc').textContent = desc
    row.querySelector('.option__why').remove()

    const caret = row.querySelector('.option__caret')
    caret.setAttribute('aria-expanded', String(open))
    caret.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!open) expand()
    })

    if (enabled) {
      row.addEventListener('click', toggle)
      row.addEventListener('keydown', (e) => {
        if (e.key !== ' ' && e.key !== 'Enter') return
        e.preventDefault()
        toggle()
      })
    }
    return row
  }

  function showCta() {
    if (state.phase === 'sending') return
    show($('submitbtn'), ready() && openStep() === 5)
  }

  function renderSend() {
    const btn = $('submitbtn')
    if (state.phase === 'sending') return
    showCta()
    btn.disabled = !ready()

    if (ready()) {
      $('submitlabel').textContent =
        state.method === 'sync'
          ? `Deliver to ${device()?.label || 'your Kobo'}`
          : `Send to ${state.paired.label}`
    } else if (state.method === 'sync' && !state.deviceId) {
      $('submitlabel').textContent = 'No device has synced yet'
    } else if (!step1Done()) {
      $('submitlabel').textContent = 'Enter a key to begin'
    } else {
      $('submitlabel').textContent = 'Add a file to send'
    }

    renderStep2()
  }

  const EASE_MS = 700
  const MAX_RATE = 45
  const FINISH_CAP_MS = 1500

  let shownPct = 0
  let targetPct = 0
  let lastFrame = 0
  let walk = null

  function paintProgress() {
    $('submitlabel').textContent = `Sending file · ${Math.round(shownPct)}%`
    $('bar').style.setProperty('--prog', `${shownPct.toFixed(2)}%`)
  }

  function progress(ceiling) {
    $('submitbtn').disabled = false
    $('submitbtn').title = 'Cancel this send'
    $('submitbtn').classList.add('is-running')
    targetPct = ceiling
    paintProgress()
  }

  page.frame(() => {
    if (!$('submitbtn').classList.contains('is-running')) return
    const now = performance.now()
    const elapsed = lastFrame ? now - lastFrame : 16
    lastFrame = now

    if (walk) {
      const t = walk.ms > 0 ? Math.min(1, (now - walk.start) / walk.ms) : 1
      const curve = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2
      shownPct = walk.from + walk.span * curve
      paintProgress()
      if (t >= 1) {
        const { done } = walk
        walk = null
        page.after(200, done)
      }
      return
    }

    const gap = targetPct - shownPct
    if (gap < 0.01) return
    const eased = gap * (1 - Math.exp(-elapsed / EASE_MS))
    shownPct += Math.min(eased, (MAX_RATE * elapsed) / 1000)
    paintProgress()
  })

  function finish() {
    return new Promise((resolve) => {
      const span = 100 - shownPct
      walk = {
        from: shownPct,
        span,
        start: performance.now(),
        ms: Math.min(FINISH_CAP_MS, (span / MAX_RATE) * 1500),
        done: resolve,
      }
    })
  }

  function sending(on) {
    if (on) {
      shownPct = 0
      targetPct = 0
      lastFrame = 0
      walk = null
    } else {
      $('submitbtn').classList.remove('is-running')
      $('submitbtn').removeAttribute('title')
      show($('cancelModal'), false)
    }
    renderTargets()
  }

  async function send(target) {
    state.phase = 'sending'
    show($('submitbtn'), true)
    show($('donepanel'), false)
    show($('errorpanel'), false)
    sending(true)

    const body = new FormData()
    if (state.method === 'sync') body.append('deviceId', state.deviceId)
    else body.append('key', state.paired.key)
    const asIs = target === 'none' || passthroughFormat()
    body.append('file', state.file)
    body.append('target', asIs || target === 'other' ? 'none' : target)
    body.append('kindleFormat', 'azw3')
    if (!asIs && state.format) body.append('format', state.format)
    for (const id of ['layoutFix', 'pdfcropmargins', 'transliteration']) {
      const on = chosen(id)
      body.append(id, on ? 'on' : 'off')
    }
    appendLayoutSettings(body)
    body.append('hold', 'on')

    progress(65)
    inFlight = new AbortController()

    let result
    try {
      const res = await fetch('/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: await csrfHeaders(),
        body,
        signal: inFlight.signal,
      })
      progress(92)
      result = { ok: res.ok, data: await res.json().catch(() => null) }
    } catch (err) {
      result = { ok: false, aborted: err?.name === 'AbortError', data: null, network: true }
    }

    inFlight = null
    if (!page.alive) return

    if (result.aborted) {
      state.phase = 'idle'
      sending(false)
      renderSend()
      return
    }

    if (!result.ok || !result.data?.ok) {
      progress(100)
      await finish()
      if (!page.alive) return
      state.phase = 'idle'
      sending(false)
      renderSend()
      failed(result.network ? 'transfer' : 'convert', result.data?.error)
      return
    }

    const token = result.data.pending
    if (token) {
      const choice = await whenDecided()
      if (!page.alive) return

      if (choice === 'drop') {
        await post('/upload/discard', { ...owner(), token })
        if (!page.alive) return
        state.phase = 'idle'
        verdict = null
        sending(false)
        renderSend()
        return
      }

      const committed = await post('/upload/commit', { ...owner(), token })
      if (!page.alive) return
      if (!committed?.ok) {
        state.phase = 'idle'
        verdict = null
        sending(false)
        renderSend()
        failed('transfer', committed?.error)
        return
      }
      result.data.kept = committed.kept
    }

    progress(100)
    await finish()
    if (!page.alive) return

    state.phase = 'idle'
    verdict = null
    sending(false)
    renderSend()

    done(result.data)
  }

  function owner() {
    return state.method === 'sync' ? { deviceId: state.deviceId } : { key: state.paired.key }
  }

  async function post(url, payload) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: await csrfHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(payload),
      })
      return await res.json().catch(() => null)
    } catch {
      return null
    }
  }

  function done(data) {
    show($('donepanel'), true)
    const sync = state.method === 'sync'
    $('doneTitle').textContent = sync ? 'Waiting for your Kobo' : `On your ${state.paired.label}`

    $('doneText').replaceChildren()
    const name = document.createElement('span')
    name.className = 'mono'
    name.textContent = data.filename
    $('doneText').append(
      name,
      sync
        ? ` is queued at your sync endpoint. It arrives at the next sync and stays available for ${queueHours().toLowerCase()}, or until the device downloads it — whichever comes first.`
        : ' is ready to download. Tap the entry on the key page to save it.'
    )

    History.add({
      filename: state.file.name,
      ok: true,
      destination: sync ? device()?.label || 'Kobo sync' : state.paired.label,
      format: outcome().label,
      size: state.file.size,
    })

    const line = SendLogic.keptLine(data.kept, 'send')
    show($('doneKept'), Boolean(line))
    $('doneKept').classList.toggle('panel__kept--full', Boolean(line?.full))
    $('doneKept').textContent = line?.text ?? ''
  }

  function failed(kind, error) {
    show($('errorpanel'), true)
    const where = state.method === 'sync' ? 'Kobo' : SendLogic.label(state.paired.device) || 'eReader'
    const tool = outcome().via[0] || 'calibre'

    $('errorTitle').textContent = kind === 'transfer' ? 'Transfer interrupted' : 'Conversion failed'
    $('errorText').textContent =
      kind === 'transfer'
        ? `The upload stopped partway through and nothing reached your ${where}. The file was never written to disk.`
        : `${tool} could not read ${state.file.name} — it looks truncated. Nothing was sent to your ${where}.`

    show($('errorLog'), Boolean(error))
    if (error) $('errorLog').textContent = error

    show($('sendRaw'), state.target !== 'none' && state.method !== 'sync')

    History.add({
      filename: state.file.name,
      ok: false,
      destination: state.method === 'sync' ? device()?.label || 'Kobo sync' : state.paired.label,
    })
  }

  for (const btn of document.querySelectorAll('.method')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.method === 'sync' && !state.devices.length) {
        if (!state.signedIn) {
          window.location.href = '/login?next=%2F'
        } else {
          window.location.href = state.verified ? '/settings#kobo' : '/settings#profile'
        }
        return
      }
      state.method = btn.dataset.method
      state.opened = 0
      clearOverlay()
      renderMethod()
      renderStep3()
      renderSend()
    })
  }

  $('overlayAction').addEventListener('click', () => {
    state.key = ''
        clearOverlay()
    renderCells()
    renderKeyStatus(null)
    keyCells.focus()
  })

  $('changeKey').addEventListener('click', () => {
    state.paired = null
    state.key = ''
        if (linkTimer) clearInterval(linkTimer)
    renderMethod()
    renderCells()
    renderKeyStatus(null)
    renderStep3()
    renderSend()
  })

  $('linkRetry').addEventListener('click', checkLink)

  $('extendKey').addEventListener('click', async () => {
    if (!state.paired) return
    let data = null
    try {
      const res = await fetch(`/key/${encodeURIComponent(state.paired.key)}/extend`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: await csrfHeaders(),
      })
      if (res.ok) data = await res.json()
    } catch {
    }
    if (!page.alive || !data || !state.paired) return
    state.paired.expiresAt = deadlineFrom(data.expiresInMs)
    renderPaired()
  })

  let shown = ''
  page.frame(() => {
    if (!state.paired || state.paired.connected) return
    const next = clock(state.paired.expiresAt)
    if (next === shown) return
    shown = next
    renderPaired()
  })

  let host = window.location.origin

  function setHost(value) {
    host = value.replace(/\/+$/, '')
    $('hostLabel').textContent = host
  }

  $('hostChip').addEventListener('click', async () => {
    if (!(await copyText(host))) return
    $('hostChip').classList.add('is-copied')
    page.after(1200, () => $('hostChip').classList.remove('is-copied'))
  })

  $('syncTrigger').addEventListener('click', () => setSyncMenu(!state.menuOpen))
  page.on(document, 'click', (e) => {
    if (state.menuOpen && !$('syncSelect').contains(e.target)) setSyncMenu(false)
  })

  $('fileinput').addEventListener('change', (e) => setFile(e.target.files[0]))
  $('clearfile').addEventListener('click', clearFile)
  $('dismissRefusal').addEventListener('click', () => {
    show($('refusal'), false)
    show($('dropzone'), true)
  })

  const zone = $('dropzone')
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (e) => {
      e.preventDefault()
      zone.classList.add('is-dragging')
      $('dzLabel').textContent = 'Let go to load it'
    })
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, (e) => {
      e.preventDefault()
      zone.classList.remove('is-dragging')
      $('dzLabel').textContent = "Or drag and drop like it's hot"
      if (type === 'drop') setFile(e.dataTransfer?.files[0])
    })
  }

  for (const tile of document.querySelectorAll('#targets .format')) {
    tile.addEventListener('click', () => {
      if (state.target === tile.dataset.target) return
      state.target = tile.dataset.target
      state.format = ''
      renderStep3()
      renderSend()
    })
  }

  $('caveatConfirm').addEventListener('click', () => closeCaveat(true))
  $('caveatCancel').addEventListener('click', () => closeCaveat(false))
  $('caveatModal').addEventListener('click', (e) => {
    if (e.target === $('caveatModal')) closeCaveat(false)
  })
  page.on(document, 'keydown', (e) => {
    if (e.key !== 'Escape') return
    if (!$('caveatModal').hidden) closeCaveat(false)
    if (!$('cancelModal').hidden) show($('cancelModal'), false)
  })

  for (const n of [1, 2, 3, 4, 5]) {
    $(`step${n}Summary`).addEventListener('click', () => goToStep(n))
  }

  for (const dot of document.querySelectorAll('.step-rail__dot')) {
    dot.addEventListener('click', () => goToStep(Number(dot.dataset.step)))
  }

  let wheelAt = 0
  page.on(document.querySelector('.step-card'), 'wheel', (e) => {
    if (Math.abs(e.deltaY) < 4) return
    const now = performance.now()
    if (now - wheelAt < 320) return
    const next = openStep() + (e.deltaY > 0 ? 1 : -1)
    if (next < 1 || next > 5) return
    e.preventDefault()
    wheelAt = now
    goToStep(next)
  }, { passive: false })

  $('submitbtn').addEventListener('click', () => {
    if (state.phase === 'sending') {
      askVerdict()
      return
    }
    send(state.method === 'sync' ? 'auto' : state.target)
  })

  $('cancelKeep').addEventListener('click', () => decide('deliver'))
  $('cancelConfirm').addEventListener('click', () => decide('drop'))
  $('cancelModal').addEventListener('click', (e) => {
    if (e.target === $('cancelModal')) decide('deliver')
  })
  $('retry').addEventListener('click', () => send(state.method === 'sync' ? 'auto' : state.target))
  $('sendRaw').addEventListener('click', () => send('none'))
  $('pickAnother').addEventListener('click', () => {
    show($('errorpanel'), false)
    clearFile()
  })
  $('sendAnother').addEventListener('click', () => {
    show($('donepanel'), false)
    clearFile()
  })

  // Confirmed, or never asked for. A server with no mail sends the confirmation
  // link to its log, so telling somebody to go and confirm is telling them to go
  // and read a file they cannot reach.
  function settledAddress(status) {
    if (!status?.user) return false
    return status.user.emailVerified === true || status.verificationNeeded === false
  }

  function draw() {
    if (state.devices.length) {
      $('syncNote').textContent = 'No key. It waits for the next sync, up to a day.'
      state.deviceId = state.devices[0].id
    } else if (state.signedIn && !state.verified) {
      $('syncNote').textContent = 'Confirm your email address first. Do that in Settings →'
    } else if (state.signedIn) {
      $('syncNote').textContent = 'Not set up yet — takes a minute. Set it up →'
    }
    document.querySelector('.method[data-method="sync"]').classList.toggle(
      'is-cta',
      state.devices.length === 0
    )

    renderMethod()
    renderCells()
    renderKeyStatus(null)
    renderSync()
    renderStep3()
    renderSend()
  }

  function applyHealth(health) {
    if (!health) return
    state.tools = health.tools || state.tools
    state.maxFileSize = health.maxFileSize || 0
    state.queueTtl = health.queueTtlSeconds || 0
    if (health.publicUrl) setHost(health.publicUrl)
    $('ttl').textContent = spell(health.expireSeconds || 5 * 60)
  }

  async function boot() {
    setHost(window.location.origin)
    applyHealth(readCachedHealth())
    const cached = readCachedStatus()
    state.signedIn = Boolean(cached?.user)
    state.verified = settledAddress(cached)
    draw()
    keyCells.focus()

    try {
      applyHealth(await getHealth())
    } catch {
    }
    if (!page.alive) return

    const status = await getStatus()
    state.signedIn = Boolean(status?.user)
    state.verified = settledAddress(status)
    if (state.signedIn) {
      try {
        const res = await fetch('/api/devices', { credentials: 'same-origin' })
        if (res.ok) state.devices = (await res.json()).devices || []
      } catch {
      }
    }
    if (!page.alive) return

    draw()
  }

  boot()
})
