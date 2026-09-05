'use strict'

onPage('setup-wizard', async (page) => {
  const $ = (id) => document.getElementById(id)
  const gone = () => !page.alive

  const STEPS = [1, 2, 3, 4, 5, 6]

  const state = {
    opened: 1,
    reached: 1,
    values: {},
    secretSet: {},
    canRestart: false,
    runningAddress: '',
    schemeTouched: false,
  }

  async function send(url, options = {}) {
    try {
      const headers = await csrfHeaders(options.headers)
      const res = await fetch(url, { credentials: 'same-origin', ...options, headers })
      let data = null
      try {
        data = await res.json()
      } catch {
      }
      return { ok: res.ok, status: res.status, data }
    } catch {
      return { ok: false, status: 0, data: null }
    }
  }

  const asJson = (body) => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  function notice(title, text) {
    $('noticeTitle').textContent = title
    $('noticeText').textContent = text
    $('noticeModal').hidden = false
    $('noticeOk').focus()
  }

  $('noticeOk').addEventListener('click', () => {
    $('noticeModal').hidden = true
  })

  const controls = [...document.querySelectorAll('[data-key]')]
  const toggles = controls.filter((el) => el.hasAttribute('data-toggle'))
  const fields = controls.filter((el) => !el.hasAttribute('data-toggle'))

  const extToggles = [...document.querySelectorAll('[data-ext]')]
  const wanted = new Set()
  const EXT_ORDER = ['calibre', 'pdfcrop', 'kfx']
  const EXT_LABEL = { calibre: 'calibre', pdfcrop: 'PDF cropping', kfx: 'KFX' }

  const on = (key) => state.values[key] === 'true'

  for (const el of fields) el.dataset.blank = el.placeholder ?? ''

  function paint() {
    for (const el of fields) {
      el.value = state.values[el.dataset.key] ?? ''

      if (el.type === 'password') {
        el.placeholder = state.secretSet[el.dataset.key] ? '••••••••••••' : el.dataset.blank
      }
    }
    for (const el of toggles) {
      el.querySelector('.toggle').classList.toggle('is-on', on(el.dataset.key))
    }
    paintExtensions()
    $('mailFields').hidden = !on('SMTP_ENABLED')
    $('ssoFields').hidden = !on('OIDC_ENABLED')
    $('ssoRedirect').textContent =
      `The redirect your provider needs on file is ${addressNow()}/auth/sso/callback.`
    renderSummaries()
  }

  // Ticking nothing and not having answered look the same, so the step is only
  // passable once one of them is on — including the one that says "nothing".
  function paintExtensions() {
    const kfxNeedsCalibre = wanted.has('kfx') && !wanted.has('calibre')
    if (kfxNeedsCalibre) wanted.add('calibre')

    for (const el of extToggles) {
      el.querySelector('.toggle').classList.toggle('is-on', wanted.has(el.dataset.ext))
    }
    $('wizKfxDesc').textContent = wanted.has('kfx')
      ? 'The format a modern Kindle prefers. calibre is ticked too, because KFX cannot work without it. Amazon\u2019s Kindle Previewer runs under Wine here. About 3GB and up to twenty minutes.'
      : 'The format a modern Kindle prefers. Needs calibre, and Amazon\u2019s Kindle Previewer running under Wine. About 3GB and up to twenty minutes.'

    $('extNext').disabled = wanted.size === 0
  }

  for (const el of extToggles) {
    el.addEventListener('click', () => {
      const id = el.dataset.ext
      if (id === 'none') {
        wanted.clear()
        wanted.add('none')
      } else {
        wanted.delete('none')
        if (wanted.has(id)) {
          wanted.delete(id)
          if (id === 'calibre') wanted.delete('kfx')
        } else {
          wanted.add(id)
        }
      }
      paintExtensions()
      renderSummaries()
    })
  }

  // Asked for, not waited for: calibre alone is minutes, and KFX can be twenty.
  // The queue keeps them in order and the Converters page shows the progress.
  async function askForExtensions() {
    const asked = EXT_ORDER.filter((id) => wanted.has(id))
    if (asked.length === 0) return true

    for (const id of asked) {
      const result = await send(`/api/admin/extensions/${id}`, { method: 'POST' })
      if (!result.ok && result.status !== 409) {
        notice('Not started', result.data?.error || `The server would not fetch ${EXT_LABEL[id]}.`)
        return false
      }
    }
    return true
  }

  function addressNow() {
    const domain = ($('wizDomain').value || '').trim()
    if (!domain) return state.runningAddress
    return `${$('wizProtocol').value || 'http'}://${domain}`
  }

  function schemeFor(host) {
    const bare = host.trim().replace(/^\[|\]$/g, '')
    if (!bare) return null
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return 'http'
    if (bare.includes(':')) return 'http'
    if (!bare.includes('.')) return 'http'
    return 'https'
  }

  $('wizProtocol').addEventListener('change', () => {
    state.schemeTouched = true
  })

  $('wizDomain').addEventListener('input', () => {
    if (!state.schemeTouched) {
      const guess = schemeFor($('wizDomain').value)
      if (guess) $('wizProtocol').value = guess
    }
    $('addressHint').textContent = hintForAddress()
  })

  function hintForAddress() {
    const domain = ($('wizDomain').value || '').trim()
    if (!domain) {
      return 'A name, not an address and not a URL. Leave it empty on a laptop and the server calls itself by its listen address.'
    }
    if (schemeFor(domain) === 'http') {
      return 'That is an address, not a name. It works, but no browser will hold a passkey for it, whatever certificate is on it.'
    }
    return `Links will read ${$('wizProtocol').value}://${domain}. Passkeys will work if that is served over https.`
  }

  const SECURITY_PORT = { starttls: '587', ssl: '465', none: '25' }
  const CONVENTIONAL = ['25', '465', '587']

  $('wizSmtpSecurity').addEventListener('change', () => {
    const wanted = SECURITY_PORT[$('wizSmtpSecurity').value]
    if (wanted && CONVENTIONAL.includes($('wizSmtpPort').value)) $('wizSmtpPort').value = wanted
  })

  for (const el of toggles) {
    el.addEventListener('click', async () => {
      const key = el.dataset.key
      const next = on(key) ? 'false' : 'true'
      const saved = await put(key, next)
      if (gone()) return
      if (!saved) return
      state.values[key] = next
      paint()
    })
  }

  async function put(key, value) {
    const result = await send('/api/admin/settings', {
      method: 'PUT',
      ...asJson({ key, value }),
    })
    if (result.ok) {
      state.values[key] = value
      return true
    }
    notice('Not saved', result.data?.error || `The server refused ${key}.`)
    return false
  }

  async function saveStep(n) {
    if (n === 5) return await askForExtensions()

    const step = $(`step${n}`)
    const msg = $(`msg${n}`)
    msg.className = 'save-row__msg'
    msg.textContent = ''

    for (const el of step.querySelectorAll('[data-key]:not([data-toggle])')) {
      const key = el.dataset.key
      const value = el.value.trim()

      if (el.type === 'password' && value === '') continue
      if (value === (state.values[key] ?? '')) continue
      if (!(await put(key, value))) {
        msg.classList.add('is-error')
        msg.textContent = 'Nothing past this point was saved.'
        return false
      }
      if (gone()) return false
    }
    return true
  }

  $('mailTest').addEventListener('click', async () => {
    if (!(await saveStep(2))) return
    if (gone()) return

    const msg = $('mailTestMsg')
    msg.className = 'save-row__msg'
    msg.textContent = 'Sending…'

    const result = await send('/api/setup/mail/test', { method: 'POST' })
    if (gone()) return

    if (!result.ok) {
      msg.classList.add('is-error')
      msg.textContent = result.data?.error || 'It would not go out.'
      return
    }
    msg.classList.add('is-ok')
    msg.textContent = `Sent to ${result.data.to}. If it arrives, mail works.`
  })

  $('ssoTest').addEventListener('click', async () => {
    if (!(await saveStep(3))) return
    if (gone()) return

    const msg = $('ssoTestMsg')
    msg.className = 'save-row__msg'
    msg.textContent = 'Asking…'

    const result = await send('/api/setup/sso/test', { method: 'POST' })
    if (gone()) return

    if (!result.ok) {
      msg.classList.add('is-error')
      msg.textContent = result.data?.error || 'It did not answer.'
      return
    }
    msg.classList.add('is-ok')
    msg.textContent = result.data.clientIdSet
      ? `${result.data.issuer} answered. Give it the redirect below and it is done.`
      : `${result.data.issuer} answered, but there is no client ID here yet.`
  })

  for (const button of document.querySelectorAll('[data-next]')) {
    button.addEventListener('click', async () => {
      const n = Number(button.dataset.next)
      button.disabled = true
      const saved = await saveStep(n)
      if (gone()) return
      button.disabled = false
      if (!saved) return

      state.reached = Math.max(state.reached, n + 1)
      goToStep(n + 1)
    })
  }

  const openBody = () => $(`step${state.opened}`)?.querySelector('.step__body') ?? null

  const SWITCH_PAUSE_MS = 500
  let lastSwitch = 0

  page.on(
    document.querySelector('.step-card'),
    'wheel',
    (event) => {
      const body = openBody()
      if (!body) return

      const way = Math.sign(event.deltaY)
      if (way === 0) return

      const room = body.scrollHeight - body.clientHeight
      const atEnd = way > 0 ? body.scrollTop >= room - 1 : body.scrollTop <= 0

      if (room > 1 && !atEnd) {
        lastSwitch = 0
        if (body.contains(event.target)) return
        body.scrollTop += event.deltaY
        event.preventDefault()
        return
      }

      const next = state.opened + way
      if (next < 1 || next > STEPS.length) return

      event.preventDefault()
      const now = Date.now()
      if (now - lastSwitch < SWITCH_PAUSE_MS) return
      lastSwitch = now
      void leaveFor(next)
    },
    { passive: false }
  )

  async function leaveFor(n) {
    const from = state.opened
    if (n === from) return
    if (!(await saveStep(from))) return
    if (gone()) return

    goToStep(n)
    if (n < from) {
      const body = openBody()
      if (body) body.scrollTop = body.scrollHeight
    }
  }

  function goToStep(n) {
    state.opened = Math.min(STEPS.length, Math.max(1, n))
    render()

    const body = $(`step${state.opened}`).querySelector('.step__body')
    if (body) body.scrollTop = 0
    window.scrollTo(0, 0)
  }

  for (const n of STEPS) {
    $(`step${n}Summary`).addEventListener('click', () => void leaveFor(n))
    document.querySelector(`.step-rail__dot[data-step="${n}"]`).addEventListener('click', () => {
      void leaveFor(n)
    })
  }

  function badge(el, done, current, text) {
    el.className = `step__badge${done ? ' is-complete' : current ? ' is-current' : ''}`
    el.textContent = done ? '✓' : text
  }

  const VALUES = {
    1: () => {
      const domain = state.values.DOMAIN
      return domain ? `${state.values.PROTOCOL}://${domain}` : 'The listen address'
    },
    2: () => {
      if (!on('SMTP_ENABLED')) return 'Off — messages go to the log'
      const host = state.values.SMTP_HOST
      return host ? `${host}:${state.values.SMTP_PORT}` : 'On, but no server given yet'
    },
    3: () => (on('OIDC_ENABLED') ? state.values.OIDC_PROVIDER_NAME || 'On' : 'Off'),
    4: () =>
      `${on('ALLOW_SIGNUP') ? 'Anyone may sign up' : 'Closed'} · at least ${state.values.MIN_PASSWORD_LENGTH} characters`,
    5: () => {
      const asked = EXT_ORDER.filter((id) => wanted.has(id))
      if (asked.length > 0) return `Fetching ${asked.map((id) => EXT_LABEL[id]).join(', ')}`
      return wanted.has('none') ? 'EPUB and KEPUB only' : 'Not answered yet'
    },
    6: () => 'Not finished yet',
  }

  function renderSummaries() {
    for (const n of STEPS) $(`step${n}Value`).textContent = VALUES[n]()
  }

  function render() {
    for (const n of STEPS) {
      const open = state.opened === n
      $(`step${n}`).hidden = !open
      $(`step${n}Summary`).hidden = open
      badge($(`badge${n}`), false, true, String(n))
      badge($(`badge${n}Summary`), n < state.reached, false, String(n))
    }

    for (const dot of document.querySelectorAll('.step-rail__dot')) {
      const n = Number(dot.dataset.step)
      dot.classList.toggle('is-current', n === state.opened)
      dot.classList.toggle('is-done', n !== state.opened && n < state.reached)
      dot.setAttribute('aria-selected', String(n === state.opened))
    }

    renderSummaries()
    renderFinish()
  }

  function renderFinish() {
    const moved = addressNow() !== state.runningAddress
    $('finishPending').hidden = !moved
    $('finishPendingMeta').textContent = moved
      ? `STILL ANSWERING AS ${state.runningAddress.toUpperCase()}`
      : ''

    $('finishText').textContent = state.canRestart
      ? moved
        ? 'The address is the one thing that cannot change under a running server: the cookie flags and the security headers were settled at boot. Everything else you set is already live. Restarting takes a few seconds and Docker brings it straight back.'
        : 'Everything you set is already live, and nothing here is waiting on anything. Finishing restarts the server once anyway, so it comes up exactly as it will run from now on.'
      : 'Everything you set is saved, and all of it is live except the address, which is settled when the server starts.'

    $('finishManual').hidden = state.canRestart
    $('finishGo').textContent = state.canRestart ? 'Restart and finish' : 'Finish'
  }

  async function waitForTheServer() {
    const started = Date.now()
    while (page.alive && Date.now() - started < 120000) {
      await new Promise((r) => page.after(1500, r))
      if (!page.alive) return
      try {
        const res = await fetch('/healthz', { cache: 'no-store' })
        if (res.ok) {
          window.location.href = '/'
          return
        }
      } catch {
      }
    }
    if (!page.alive) return
    $('msg6').classList.add('is-error')
    $('msg6').textContent = 'It has not come back. Check the container.'
  }

  $('finishGo').addEventListener('click', async () => {
    $('finishGo').disabled = true

    const done = await send('/api/setup/complete', { method: 'POST' })
    if (gone()) return
    if (!done.ok) {
      $('finishGo').disabled = false
      notice('Not saved', 'The server would not record that setup is finished. Try again.')
      return
    }

    if (!state.canRestart) {
      window.location.href = '/'
      return
    }

    const result = await send('/api/admin/restart', { method: 'POST' })
    if (gone()) return
    if (!result.ok) {
      $('finishGo').disabled = false
      notice('Not restarted', result.data?.error || 'The server refused.')
      return
    }

    $('msg6').textContent = 'Restarting…'
    void waitForTheServer()
  })

  const [setup, config] = await Promise.all([send('/api/setup'), send('/api/admin/settings')])
  if (gone()) return

  if (!setup.ok || !config.ok) {
    notice('That did not load', 'The server would not hand over its settings. Try reloading.')
    return
  }

  state.canRestart = setup.data.canRestart === true
  state.runningAddress = setup.data.runningAddress || ''
  for (const spec of config.data.settings) {
    state.values[spec.key] = spec.kind === 'secret' ? '' : spec.value
    if (spec.kind === 'secret') state.secretSet[spec.key] = spec.isSet === true
  }

  state.schemeTouched = Boolean(state.values.DOMAIN)

  paint()
  $('addressHint').textContent = hintForAddress()
  render()
})
