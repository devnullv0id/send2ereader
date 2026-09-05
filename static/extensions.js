/* global onPage, csrfHeaders */

onPage('extensions', async (page) => {
  const $ = (id) => document.getElementById(id)
  const gone = () => !page.alive
  const POLL_MS = 1000

  // What each extension is for, what it costs, and what every stage of its
  // install is doing. The server owns the stage names; this owns the words.
  const ABOUT = {
    calibre: {
      unlocks: 'MOBI, AZW3, PDF, TXT and HTMLZ, and reading KFX',
      cost: [
        ['~150MB', 'downloaded from calibre-ebook.com, once'],
        ['550MB', 'on the data volume, kept when the container is recreated'],
        ['~10 min', 'depending on the connection'],
      ],
      note: 'Everything Kindle-shaped goes through calibre. Without it this server still sends EPUB and makes KEPUB for a Kobo, but converts nothing else.',
      stages: {
        packages: ['The libraries it needs', 'Qt, fonts, and the X libraries its PDF renderer loads.'],
        download: ['calibre itself', 'From calibre-ebook.com, the version they publish today.'],
        install: [
          'Unpacking it',
          'Into the data volume rather than the container, so recreating the container does not fetch it again.',
        ],
        plugins: [
          'The KFX plugins',
          'Registering KFX Input and Output with calibre. Input works at once; Output waits for the Previewer.',
        ],
        verify: [
          'Checking it took',
          'ebook-convert is asked its version, and the Convert page opens up when it answers.',
        ],
      },
    },
    pdfcrop: {
      unlocks: 'trimming the white border off a PDF',
      cost: [
        ['~90MB', 'on the data volume'],
        ['~2 min', 'mostly PyMuPDF'],
      ],
      note: 'Only ever used on a PDF, and only when you tick the box. Everything else is unaffected.',
      stages: {
        packages: [
          'Python and its venv module',
          'The server already ships Python; this makes sure the venv module is there.',
        ],
        install: [
          'pdfCropMargins',
          'Installed into the data volume with pip, so it survives the container being recreated.',
        ],
        verify: [
          'Checking it took',
          'It is asked its version, and the crop option lights up when it answers.',
        ],
      },
    },
    kfx: {
      unlocks: 'writing KFX, the newest Kindle format',
      cost: [
        ['356MB', 'downloaded from Amazon, once, then deleted'],
        ['2.6GB', 'Wine prefix, kept on the data volume'],
        ['1.7GB', 'Wine packages in the container'],
        ['~920MB', 'memory while a KFX conversion runs'],
      ],
      note: 'Every Kindle since 2011 reads AZW3, which calibre writes on its own. KFX is only worth this if you specifically need it.',
      stages: {
        packages: [
          'Wine, from WineHQ',
          "Debian ships Wine 10 and the Previewer crashes on it, so this takes WineHQ's build, with the X libraries its display driver needs.",
        ],
        download: [
          "Amazon's Kindle Previewer",
          'Fetched from Amazon by this machine, at your instruction — it is not ours to redistribute. The slow part.',
        ],
        prefix: [
          'The Wine prefix',
          'A Windows filesystem for it to live in, with the mono and gecko prompts turned off so nothing waits for a click.',
        ],
        previewer: [
          'Installing the Previewer',
          'Run silently against a virtual screen, as the user that will later run it.',
        ],
        wire: [
          'Wiring it to calibre',
          'The registry key, the ~/.wine link, and a wrapper so plain wine brings its own screen.',
        ],
        verify: [
          'Checking it took',
          'Both the plugin and the Previewer have to answer before KFX is offered.',
        ],
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
    if (one.pending) return 'Working…'
    if (one.installed) return 'Installed'
    if (one.blocked) return one.blocked
    return 'Not installed'
  }

  function renderList() {
    $('extList').innerHTML = state.list
      .map((one) => {
        const disabled = state.busy || Boolean(one.blocked)
        const action = one.installed ? 'Remove' : 'Install'
        const cls = one.installed ? 'is-on' : one.blocked ? 'is-blocked' : ''
        return `
        <div class="ext ${cls}">
          <div class="ext__body">
            <div class="ext__name">${one.label}</div>
            <div class="ext__what">Adds ${about(one.id).unlocks}</div>
          </div>
          <div class="ext__state">${statusWords(one)}</div>
          <button type="button" class="btn btn--sm ${one.installed ? 'btn--err' : 'btn--primary'}"
                  data-act="${action.toLowerCase()}" data-id="${one.id}"
                  ${disabled ? 'disabled' : ''}>${action}</button>
        </div>`
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

    for (const [index] of state.stages.entries()) {
      const n = index + 1
      page.on($(`step${n}Summary`), 'click', () => goToStep(n))
    }
    for (const dot of document.querySelectorAll('.step-rail__dot')) {
      page.on(dot, 'click', () => goToStep(Number(dot.dataset.step)))
    }
  }

  function goToStep(n) {
    state.opened = Math.min(state.stages.length, Math.max(1, n))
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

  // A tick means that stage finished. Anything still going gets the spinner, and
  // a stage nobody has reached yet keeps its number.
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
    if (stage.state === 'done') return 'Done'
    if (stage.state === 'failed') return stage.detail || 'Failed'
    if (stage.state === 'running') return stage.percent === null ? 'Working' : `${stage.percent}%`
    return state.run === 'idle' ? 'Not started' : 'Waiting'
  }

  function render() {
    renderList()

    const one = state.open ? entry(state.open) : null
    $('run').hidden = !state.open || state.run === 'idle'
    if (!state.open || !$('step1')) return

    const removing = state.kind === 'remove'
    if (!state.pinned) state.opened = liveStep()

    // A removal runs in a different order from an install and touches fewer
    // stages: a spinner sitting above two finished rows reads as broken.
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

    $('outWrap').hidden = state.run === 'idle'

    const busy = state.run === 'running' || state.pending
    const failed = state.run === 'failed'
    const finished = Boolean(one?.installed) && !busy && state.kind === 'install'
    const removed = removing && state.run === 'done' && !busy

    $('doneBox').hidden = !finished && !failed
    $('doneBox').classList.toggle('is-ok', !failed)
    $('doneBox').classList.toggle('is-error', failed)
    if (failed) {
      $('doneTitle').textContent = 'It did not finish'
      $('doneMeta').textContent = 'THE OUTPUT SAYS WHERE IT STOPPED'
    } else if (finished) {
      $('doneTitle').textContent = `${one?.label} is ready`
      $('doneMeta').textContent = 'NO RESTART NEEDED'
    }

    if (removed && !state.removedShown) {
      state.removedShown = true
      $('removedText').textContent = `${one?.label} is gone and the space it took is back. You can install it again whenever you like.`
      $('removedModal').hidden = false
    }
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
        method === 'POST' ? 'Not started' : 'Not removed',
        result.data?.error || 'The server refused.'
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
    const button = event.target.closest('button[data-act]')
    if (!button) return

    const id = button.dataset.id
    const one = entry(id)
    if (!one) return

    state.pendingAction = { id, act: button.dataset.act }

    if (button.dataset.act === 'install') {
      const info = about(id)
      $('costTitle').textContent = `What installing ${one.label} costs`
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

    $('confirmTitle').textContent = `Remove ${one.label}?`
    $('confirmText').textContent = `This deletes it from the data volume and from the container. ${one.label} adds ${about(id).unlocks}, and those options go back to being refused.`
    $('confirmCost').textContent = 'Putting it back means downloading it again.'
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

  $('followBtn').addEventListener('click', () => {
    state.following = !state.following
    $('followBtn').textContent = state.following ? 'Following' : 'Paused'
    if (state.following) $('out').scrollTop = $('out').scrollHeight
  })

  page.on($('out'), 'scroll', () => {
    const out = $('out')
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 24
    if (state.following !== atBottom) {
      state.following = atBottom
      $('followBtn').textContent = atBottom ? 'Following' : 'Paused'
    }
  })

  await refreshList()
  if (gone()) return

  // Something already running, or a run that finished while nobody was looking.
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
