onPage('extensions', async (page) => {
  const $ = (id) => document.getElementById(id)
  const gone = () => !page.alive
  const POLL_MS = 1000

  // The server owns the stage names; this owns the words.
  const ABOUT = {
    calibre: {
      unlocks: t('MOBI, AZW3, PDF, TXT and HTMLZ, and reading KFX'),
      cost: [
        ['~150MB', t('downloaded from calibre-ebook.com, once')],
        ['550MB', t('on the data volume, kept when the container is recreated')],
        ['~10 min', t('depending on the connection')],
      ],
      note: t('Everything Kindle-shaped goes through calibre.'),
      stages: {
        packages: [
          t('The libraries it needs'),
          t('Qt, fonts, and the X libraries its PDF renderer loads.'),
        ],
        download: [t('calibre itself'), t('From calibre-ebook.com, the version they publish today.')],
        install: [t('Unpacking it'), t('Into the data volume, so a recreated container keeps it.')],
        plugins: [t('The KFX plugins'), t('Input works at once; Output waits for the Previewer.')],
        verify: [t('Checking it took'), t('ebook-convert is asked its version.')],
      },
    },
    pdfcrop: {
      unlocks: t('trimming the white border off a PDF'),
      cost: [
        ['~90MB', t('on the data volume')],
        ['~2 min', t('mostly PyMuPDF')],
      ],
      note: t('Only used on a PDF, and only when you tick the box.'),
      stages: {
        packages: [t('Python and its venv module'), t('Makes sure the venv module is there.')],
        install: [t('pdfCropMargins'), t('Installed to the data volume with pip.')],
        verify: [t('Checking it took'), t('Asked its version; the crop option lights up.')],
      },
    },
    kfx: {
      unlocks: t('writing KFX, the newest Kindle format'),
      cost: [
        ['356MB', t('downloaded from Amazon, once, then deleted')],
        ['2.6GB', t('Wine prefix, kept on the data volume')],
        ['1.7GB', t('Wine packages in the container')],
        ['~920MB', t('memory while a KFX conversion runs')],
      ],
      note: t('AZW3 already covers every Kindle since 2011.'),
      stages: {
        packages: [
          t('Wine, from WineHQ'),
          t("Debian's Wine crashes the Previewer, so this takes WineHQ's build."),
        ],
        download: [
          t("Amazon's Kindle Previewer"),
          t('Fetched at your instruction — not ours to redistribute.'),
        ],
        prefix: [t('The Wine prefix'), t('A Windows filesystem for it to live in.')],
        previewer: [t('Installing the Previewer'), t('Run silently against a virtual screen.')],
        wire: [
          t('Wiring it to calibre'),
          t('Registry key, ~/.wine link, and a wrapper that brings a screen.'),
        ],
        verify: [t('Checking it took'), t('Plugin and Previewer both have to answer.')],
      },
    },
  }

  const REMOVE_ORDER = ['previewer', 'wire', 'install', 'packages', 'verify']

  const state = {
    list: [],
    open: null,
    stages: [],
    run: 'idle',
    kind: null,
    pending: false,
    busy: false,
    offset: 0,
    following: true,
    polling: false,
    opened: 1,
    pinned: false,
    removedShown: false,
    pendingAction: null,
  }

  async function send(url, options = {}) {
    try {
      const headers = await csrfHeaders(options.headers || {})
      const res = await fetch(url, { ...options, cache: 'no-store', headers })
      let data = null
      try {
        data = await res.json()
      } catch {}
      return { ok: res.ok, status: res.status, data }
    } catch {
      return { ok: false, status: 0, data: null }
    }
  }

  function notice(title, text) {
    $('noticeTitle').textContent = title
    $('noticeText').textContent = text
    $('noticeModal').hidden = false
  }

  const about = (id) => ABOUT[id] ?? { unlocks: '', cost: [], note: '', stages: {} }
  const entry = (id) => state.list.find((one) => one.id === id)

  function statusWords(one) {
    if (one.pending) return t('Working…')
    if (one.installed) return t('Installed')
    if (one.blocked) return one.blocked
    return t('Not installed')
  }

  function renderList() {
    $('extList').innerHTML = state.list
      .map((one) => {
        const disabled = state.busy || Boolean(one.blocked)
        const cls = one.installed ? 'is-on' : one.blocked ? 'is-blocked' : ''
        const act = one.installed ? 'remove' : 'install'
        return `
        <button type="button" class="ext ${cls}" data-act="${act}" data-id="${one.id}"
                aria-pressed="${one.installed}" ${disabled ? 'disabled' : ''}>
          <span class="ext__body">
            <span class="ext__name">${t(one.label)}</span>
            <span class="ext__what">${t('Adds {what}', { what: about(one.id).unlocks })}</span>
          </span>
          <span class="ext__state">${statusWords(one)}</span>
          <span class="toggle${one.installed ? ' is-on' : ''}"><span class="toggle__knob"></span></span>
        </button>`
      })
      .join('')
  }

  function buildRun() {
    if (!state.open) return
    const words = about(state.open).stages

    $('stack').innerHTML = state.stages
      .map((stage, index) => {
        const [title, note] = words[stage.name] ?? [stage.name, '']
        const n = index + 1
        return `
        <div class="step install-step" id="step${n}" hidden>
          <div class="step__badge" id="badge${n}">${n}</div>
          <div class="step__body">
            <div class="install-step__head">
              <div class="step__title">${title}</div>
              <div class="install-step__pct" id="pct${n}"></div>
            </div>
            <p class="field-note field-note--wide">${note}</p>
            <p class="install-step__detail" id="detail${n}" hidden></p>
          </div>
        </div>
        <button type="button" class="step step--summary" id="step${n}Summary" hidden>
          <span class="step__badge" id="badge${n}Summary">${n}</span>
          <span class="step__summary-body">
            <span class="step__summary-title">${title}</span>
            <span class="step__summary-value" id="step${n}Value"></span>
          </span>
          <span class="step__summary-action" id="pct${n}Summary"></span>
        </button>
        <div class="step__rule"></div>`
      })
      .join('')

    $('rail').innerHTML = state.stages
      .map(
        (stage, index) =>
          `<button type="button" class="step-rail__dot" data-step="${index + 1}" role="tab" aria-label="${stage.name}"></button>`
      )
      .join('')
      .concat(
        `<button type="button" class="step-rail__dot" data-step="${outStep()}" role="tab" aria-label="output"></button>`
      )

    $('outSummaryBadge').textContent = String(outStep())

    for (const [index] of state.stages.entries()) {
      const n = index + 1
      page.on($(`step${n}Summary`), 'click', () => goToStep(n))
    }
    for (const dot of document.querySelectorAll('.step-rail__dot')) {
      page.on(dot, 'click', () => goToStep(Number(dot.dataset.step)))
    }
  }

  function outStep() {
    return state.stages.length + 1
  }

  function goToStep(n) {
    state.opened = Math.min(outStep(), Math.max(1, n))
    state.pinned = true
    render()
  }

  function liveStep() {
    const running = state.stages.findIndex((stage) => stage.state === 'running')
    if (running !== -1) return running + 1
    const failed = state.stages.findIndex((stage) => stage.state === 'failed')
    if (failed !== -1) return failed + 1
    return state.opened
  }

  function paintBadge(el, stage, position) {
    if (!el) return
    if (stage.state === 'done') {
      el.className = 'step__badge is-complete'
      el.textContent = '✓'
      return
    }
    if (stage.state === 'failed') {
      el.className = 'step__badge step__badge--lost'
      el.textContent = '✕'
      return
    }
    if (stage.state === 'running') {
      el.className = 'step__badge is-current step__badge--spin'
      el.textContent = ''
      return
    }
    el.className = 'step__badge'
    el.textContent = String(position + 1)
  }

  function stageWords(stage) {
    if (stage.state === 'done') return t('Done')
    if (stage.state === 'failed') return stage.detail || t('Failed')
    if (stage.state === 'running') return stage.percent === null ? t('Working') : `${stage.percent}%`
    return state.run === 'idle' ? t('Not started') : t('Waiting')
  }

  function render() {
    renderList()

    const one = state.open ? entry(state.open) : null
    $('run').hidden = !state.open || state.run === 'idle'
    if (!state.open || !$('step1')) return

    const removing = state.kind === 'remove'
    if (!state.pinned) state.opened = liveStep()
    const outOpen = state.opened === outStep() && state.run !== 'idle'

    const shownStage = (stage) => !removing || stage.state !== 'waiting'

    state.stages.forEach((stage, index) => {
      const n = index + 1
      const shown = shownStage(stage)
      const open = shown && n === state.opened
      const row = $(`step${n}`)
      const summary = $(`step${n}Summary`)
      const rule = summary?.nextElementSibling
      if (!row || !summary) return

      const ordered = REMOVE_ORDER.indexOf(stage.name)
      const position = removing && ordered !== -1 ? ordered : index
      for (const el of [row, summary, rule]) if (el) el.style.order = String(position)

      row.hidden = !open
      summary.hidden = !shown || open
      if (rule) rule.hidden = !shown

      const dot = document.querySelector(`.step-rail__dot[data-step="${n}"]`)
      if (dot) {
        dot.hidden = !shown
        dot.style.order = String(position)
        dot.classList.toggle('is-current', open)
        dot.classList.toggle('is-done', !open && stage.state === 'done')
        dot.classList.toggle('is-lost', stage.state === 'failed')
      }
      if (!shown) return

      paintBadge($(`badge${n}`), stage, position)
      paintBadge($(`badge${n}Summary`), stage, position)

      $(`step${n}Value`).textContent = stageWords(stage)
      $(`pct${n}`).textContent = stage.percent === null ? '' : `${stage.percent}%`
      $(`pct${n}Summary`).textContent = stage.percent === null ? '' : `${stage.percent}%`

      const detail = $(`detail${n}`)
      detail.textContent = stage.detail
      detail.hidden = !stage.detail
      detail.classList.toggle('is-error', stage.state === 'failed')
    })

    $('outWrap').hidden = !outOpen
    $('outSummary').hidden = state.run === 'idle' || outOpen
    $('outRule').hidden = state.run === 'idle' || outOpen
    $('run').classList.toggle('is-out-open', outOpen)

    const outDot = document.querySelector(`.step-rail__dot[data-step="${outStep()}"]`)
    if (outDot) outDot.classList.toggle('is-current', outOpen)

    const busy = state.run === 'running' || state.pending
    const failed = state.run === 'failed'
    const finished = Boolean(one?.installed) && !busy && state.kind === 'install'
    const removed = removing && state.run === 'done' && !busy

    $('doneBox').hidden = !finished && !failed
    $('doneBox').classList.toggle('is-ok', !failed)
    $('doneBox').classList.toggle('is-error', failed)
    if (failed) {
      $('doneTitle').textContent = t('It did not finish')
      $('doneMeta').textContent = t('THE OUTPUT SAYS WHERE IT STOPPED')
    } else if (finished) {
      $('doneTitle').textContent = t('{label} is ready', { label: t(one?.label ?? '') })
      $('doneMeta').textContent = t('NO RESTART NEEDED')
    }

    if (removed && !state.removedShown) {
      state.removedShown = true
      $('removedText').textContent = t('{label} is gone and the space is back.', {
        label: t(one?.label ?? ''),
      })
      $('removedModal').hidden = false
    }

    if (outOpen && state.following) $('out').scrollTop = $('out').scrollHeight
  }

  async function refreshList() {
    const result = await send('/api/admin/extensions')
    if (gone() || !result.ok || !result.data) return
    state.list = result.data.extensions
    state.busy = result.data.busy
  }

  function openRun(id, stages) {
    state.open = id
    state.stages = stages
    state.offset = 0
    state.pinned = false
    state.removedShown = false
    $('out').textContent = ''
    buildRun()
  }

  async function poll() {
    if (state.polling || gone() || !state.open) return
    state.polling = true
    const result = await send(`/api/admin/extensions/${state.open}/progress?from=${state.offset}`)
    state.polling = false
    if (gone() || !result.ok || !result.data) return

    const grew = result.data.stages.length !== state.stages.length
    state.stages = result.data.stages
    state.run = result.data.state
    state.kind = result.data.kind
    state.pending = result.data.pending
    if (grew || $('stack').childElementCount === 0) buildRun()

    if (result.data.chunk) {
      $('out').textContent += result.data.chunk
      if (state.following) $('out').scrollTop = $('out').scrollHeight
    }
    state.offset = result.data.offset

    await refreshList()
    render()
  }

  async function start(id, method) {
    const result = await send(`/api/admin/extensions/${id}`, { method })
    if (gone()) return
    if (!result.ok) {
      notice(
        method === 'POST' ? t('Not started') : t('Not removed'),
        result.data?.error || t('The server refused.')
      )
      return
    }
    const one = entry(id)
    openRun(
      id,
      (one?.stages ?? []).map((stage) => ({ ...stage, state: 'waiting', percent: null, detail: '' }))
    )
    state.pending = true
    state.run = 'running'
    render()
    void poll()
  }

  $('extList').addEventListener('click', (event) => {
    const button = event.target.closest('button.ext[data-act]')
    if (!button || button.disabled) return

    const id = button.dataset.id
    const one = entry(id)
    if (!one) return

    state.pendingAction = { id, act: button.dataset.act }

    if (button.dataset.act === 'install') {
      const info = about(id)
      $('costTitle').textContent = t('What installing {label} costs', { label: t(one.label) })
      $('costList').innerHTML = info.cost
        .map(
          ([figure, what]) =>
            `<li class="cost__item"><span class="cost__figure">${figure}</span><span class="cost__what">${what}</span></li>`
        )
        .join('')
      $('costNote').textContent = info.note
      $('costModal').hidden = false
      return
    }

    $('confirmTitle').textContent = t('Remove {label}?', { label: t(one.label) })
    $('confirmText').textContent = t('Deleted from the volume; {what} is refused again.', {
      what: about(id).unlocks,
    })
    $('confirmCost').textContent = t('Putting it back means downloading it again.')
    $('confirmModal').hidden = false
  })

  $('costCancel').addEventListener('click', () => {
    $('costModal').hidden = true
  })

  $('costGo').addEventListener('click', async () => {
    $('costModal').hidden = true
    if (state.pendingAction) await start(state.pendingAction.id, 'POST')
  })

  $('confirmCancel').addEventListener('click', () => {
    $('confirmModal').hidden = true
  })

  $('confirmGo').addEventListener('click', async () => {
    $('confirmModal').hidden = true
    if (state.pendingAction) await start(state.pendingAction.id, 'DELETE')
  })

  $('removedOk').addEventListener('click', async () => {
    $('removedModal').hidden = true
    if (state.open) await send(`/api/admin/extensions/${state.open}/progress`, { method: 'DELETE' })
    if (gone()) return
    state.run = 'idle'
    state.kind = null
    state.open = null
    state.removedShown = false
    $('out').textContent = ''
    await refreshList()
    render()
  })

  $('noticeOk').addEventListener('click', () => {
    $('noticeModal').hidden = true
  })

  $('outSummary').addEventListener('click', () => goToStep(outStep()))

  $('followBtn').addEventListener('click', () => {
    state.following = !state.following
    $('followBtn').textContent = state.following ? t('Following') : t('Paused')
    if (state.following) $('out').scrollTop = $('out').scrollHeight
  })

  page.on($('out'), 'scroll', () => {
    const out = $('out')
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 24
    if (state.following !== atBottom) {
      state.following = atBottom
      $('followBtn').textContent = atBottom ? t('Following') : t('Paused')
    }
  })

  await refreshList()
  if (gone()) return

  const active = state.list.find((one) => one.pending || one.state === 'running')
  const recent = active ?? state.list.find((one) => one.state !== 'idle')
  if (recent) {
    openRun(recent.id, recent.stages)
    state.run = recent.state
    state.kind = recent.kind
    state.pending = recent.pending
    await poll()
  }
  render()

  page.every(POLL_MS, () => {
    if (state.run === 'running' || state.pending || state.busy) void poll()
  })
})
