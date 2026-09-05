'use strict'

onPage('convert', (page) => {
  const $ = (id) => document.getElementById(id)

  const state = {
    file: null,
    target: '',
    format: '',
    groups: [],
    tools: { kepubify: false, calibre: false, pdfcropmargins: false, layoutFix: false },
    maxFileSize: 0,
    chosen: {},
    opened: 0,
    openOption: '',
    result: null,
    running: false,
  }

  let inFlight = null
  let cancelled = false
  page.leave(() => inFlight?.abort())

  function size(bytes) {
    const mb = bytes / (1024 * 1024)
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
  }

  const show = (el, visible) => {
    if (el) el.hidden = !visible
  }

  function badge(el, done, current, mark) {
    el.className = `step__badge${done ? ' is-complete' : current ? ' is-current' : ''}`
    el.textContent = done ? '✓' : mark
  }

  function chosen(id) {
    return id === 'layoutFix' ? state.chosen[id] !== false : state.chosen[id] === true
  }

  function offered(format) {
    for (const group of state.groups) {
      const item = group.items.find((i) => i.format === format)
      if (item) return item
    }
    return null
  }

  function sourceFormat() {
    return state.file ? SendLogic.extensionOf(state.file.name) : ''
  }

  function refuse(title, text) {
    state.file = null
    $('refusalTitle').textContent = title
    $('refusalText').textContent = text
    show($('refusal'), true)
    show($('filerow'), false)
    show($('dropzone'), false)
    renderAll()
  }

  function setFile(file) {
    if (!file) return
    if (!SendLogic.isAccepted(file.name)) {
      refuse(
        `.${SendLogic.extensionOf(file.name)} isn't one we handle`,
        "These converters can't read it. Turn it into an EPUB first and we'll take it from there."
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
    loadTargets()
  }

  function clearFile() {
    state.file = null
    state.target = ''
    state.format = ''
    state.result = null
    state.running = false
    state.opened = 0
    $('fileinput').value = ''
    show($('dropzone'), true)
    show($('filerow'), false)
    show($('refusal'), false)
    show($('donepanel'), false)
    show($('errorpanel'), false)
    loadTargets()
  }

  const TARGETS_CACHE_KEY = 's2e_targets_v1'

  function cachedTargets(from) {
    try {
      return JSON.parse(sessionStorage.getItem(TARGETS_CACHE_KEY) || '{}')[from] || null
    } catch {
      return null
    }
  }

  function cacheTargets(from, groups) {
    try {
      const all = JSON.parse(sessionStorage.getItem(TARGETS_CACHE_KEY) || '{}')
      all[from] = groups
      sessionStorage.setItem(TARGETS_CACHE_KEY, JSON.stringify(all))
    } catch {
    }
  }

  async function loadTargets() {
    const from = sourceFormat()
    const cached = cachedTargets(from)
    if (cached) state.groups = cached

    renderAll()

    let groups = null
    try {
      const res = await fetch(`/api/convert/targets?from=${encodeURIComponent(from)}`)
      if (res.ok) groups = (await res.json()).groups || []
    } catch {
    }
    if (!page.alive) return
    if (groups) {
      state.groups = groups
      cacheTargets(from, groups)
    } else if (!cached) {
      state.groups = []
    }

    if (state.format && !usable(state.format)) state.format = ''
    renderAll()
  }

  const TARGET_GROUP = { kobo: 'Kobo', kindle: 'Kindle' }

  const TARGET_LABEL = { kobo: 'Kobo', kindle: 'Kindle', other: 'Other devices' }

  const DEVICE_ONLY = new Set(['kepub', 'kfx', 'azw3', 'mobi'])

  function formatsFor() {
    if (state.target === 'other') {
      return state.groups.flatMap((g) => g.items).filter((i) => !DEVICE_ONLY.has(i.format))
    }
    const group = state.groups.find((g) => g.name === TARGET_GROUP[state.target])
    return group ? group.items : []
  }

  function usable(format) {
    const item = offered(format)
    return Boolean(item && !item.refusal)
  }

  function ready() {
    return Boolean(state.file) && Boolean(state.format) && usable(state.format)
  }

  function openStep() {
    if (state.opened) return state.opened
    if (!state.file) return 1
    if (!state.target) return 2
    if (!state.format) return 3
    return 4
  }

  function goToStep(n) {
    state.opened = Math.min(4, Math.max(1, n))
    renderSteps()
  }

  function renderRail() {
    const open = openStep()
    const done = [Boolean(state.file), Boolean(state.target), ready(), ready()]
    for (const dot of document.querySelectorAll('.step-rail__dot')) {
      const n = Number(dot.dataset.step)
      dot.classList.toggle('is-current', n === open)
      dot.classList.toggle('is-done', n !== open && done[n - 1])
      dot.setAttribute('aria-selected', String(n === open))
    }
  }

  function renderTargets() {
    const settled = state.running || Boolean(state.result)

    for (const tile of document.querySelectorAll('#targets .format')) {
      tile.classList.toggle('is-selected', tile.dataset.target === state.target)
      tile.disabled = settled
    }
  }

  const FORMAT_ABOUT = {
    epub: 'Universal, flexible e-book format.',
    pdf: 'Fixed-layout documents and books.',
    mobi: 'Older Kindle e-book format.',
    azw3: 'Advanced Kindle e-book format.',
    kfx: 'Modern Kindle e-book format.',
    kepub: 'Optimized e-book format for Kobo.',
    txt: 'Plain text with no formatting.',
    htmlz: 'Packaged HTML e-book format.',
  }

  function renderFormats() {
    const items = formatsFor()
    const settled = state.running || Boolean(state.result)

    if (state.format && !items.some((item) => item.format === state.format)) state.format = ''

    $('formats').replaceChildren(
      ...items.map((item) => {
        const tile = document.createElement('button')
        tile.type = 'button'
        tile.className = [
          'format',
          item.format === state.format ? 'is-selected' : '',
          item.refusal ? 'is-na' : '',
        ]
          .filter(Boolean)
          .join(' ')
        tile.disabled = Boolean(item.refusal) || settled

        const label = document.createElement('span')
        label.className = 'format__label'
        label.textContent = item.label
        tile.append(label)

        const about = FORMAT_ABOUT[item.format] || item.note
        const tip = item.refusal ? `${about}\n${item.refusal}` : about
        tile.title = tip
        tile.setAttribute('aria-description', tip)

        tile.addEventListener('click', () => {
          state.format = item.format
          if (state.opened === 3) state.opened = 0
          renderAll()
        })
        return tile
      })
    )
  }

  function renderPipeline() {
    const live = ready()
    $('pipeArrow').hidden = !live

    if (!live) {
      $('pipeFrom').textContent = ''
      $('pipeTo').textContent = ''
      $('pipeTool').textContent = ''
    } else {
      const item = offered(state.format)
      $('pipeFrom').textContent = sourceFormat().toUpperCase()
      $('pipeTo').textContent = item ? item.label : state.format.toUpperCase()
      $('pipeTool').textContent = item && item.via.length ? `· ${item.via.join(', then ')}` : ''
    }

    renderFixes()
  }

  function optionsSummary() {
    if (!ready()) return 'Waiting for a file'
    const on = offeredFixes()
      .filter((fix) => fix.applies && fix.available && chosen(fix.id))
      .map((fix) => fix.label)
    return on.length ? on.join(', ') : 'Nothing extra'
  }

  function renderSteps() {
    const open = openStep()

    for (const n of [1, 2, 3, 4]) {
      show($(`step${n}`), open === n)
      show($(`step${n}Summary`), open !== n)
    }

    $('step1Value').textContent = state.file
      ? `${state.file.name} · ${size(state.file.size)}`
      : 'No file yet'
    $('step2Value').textContent = state.target ? TARGET_LABEL[state.target] : 'Pick one'
    $('step3Value').textContent =
      formatsFor().find((f) => f.format === state.format)?.label || 'Pick one'
    $('step4Value').textContent = optionsSummary()

    for (const n of [1, 2, 3, 4]) badge($(`badge${n}`), false, true, String(n))
    badge($('badge1Summary'), Boolean(state.file), false, '1')
    badge($('badge2Summary'), Boolean(state.target), false, '2')
    badge($('badge3Summary'), ready(), false, '3')
    badge($('badge4Summary'), ready(), false, '4')

    renderRail()
    showCta()
  }

  function showCta() {
    if (state.running) return
    show($('runbtn'), ready() && openStep() === 4)
  }

  function optionText(fix, live, enabled) {
    const why =
      live && !enabled ? (fix.available ? fix.reason : 'Not installed on this server. An administrator can add it under Admin → Converters.') : ''
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

  function offeredFixes() {
    if (!ready()) return SendLogic.fixes('', 'none', state.tools, '')
    return SendLogic.convertFixes(sourceFormat(), state.format, state.tools, state.file.name)
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
            renderSteps()
          },
          expand: () => {
            state.openOption = fix.id
            renderFixes()
          },
        })
      })
    )
  }

  function renderAll() {
    renderTargets()
    renderFormats()
    renderPipeline()
    renderSteps()

    const btn = $('runbtn')
    if (state.running) return
    if (state.result) {
      btn.disabled = false
      $('runlabel').textContent = 'Convert another book'
      return
    }
    btn.disabled = !ready()
    $('runlabel').textContent = !state.file
      ? 'Pick a file to convert'
      : ready()
        ? `Convert to ${offered(state.format)?.label || state.format.toUpperCase()}`
        : state.target
          ? 'Pick a format'
          : 'Pick what it is for'
  }

  const EASE_MS = 700
  const MAX_RATE = 45
  const FINISH_CAP_MS = 1500

  let shownPct = 0
  let targetPct = 0
  let lastFrame = 0
  let walk = null

  function paintProgress() {
    $('runlabel').textContent = `Converting file · ${Math.round(shownPct)}%`
    $('bar').style.setProperty('--prog', `${shownPct.toFixed(2)}%`)
  }

  function progress(ceiling) {
    $('runbtn').disabled = false
    $('runbtn').title = 'Cancel this conversion'
    $('runbtn').classList.add('is-running')
    targetPct = ceiling
    paintProgress()
  }

  page.frame(() => {
    if (!$('runbtn').classList.contains('is-running')) return
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

  function stopRunning() {
    state.running = false
    $('runbtn').classList.remove('is-running')
    $('runbtn').removeAttribute('title')
    show($('cancelModal'), false)
  }

  async function run() {
    show($('donepanel'), false)
    show($('errorpanel'), false)
    cancelled = false
    shownPct = 0
    targetPct = 0
    lastFrame = 0
    walk = null
    state.running = true
    show($('runbtn'), true)
    renderTargets()
    renderFormats()

    const body = new FormData()
    body.append('file', state.file)
    body.append('format', state.format)
    for (const id of ['layoutFix', 'pdfcropmargins', 'transliteration']) {
      const on = chosen(id)
      body.append(id, on ? 'on' : 'off')
    }

    progress(65)
    inFlight = new AbortController()
    let result
    try {
      const res = await fetch('/convert', {
        method: 'POST',
        credentials: 'same-origin',
        headers: await csrfHeaders(),
        body,
        signal: inFlight.signal,
      })
      progress(92)
      result = { ok: res.ok, data: await res.json().catch(() => null) }
    } catch {
      result = { ok: false, data: null }
    }
    inFlight = null
    if (!page.alive) return

    if (cancelled) {
      stopRunning()
      shownPct = 0
      $('bar').style.setProperty('--prog', '0%')
      renderAll()
      return
    }

    progress(100)
    await finish()
    if (!page.alive) return

    stopRunning()
    renderAll()

    if (!result.ok || !result.data?.ok) {
      failed(result.data?.error)
      return
    }
    succeeded(result.data)
  }

  function succeeded(data) {
    state.result = data
    show($('donepanel'), true)

    $('doneText').replaceChildren()
    const name = document.createElement('span')
    name.className = 'mono'
    name.textContent = data.filename
    $('doneText').append(name, ` · ${size(data.size)}`)

    $('downloadLink').href = data.url
    $('downloadLink').setAttribute('download', data.filename)
    sayKept(data.kept)

    renderAll()
  }

  function sayKept(kept) {
    const line = SendLogic.keptLine(kept, 'convert')
    show($('doneKept'), Boolean(line))
    $('doneKept').classList.toggle('panel__kept--full', Boolean(line?.full))
    $('doneKept').textContent = line?.text ?? ''
  }

  function failed(error) {
    show($('errorpanel'), true)
    const tool = offered(state.format)?.via[0] || 'calibre'
    $('errorTitle').textContent = `${tool} couldn't read this file`
    $('errorText').textContent = 'Nothing was written. The file looks cut short.'
    show($('errorLog'), Boolean(error))
    if (error) $('errorLog').textContent = error
  }

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
      state.target = tile.dataset.target
      state.format = ''
      if (state.opened === 2) state.opened = 0
      renderAll()
    })
  }

  for (const n of [1, 2, 3, 4]) {
    $(`step${n}Summary`).addEventListener('click', () => goToStep(n))
  }

  for (const dot of document.querySelectorAll('.step-rail__dot')) {
    dot.addEventListener('click', () => goToStep(Number(dot.dataset.step)))
  }

  let wheelAt = 0
  page.on(
    document.querySelector('.step-card'),
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) < 4) return
      const now = performance.now()
      if (now - wheelAt < 320) return
      const next = openStep() + (e.deltaY > 0 ? 1 : -1)
      if (next < 1 || next > 4) return
      e.preventDefault()
      wheelAt = now
      goToStep(next)
    },
    { passive: false }
  )

  $('runbtn').addEventListener('click', () => {
    if (state.running) {
      show($('cancelModal'), true)
      $('cancelKeep').focus()
      return
    }
    if (state.result) clearFile()
    else run()
  })

  $('cancelKeep').addEventListener('click', () => show($('cancelModal'), false))
  $('cancelConfirm').addEventListener('click', () => {
    cancelled = true
    show($('cancelModal'), false)
    inFlight?.abort()
  })

  page.on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && !$('cancelModal').hidden) show($('cancelModal'), false)
  })

  $('retry').addEventListener('click', run)
  $('tryAnother').addEventListener('click', clearFile)

  $('sendInstead').addEventListener('click', () => {
    window.location.href = '/send'
  })

  async function boot() {
    const cached = readCachedHealth()
    if (cached) {
      state.tools = cached.tools || state.tools
      state.maxFileSize = cached.maxFileSize || 0
    }

    const targets = loadTargets()

    try {
      const health = await getHealth()
      if (!page.alive) return
      state.tools = health.tools || state.tools
      state.maxFileSize = health.maxFileSize || 0
    } catch {
    }
    await targets
    if (!page.alive) return
    renderAll()
  }

  boot()
})
