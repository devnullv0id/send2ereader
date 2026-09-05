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
    proxyOn: false,
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
  const already = new Map()
  const EXT_ORDER = ['calibre', 'pdfcrop', 'kfx']
  const EXT_LABEL = { calibre: 'calibre', pdfcrop: t('PDF cropping'), kfx: 'KFX' }
  const settled = (id) => already.has(id)

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
    $('wizProxyToggle').querySelector('.toggle').classList.toggle('is-on', state.proxyOn)
    $('proxyFields').hidden = !state.proxyOn
    $('mailFields').hidden = !on('SMTP_ENABLED')
    $('ssoFields').hidden = !on('OIDC_ENABLED')
    $('ssoRedirect').textContent = t('The redirect your provider needs on file is {url}.', {
      url: `${addressNow()}/auth/sso/callback`,
    })
    renderSummaries()
  }

  function paintExtensions() {
    const kfxNeedsCalibre = wanted.has('kfx') && !wanted.has('calibre') && !settled('calibre')
    if (kfxNeedsCalibre) wanted.add('calibre')

    for (const el of extToggles) {
      const id = el.dataset.ext
      const here = already.get(id)
      el.querySelector('.toggle').classList.toggle('is-on', wanted.has(id) || Boolean(here))
      el.disabled = id === 'none' ? already.size > 0 : Boolean(here) || state.agentless

      const mark = el.querySelector('[data-ext-mark]')
      if (mark) {
        mark.textContent = here === 'pending' ? t('INSTALLING NOW') : here ? t('INSTALLED') : ''
        mark.hidden = !here
      }
    }

    $('wizNoneDesc').textContent = state.agentless
      ? t('Only the Docker image can install converters; this server runs without it.')
      : already.size > 0
        ? t('Something is installed already; removing is under Admin \u2192 Converters.')
        : t('EPUB and KEPUB only; install any of these later.')

    $('wizKfxDesc').textContent =
      wanted.has('kfx') && wanted.has('calibre')
        ? t('The modern Kindle format. calibre is ticked too \u2014 KFX cannot work without it.')
        : t('The modern Kindle format. Needs calibre and Amazon\u2019s Previewer; about 3GB.')

    $('extNext').disabled = !state.agentless && wanted.size === 0 && already.size === 0
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

  async function askForExtensions() {
    const asked = EXT_ORDER.filter((id) => wanted.has(id) && !settled(id))
    if (asked.length === 0) return true

    for (const id of asked) {
      const result = await send(`/api/admin/extensions/${id}`, { method: 'POST' })
      if (!result.ok && result.status !== 409) {
        notice(
          t('Not started'),
          result.data?.error || t('The server would not fetch {label}.', { label: EXT_LABEL[id] })
        )
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
    const bare = host.trim().replace(/:\d{1,5}$/, '')
    if (!bare) return null
    if (/^\[.*\]$/.test(bare)) return 'http'
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return 'http'
    if (!bare.includes('.')) return 'http'
    return 'https'
  }

  function tidyDomain(typed) {
    const found = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(typed.trim())
    const scheme = found ? found[1].toLowerCase() : null
    const rest = (found ? found[2] : typed).trim()
    return {
      host: rest.split(/[/?#\\]/)[0],
      scheme: scheme === 'http' || scheme === 'https' ? scheme : null,
    }
  }

  $('wizProtocol').addEventListener('change', () => {
    state.schemeTouched = true
  })

  $('wizDomain').addEventListener('input', () => {
    const tidied = tidyDomain($('wizDomain').value)
    if (tidied.host !== $('wizDomain').value) $('wizDomain').value = tidied.host

    if (tidied.scheme) {
      $('wizProtocol').value = tidied.scheme
      state.schemeTouched = true
    } else if (!state.schemeTouched) {
      const guess = schemeFor($('wizDomain').value)
      if (guess) $('wizProtocol').value = guess
    }
    $('addressHint').textContent = hintForAddress()
  })

  const OFF_WORDS = ['', '0', 'false', 'no', 'off', 'none']
  const ON_WORDS = ['1', 'true', 'yes', 'on']

  $('wizProxyToggle').addEventListener('click', async () => {
    if (!state.proxyOn) {
      state.proxyOn = true
      paint()
      $('wizProxyAddr').focus()
      return
    }

    state.proxyOn = false
    $('wizProxyAddr').value = ''
    paint()
    if (!OFF_WORDS.includes((state.values.TRUST_PROXY ?? '').toLowerCase())) {
      await put('TRUST_PROXY', 'false')
    }
  })

  async function saveProxy(msg) {
    const typed = $('wizProxyAddr').value.trim()
    const value = state.proxyOn ? typed : 'false'

    if (state.proxyOn && typed === '') {
      msg.classList.add('is-error')
      msg.textContent = t("Give the proxy's address, or switch it off.")
      return false
    }
    if (value === (state.values.TRUST_PROXY ?? '')) return true
    return await put('TRUST_PROXY', value)
  }

  $('wizUseCurrent').addEventListener('click', () => {
    $('wizProtocol').value = location.protocol === 'https:' ? 'https' : 'http'
    $('wizDomain').value = location.host
    state.schemeTouched = true
    $('addressHint').textContent = hintForAddress()
  })

  // The relying party a passkey binds to is the host without the port, so a name with a port still holds one and an IP never does.
  function hintForAddress() {
    const domain = ($('wizDomain').value || '').trim()
    if (!domain) {
      return t('A name, not an address. Empty uses the listen address.')
    }

    const links = t('Links will read {address}.', {
      address: `${$('wizProtocol').value}://${domain}`,
    })
    if (domain.replace(/:\d{1,5}$/, '') === 'localhost') {
      return t('{links} Passkeys work — a browser trusts localhost without https.', { links })
    }
    if (schemeFor(domain) === 'http') {
      return t('{links} An address, not a name — no browser holds a passkey for it.', { links })
    }
    return $('wizProtocol').value === 'https'
      ? t('{links} Passkeys work once that is really served over https.', { links })
      : t('{links} Passkeys need https and stay unavailable on http.', { links })
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
    notice(t('Not saved'), result.data?.error || t('The server refused {key}.', { key }))
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
        msg.textContent = t('Nothing past this point was saved.')
        return false
      }
      if (gone()) return false
    }

    if (n === 1) return await saveProxy(msg)
    return true
  }

  $('mailTest').addEventListener('click', async () => {
    if (!(await saveStep(2))) return
    if (gone()) return

    const msg = $('mailTestMsg')
    msg.className = 'save-row__msg'
    msg.textContent = t('Sending…')

    const result = await send('/api/setup/mail/test', { method: 'POST' })
    if (gone()) return

    if (!result.ok) {
      msg.classList.add('is-error')
      msg.textContent = result.data?.error || t('It would not go out.')
      return
    }
    msg.classList.add('is-ok')
    msg.textContent = t('Sent to {email}. If it arrives, mail works.', { email: result.data.to })
  })

  $('ssoTest').addEventListener('click', async () => {
    if (!(await saveStep(3))) return
    if (gone()) return

    const msg = $('ssoTestMsg')
    msg.className = 'save-row__msg'
    msg.textContent = t('Asking…')

    const result = await send('/api/setup/sso/test', { method: 'POST' })
    if (gone()) return

    if (!result.ok) {
      msg.classList.add('is-error')
      msg.textContent = result.data?.error || t('It did not answer.')
      return
    }
    msg.classList.add('is-ok')
    msg.textContent = result.data.clientIdSet
      ? t('{issuer} answered. Give it the redirect below and it is done.', {
          issuer: result.data.issuer,
        })
      : t('{issuer} answered, but there is no client ID here yet.', { issuer: result.data.issuer })
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

  const VALUES = {
    1: () => {
      const domain = state.values.DOMAIN
      return domain ? `${state.values.PROTOCOL}://${domain}` : t('The listen address')
    },
    2: () => {
      if (!on('SMTP_ENABLED')) return t('Off — messages go to the log')
      const host = state.values.SMTP_HOST
      return host ? `${host}:${state.values.SMTP_PORT}` : t('On, but no server given yet')
    },
    3: () => (on('OIDC_ENABLED') ? state.values.OIDC_PROVIDER_NAME || t('On') : t('Off')),
    4: () =>
      t('{who} · at least {n} characters', {
        who: on('ALLOW_SIGNUP') ? t('Anyone may sign up') : t('Closed'),
        n: state.values.MIN_PASSWORD_LENGTH,
      }),
    5: () => {
      const here = EXT_ORDER.filter((id) => settled(id)).map((id) => EXT_LABEL[id])
      const asked = EXT_ORDER.filter((id) => wanted.has(id) && !settled(id)).map(
        (id) => EXT_LABEL[id]
      )

      const said = []
      if (here.length > 0) said.push(t('{list} installed', { list: here.join(', ') }))
      if (asked.length > 0) said.push(t('fetching {list}', { list: asked.join(', ') }))
      if (said.length > 0) return said.join(' · ')

      return wanted.has('none') ? t('EPUB and KEPUB only') : t('Not answered yet')
    },
    6: () => t('Not finished yet'),
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
      ? t('STILL ANSWERING AS {address}', { address: state.runningAddress.toUpperCase() })
      : ''

    $('finishText').textContent = state.canRestart
      ? moved
        ? t('The new address needs a restart; everything else is already live.')
        : t('Everything is live; finishing restarts the server once anyway.')
      : t('Everything is saved; the address takes effect at the next start.')

    $('finishManual').hidden = state.canRestart
    $('finishGo').textContent = state.canRestart ? t('Restart and finish') : t('Finish')
  }

  async function waitForTheServer() {
    const started = Date.now()
    while (page.alive && Date.now() - started < 120000) {
      await new Promise((r) => page.after(1500, r))
      if (!page.alive) return
      try {
        const res = await fetch('/healthz', { cache: 'no-store' })
        if (res.ok) {
          const chosen = EXT_ORDER.filter((id) => wanted.has(id) && !settled(id))
          if (chosen.length === 0) {
            window.location.href = '/'
            return
          }
          $('finishGo').hidden = true
          $('msg6').textContent = ''
          void followInstalls(chosen)
          return
        }
      } catch {
      }
    }
    if (!page.alive) return
    $('msg6').classList.add('is-error')
    $('msg6').textContent = t('It has not come back. Check the container.')
  }

  const EXT_ROW = {
    calibre: 'finishInstallCalibre',
    pdfcrop: 'finishInstallPdfcrop',
    kfx: 'finishInstallKfx',
  }

  const STAGE_WORDS = {
    packages: t('the libraries it needs'),
    download: t('downloading'),
    install: t('unpacking'),
    plugins: t('the KFX plugins'),
    prefix: t('the Wine prefix'),
    previewer: t('installing the Previewer'),
    wire: t('wiring it to calibre'),
    verify: t('checking it took'),
  }

  function installLine(one) {
    const label = EXT_LABEL[one.id]
    if (one.installed) return t('{label} — installed', { label })
    if (!one.pending && one.state === 'failed') {
      return t('{label} — did not finish; the output says where it stopped', { label })
    }
    if (one.pending || one.state === 'running') {
      const running = (one.stages || []).find((stage) => stage.state === 'running')
      if (!running) {
        return t('{label} — {what}', {
          label,
          what: one.state === 'idle' ? t('queued behind the one before it') : t('starting'),
        })
      }
      const pct = running.percent === null ? '' : ` · ${running.percent}%`
      return t('{label} — {what}', { label, what: STAGE_WORDS[running.name] || running.name }) + pct
    }
    return t('{label} — queued', { label })
  }

  async function followInstalls(chosen) {
    $('finishInstalls').hidden = false
    for (const id of chosen) $(EXT_ROW[id]).hidden = false

    let failed = 0
    while (page.alive) {
      const result = await send('/api/admin/extensions')
      if (gone()) return

      failed = 0
      let unsettled = 0
      for (const id of chosen) {
        const one = (result.data?.extensions ?? []).find((each) => each.id === id)
        if (!one) continue
        $(EXT_ROW[id]).textContent = installLine(one)
        if (one.installed) continue
        if (!one.pending && one.state === 'failed') failed += 1
        else unsettled += 1
      }
      if (unsettled === 0) break
      await new Promise((r) => page.after(2000, r))
    }
    if (!page.alive) return

    $('finishDone').hidden = false
    $('msg6').classList.toggle('is-error', failed > 0)
    $('msg6').textContent =
      failed > 0
        ? t('Not everything made it — the Converters page says where it stopped.')
        : t('All in. This server is ready.')
  }

  $('finishGo').addEventListener('click', async () => {
    $('finishGo').disabled = true

    const done = await send('/api/setup/complete', { method: 'POST' })
    if (gone()) return
    if (!done.ok) {
      $('finishGo').disabled = false
      notice(t('Not saved'), t('The server would not record that setup is finished. Try again.'))
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
      notice(t('Not restarted'), result.data?.error || t('The server refused.'))
      return
    }

    $('msg6').textContent = t('Restarting…')
    void waitForTheServer()
  })

  const [setup, config, installs] = await Promise.all([
    send('/api/setup'),
    send('/api/admin/settings'),
    send('/api/admin/extensions'),
  ])
  if (gone()) return

  if (!setup.ok || !config.ok) {
    notice(t('That did not load'), t('The server would not hand over its settings. Try reloading.'))
    return
  }

  for (const one of installs.data?.extensions ?? []) {
    if (one.installed) already.set(one.id, 'installed')
    else if (one.pending) already.set(one.id, 'pending')
  }
  state.agentless = installs.ok && installs.data?.agent === false

  state.canRestart = setup.data.canRestart === true
  state.runningAddress = setup.data.runningAddress || ''
  for (const spec of config.data.settings) {
    state.values[spec.key] = spec.kind === 'secret' ? '' : spec.value
    if (spec.kind === 'secret') state.secretSet[spec.key] = spec.isSet === true
  }

  state.schemeTouched = Boolean(state.values.DOMAIN)

  const trust = state.values.TRUST_PROXY ?? ''
  state.proxyOn = !OFF_WORDS.includes(trust.trim().toLowerCase())
  $('wizProxyAddr').value = ON_WORDS.includes(trust.trim().toLowerCase()) ? '' : trust

  paint()
  $('addressHint').textContent = hintForAddress()
  render()
})
