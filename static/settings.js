'use strict'

onPage('settings', async (page) => {
  const $ = (id) => document.getElementById(id)

  const gone = () => !page.alive

  const TABS = ['profile', 'defaults', 'history', 'security', 'kobo', 'danger']

  function ago(iso) {
    const seconds = Math.floor((Date.now() - Date.parse(iso)) / 1000)
    if (!Number.isFinite(seconds) || seconds < 60) return 'JUST NOW'
    if (seconds < 3600) return `${Math.floor(seconds / 60)} MIN AGO`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} HR AGO`
    return `${Math.floor(seconds / 86400)} DAYS AGO`
  }

  const PREFS_KEY = 's2e_prefs_v1'
  const DEFAULTS = {
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

  const CHOICES = { prefKindleFormat: 'kindleFormat', prefKoboFormat: 'koboFormat' }

  const VALUES = {
    lfMinWidthPercent: { key: 'lfMinWidthPercent', read: (v) => Number(v) },
    lfCoverColor: { key: 'lfCoverColor', read: (v) => v.trim() },
  }

  function readPrefs() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }
    } catch {
      return { ...DEFAULTS }
    }
  }

  const state = {
    user: null,
    device: null,
    endpoint: '',
    waiting: 0,
    revealed: false,
    storeEndpoint: 'https://storeapi.kobo.com',
    freshToken: false,
    blocked: false,
    passkeys: [],
    passkeysPossible: true,
    tfa: { enabled: false, recoveryCodes: null },
    tfaSetup: null,
    sessions: [],
    library: null,
    pendingEmail: null,
    emailTokenLasts: '',
    prefs: readPrefs(),
  }

  function writePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs))
    } catch {
    }
  }

  function renderPrefs() {
    for (const btn of document.querySelectorAll('[data-pref]')) {
      const on = state.prefs[btn.dataset.pref] === true
      btn.querySelector('.toggle').classList.toggle('is-on', on)
      btn.setAttribute('aria-pressed', String(on))
    }
    for (const [id, key] of Object.entries(CHOICES)) {
      const field = document.getElementById(id)
      if (field) field.value = state.prefs[key]
    }
    for (const [id, spec] of Object.entries(VALUES)) {
      const field = document.getElementById(id)
      if (field) field.value = state.prefs[spec.key]
    }
  }

  for (const btn of document.querySelectorAll('[data-pref]')) {
    btn.addEventListener('click', () => {
      state.prefs[btn.dataset.pref] = !state.prefs[btn.dataset.pref]
      writePrefs()
      renderPrefs()
    })
  }

  for (const [id, key] of Object.entries(CHOICES)) {
    const field = document.getElementById(id)
    if (!field) continue
    field.addEventListener('change', () => {
      state.prefs[key] = field.value
      writePrefs()
    })
  }

  for (const [id, spec] of Object.entries(VALUES)) {
    const field = document.getElementById(id)
    if (!field) continue
    field.addEventListener('change', () => {
      const value = spec.read(field.value)
      state.prefs[spec.key] = value === '' || Number.isNaN(value) ? DEFAULTS[spec.key] : value
      writePrefs()
      renderPrefs()
    })
  }

  function showTab(name) {
    const tab = TABS.includes(name) ? name : 'defaults'
    for (const panel of document.querySelectorAll('[data-panel]')) {
      panel.hidden = panel.dataset.panel !== tab
    }
    for (const item of document.querySelectorAll('.rail__item')) {
      item.classList.toggle('is-active', item.dataset.tab === tab)
      item.setAttribute('aria-current', item.dataset.tab === tab ? 'true' : 'false')
    }
    history.replaceState(null, '', `#${tab}`)
  }

  for (const item of document.querySelectorAll('.rail__item')) {
    item.addEventListener('click', () => showTab(item.dataset.tab))
  }

  page.on(window, 'hashchange', () => {
    showTab(window.location.hash.replace('#', ''))
  })

  function mask(endpoint) {
    return endpoint.replace(/\/kobo\/[^/]+$/, '/kobo/••••••••••••')
  }

  $('endpointShow').addEventListener('click', () => {
    state.revealed = !state.revealed
    renderKobo()
  })

  function renderKobo() {
    const device = state.device
    const on = Boolean(device)

    $('koboOff').hidden = on
    $('koboOn').hidden = !on
    const stage = !on ? 'off' : device.paired ? 'ok' : 'pending'
    for (const el of [$('koboRailDot'), $('koboStatus')]) {
      el.classList.toggle('is-on', stage === 'ok')
      el.classList.toggle('is-pending', stage === 'pending')
    }
    $('koboStatus').textContent = { off: 'NOT CONNECTED', ok: 'CONNECTED', pending: 'AWAITING FIRST SYNC' }[stage]
    if (!on) return

    const endpoint = state.endpoint || device.endpoint
    $('endpointBox').hidden = !endpoint

    $('endpointBox').classList.toggle('is-fresh', state.freshToken)
    $('endpointFlash').hidden = !state.freshToken
    $('endpointUrl').hidden = state.freshToken
    $('endpointShow').hidden = state.freshToken
    $('endpointCopy').hidden = state.freshToken
    $('manualOpen').hidden = !endpoint
    if (endpoint) {
      $('endpointUrl').textContent = state.revealed ? endpoint : mask(endpoint)
      $('manualLine').textContent = state.revealed
        ? `api_endpoint=${endpoint}`
        : `api_endpoint=${mask(endpoint)}`
      $('manualOriginal').textContent = `api_endpoint=${state.storeEndpoint}`
      $('endpointShow').textContent = state.revealed ? 'Hide' : 'Show'
      $('endpointShow').setAttribute('aria-pressed', String(state.revealed))
    }

    const status = koboStateFor(device)
    const box = $('koboState')
    box.classList.remove('is-ok', 'is-warn', 'is-syncing', 'is-error')
    box.classList.add(status.tone)
    $('koboStateTitle').textContent = status.title
    $('koboStateMeta').textContent = status.meta

    const proxy = document.querySelector('[data-device-pref="proxyStore"]')
    proxy.querySelector('.toggle').classList.toggle('is-on', device.proxyStore)
    proxy.setAttribute('aria-pressed', String(device.proxyStore))
  }

  const SYNCING_WITHIN_MS = 60 * 1000
  const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000

  function koboStateFor(device) {
    const since = device.lastSeenAt ? Date.now() - Date.parse(device.lastSeenAt) : Number.NaN
    const when = device.lastSeenAt ? ago(device.lastSeenAt).toLowerCase() : ''

    if (!device.paired) {
      return {
        tone: 'is-warn',
        title: 'Not connected yet',
        meta: 'Enter the endpoint on your Kobo and tap Sync. This turns green once it checks in.',
      }
    }

    if (device.lastSyncFailedAt) {
      return {
        tone: 'is-error',
        title: 'Last sync failed',
        meta: 'Your Kobo reached the endpoint but the transfer broke off. It retries on the next sync.',
      }
    }

    if (since < SYNCING_WITHIN_MS) {
      return {
        tone: 'is-syncing',
        title: 'Syncing now',
        meta: 'Your Kobo is checking in. Anything waiting goes across in a moment.',
      }
    }

    if (since > STALE_AFTER_MS) {
      return {
        tone: 'is-warn',
        title: 'Not seen in a while',
        meta: `Last sync ${when}. Open the Kobo and tap Sync if something is waiting.`,
      }
    }

    const waiting =
      state.waiting === 0
        ? 'Nothing waiting to be collected.'
        : state.waiting === 1
          ? '1 book waiting to be collected.'
          : `${state.waiting} books waiting to be collected.`
    return { tone: 'is-ok', title: 'Connected', meta: `Last sync ${when}. ${waiting}` }
  }

  async function loadDevice() {
    try {
      const res = await fetch('/api/devices', { credentials: 'same-origin' })
      if (res.ok) {
        const body = await res.json()
        state.device = body.devices?.[0] ?? null
        if (body.storeEndpoint) state.storeEndpoint = body.storeEndpoint
      }
      if (res.status === 403) state.blocked = true
    } catch {
    }

    if (!state.blocked) {
      try {
        const res = await fetch('/api/waiting/count', { credentials: 'same-origin' })
        if (res.ok) state.waiting = (await res.json()).count || 0
      } catch {
      }
    }
    if (gone()) return
    renderKobo()
    renderProfile()
  }

  $('koboGenerate').addEventListener('click', async () => {
    const result = await postJson('/api/devices', { label: 'My Kobo' })
    if (gone() || !result.ok) return
    state.device = result.data.device
    state.endpoint = result.data.endpoint
    renderKobo()
    renderProfile()
  })

  $('koboRegenerate').addEventListener('click', async () => {
    if (!state.device) return
    const result = await postJson(`/api/devices/${encodeURIComponent(state.device.id)}/token`, {})
    if (gone() || !result.ok) return
    state.endpoint = result.data.endpoint
    state.revealed = false
    flashNewToken()
  })

  const FLASH_MS = 2600
  let flashTimer = null

  function flashNewToken() {
    state.freshToken = true
    renderKobo()
    clearTimeout(flashTimer)
    flashTimer = page.after(FLASH_MS, () => {
      state.freshToken = false
      renderKobo()
    })
  }

  $('koboRevoke').addEventListener('click', async () => {
    if (!state.device) return
    const res = await sendJson('DELETE', `/api/devices/${encodeURIComponent(state.device.id)}`)
    if (gone() || !res.ok) return
    state.device = null
    state.endpoint = ''
    renderKobo()
    renderProfile()
  })

  document.querySelector('[data-device-pref="proxyStore"]').addEventListener('click', async () => {
    if (!state.device) return
    const next = !state.device.proxyStore
    const res = await sendJson('PATCH', `/api/devices/${encodeURIComponent(state.device.id)}`, {
      proxyStore: next,
    })
    if (res.ok) state.device = res.data.device
    if (gone()) return
    renderKobo()
  })

  async function copyTo(button, text, done = 'Copied') {
    const was = button.textContent
    if (!(await copyText(text))) return
    button.textContent = done
    button.classList.add('is-done')
    page.after(1600, () => {
      button.textContent = was
      button.classList.remove('is-done')
    })
  }

  $('endpointCopy').addEventListener('click', () =>
    copyTo($('endpointCopy'), state.endpoint || state.device?.endpoint || '')
  )
  $('manualCopy').addEventListener('click', () =>
    copyTo($('manualCopy'), `api_endpoint=${state.endpoint || state.device?.endpoint || ''}`, 'Copied')
  )
  $('manualOriginalCopy').addEventListener('click', () =>
    copyTo($('manualOriginalCopy'), `api_endpoint=${state.storeEndpoint}`, 'Copied')
  )

  function showManual(open) {
    $('manual').hidden = !open
    if (open) $('manualClose').focus()
  }

  $('manualOpen').addEventListener('click', () => showManual(true))
  $('manualClose').addEventListener('click', () => showManual(false))
  $('manual').addEventListener('click', (e) => {
    if (e.target === $('manual')) showManual(false)
  })
  page.on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && !$('manual').hidden) showManual(false)
  })

  function bytes(value) {
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
    if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`
    return `${Math.max(1, Math.round(value / 1024))} KB`
  }

  function asAmount(minutes) {
    if (minutes > 0 && minutes % 1440 === 0) return { value: minutes / 1440, unit: 1440 }
    if (minutes > 0 && minutes % 60 === 0) return { value: minutes / 60, unit: 60 }
    return { value: minutes, unit: 1 }
  }

  function spellMinutes(minutes) {
    const { value, unit } = asAmount(minutes)
    const name = unit === 1440 ? 'day' : unit === 60 ? 'hour' : 'minute'
    return `${value} ${value === 1 ? name : `${name}s`}`
  }

  function renderLibrary() {
    const info = state.library
    $('libraryPanel').hidden = !info || info.ceilingMinutes <= 0
    if (!info || info.ceilingMinutes <= 0) return

    const on = info.effectiveMinutes > 0
    $('libraryToggle').setAttribute('aria-checked', String(on))
    $('libraryToggle').querySelector('.toggle').classList.toggle('is-on', on)
    $('libraryOn').hidden = !on

    const editing = document.activeElement === $('retainAmount')
    if (!editing) {
      const shown = asAmount(info.effectiveMinutes || info.ceilingMinutes)
      $('retainAmount').value = String(shown.value)
      $('retainUnit').value = String(shown.unit)
    }

    $('retainNote').textContent =
      `How long a book stays here, up to ${spellMinutes(info.ceilingMinutes)} on this server. Changing it affects new books only — anything already kept keeps the deadline it started with.`

    $('libraryUsage').textContent =
      `${bytes(info.usedBytes)} of ${bytes(info.limitBytes)} used by this account` +
      `, ${bytes(info.serverUsedBytes)} of ${bytes(info.serverLimitBytes)} across the server.`
  }

  async function loadLibrary() {
    try {
      const res = await fetch('/api/library', { credentials: 'same-origin' })
      if (res.ok) state.library = await res.json()
    } catch {
    }
    if (gone()) return
    renderLibrary()
  }

  async function saveRetention(minutes) {
    const res = await sendJson('PATCH', '/api/library', { minutes })
    if (gone() || !res.ok) return
    await loadLibrary()
  }

  $('libraryToggle').addEventListener('click', () => {
    const info = state.library
    if (!info) return
    void saveRetention(info.effectiveMinutes > 0 ? 0 : info.ceilingMinutes)
  })

  $('retainSave').addEventListener('click', () => {
    const amount = Number.parseInt($('retainAmount').value, 10)
    const unit = Number.parseInt($('retainUnit').value, 10)
    if (!Number.isFinite(amount) || amount < 1 || !Number.isFinite(unit)) return
    void saveRetention(amount * unit)
  })

  function renderProfile() {
    const user = state.user
    if (!user) return

    const named = `${user.firstName || ''} ${user.lastName || ''}`.trim()
    $('avatar').textContent = named
      ? `${user.firstName[0] || ''}${user.lastName[0] || ''}`.toUpperCase()
      : user.email.slice(0, 1).toUpperCase()
    $('whoami').textContent = named ? `${named} · ${user.email}` : user.email

    $('nameFirst').value = user.firstName || ''
    $('nameLast').value = user.lastName || ''
    $('nameIntro').textContent = named
      ? 'Shown to whoever administers this server, so they can tell one account from another without reading everybody’s address.'
      : 'This account was made before names were asked for. Give one and the person administering this server can tell it apart from the others without reading everybody’s address.'

    const sends = History.all().length
    $('statSends').textContent = String(sends)
    $('statSendsLabel').textContent = sends === 1 ? 'book sent' : 'books sent'

    const stage = !state.device ? 'off' : state.device.paired ? 'ok' : 'pending'
    $('statSync').textContent = { off: 'Off', ok: 'On', pending: 'Pending' }[stage]
    $('statSync').classList.toggle('is-on', stage === 'ok')
    $('statSync').classList.toggle('is-pending', stage === 'pending')

    const since = new Date(user.createdAt)
    $('since').textContent = `Signed in since ${since.toLocaleDateString()}.`

    $('emailNow').textContent = user.email

    $('pwnone').hidden = user.hasPassword
    $('pwcurrent').hidden = !user.hasPassword
    $('pwIntro').textContent = user.hasPassword
      ? 'This account has a password as well as emailed sign-in links. Change it here.'
      : "This account signs in with emailed links, so there's no password yet. Set one if you'd rather type than wait for mail."
    $('pwsave').textContent = user.hasPassword ? 'Change password' : 'Set a password'
    $('delEmail').textContent = user.email
    $('delKoboLine').textContent = state.device
      ? 'The Kobo sync endpoint — devices pointed at it stop syncing'
      : 'Any Kobo sync endpoint'
  }

  function renderVerification() {
    const confirmed = state.user?.emailVerified === true

    const asked = state.verificationNeeded !== false
    const settled = confirmed || !asked

    $('emailUnconfirmed').hidden = settled
    $('emailConfirmed').hidden = !confirmed

    const generate = $('koboGenerate')
    generate.disabled = !settled
    if (settled) generate.removeAttribute('title')
    else generate.title = 'Confirm your email address first — the box above will send the link again.'
  }

  function passkeysWork() {
    return state.passkeysPossible !== false && typeof window.PublicKeyCredential === 'function'
  }

  let confirming = false

  const tfaCells = attachCodeCells($('tfaCells'), {
    length: 6,
    numeric: true,
    autocomplete: 'one-time-code',
    label: 'The six digits your authenticator app shows',
    onInput: (value) => {
      $('tfaConfirm').disabled = value.length < 6
      $('tfaError').hidden = true
    },
    onComplete: () => {
      if (!confirming) $('tfaConfirm').click()
    },
  })

  function renderTfa() {
    const on = state.tfa.enabled
    const setting = state.tfaSetup !== null

    $('tfaStatus').textContent = setting ? 'SETTING UP' : on ? 'ON' : 'OFF'
    $('tfaOff').hidden = on
    $('tfaOn').hidden = !on
    $('tfaModal').hidden = !setting

    const verified = state.user?.emailVerified === true || state.verificationNeeded === false
    $('tfaBegin').disabled = !verified
    $('tfaNeedsEmail').hidden = verified

    if (state.tfaSetup) {
      $('tfaSecret').textContent = state.tfaSetup.typed
      const qr = $('tfaQr')
      if (state.tfaSetup.svg) qr.innerHTML = state.tfaSetup.svg
      else qr.replaceChildren(document.createTextNode('Type the key instead'))
    }

    const left = state.tfa.recoveryCodes
    $('codesLeft').textContent = left
      ? `${left.unused} of ${left.total} recovery codes unused. They were shown once when you turned this on.`
      : ''
  }

  async function loadSecurity() {
    const [keys, tfa] = await Promise.all([
      fetch('/auth/passkeys', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch('/auth/tfa', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
    if (gone()) return
    if (keys) {
      state.passkeys = keys.passkeys || []
      state.passkeysPossible = keys.supported
    }
    if (tfa) state.tfa = { enabled: tfa.enabled, recoveryCodes: tfa.recoveryCodes }
    renderSecurity()
  }

  const fromBase64Url = (value) =>
    Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  const toBase64Url = (buffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

  function credentialOptions(options) {
    return {
      ...options,
      challenge: fromBase64Url(options.challenge),
      user: { ...options.user, id: fromBase64Url(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({
        ...c,
        id: fromBase64Url(c.id),
      })),
    }
  }

  function requestOptions(options) {
    return {
      ...options,
      challenge: fromBase64Url(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({
        ...c,
        id: fromBase64Url(c.id),
      })),
    }
  }

  $('addPasskey').addEventListener('click', () => {
    $('passkeyName').value = ''
    $('passkeyError').hidden = true
    $('passkeyModal').hidden = false
    $('passkeyName').focus()
  })

  $('passkeyCreate').addEventListener('click', async () => {
    const label = $('passkeyName').value.trim() || 'This computer'
    $('passkeyError').hidden = true
    busy($('passkeyCreate'), true, 'Waiting for your device…')

    const begun = await postJson('/auth/passkeys/options', {})
    if (gone()) return
    if (!begun.ok) {
      busy($('passkeyCreate'), false)
      return sayPasskey('That did not start. Try again in a moment.')
    }

    let credential
    try {
      credential = await navigator.credentials.create({
        publicKey: credentialOptions(begun.data.options),
      })
    } catch (err) {
      if (gone()) return
      busy($('passkeyCreate'), false)
      return sayPasskey(
        err?.name === 'InvalidStateError'
          ? 'This device already has a passkey for this account.'
          : 'Your device did not hand one over.'
      )
    }
    if (gone()) return

    const saved = await postJson('/auth/passkeys', {
      label,
      response: {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: credential.type,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: {
          clientDataJSON: toBase64Url(credential.response.clientDataJSON),
          attestationObject: toBase64Url(credential.response.attestationObject),
          transports: credential.response.getTransports?.() ?? [],
        },
      },
    })
    if (gone()) return
    busy($('passkeyCreate'), false)

    if (!saved.ok) return sayPasskey(saved.data?.error || 'That passkey was not accepted.')
    $('passkeyModal').hidden = true
    await loadSecurity()
  })

  function sayPasskey(text) {
    $('passkeyError').textContent = text
    $('passkeyError').hidden = false
  }

  function confirmNeeds() {
    const user = (readCachedStatus() || {}).user || {}
    return { password: user.hasPassword !== false, code: user.totpEnabled === true }
  }

  function confirmIdentity(text) {
    const needs = confirmNeeds()
    if (!needs.password && !needs.code) return Promise.resolve({})

    return new Promise((resolve) => {
      const scrim = $('confirmModal')
      const password = $('confirmPassword')
      const code = $('confirmCode')

      $('confirmText').textContent = text
      password.hidden = !needs.password
      code.hidden = !needs.code
      password.value = ''
      code.value = ''
      $('confirmError').hidden = true
      scrim.hidden = false
      ;(needs.password ? password : code).focus()

      const finish = (value) => {
        scrim.hidden = true
        $('confirmGo').removeEventListener('click', accept)
        $('confirmCancel').removeEventListener('click', cancel)
        resolve(value)
      }
      const accept = () => finish({ password: password.value, code: code.value })
      const cancel = () => finish(null)

      $('confirmGo').addEventListener('click', accept)
      $('confirmCancel').addEventListener('click', cancel)
    })
  }

  async function removePasskey(key, button) {
    const proof = await confirmIdentity('Removing a passkey changes how you sign in.')
    if (gone() || !proof) return

    button.disabled = true
    const res = await sendJson('DELETE', `/auth/passkeys/${encodeURIComponent(key.id)}`, proof)
    if (gone()) return
    if (!res.ok) {
      button.disabled = false
      return
    }
    await loadSecurity()
  }

  $('tfaBegin').addEventListener('click', async () => {
    busy($('tfaBegin'), true, 'Making a secret…')
    const res = await postJson('/auth/tfa/begin', {})
    if (gone()) return
    busy($('tfaBegin'), false)
    if (!res.ok) return

    state.tfaSetup = res.data
    tfaCells.clear()
    $('tfaConfirm').disabled = true
    $('tfaError').hidden = true
    renderTfa()
    tfaCells.focus()
  })

  $('tfaConfirm').addEventListener('click', async () => {
    const code = tfaCells.value
    if (code.length < 6 || confirming) return
    confirming = true
    busy($('tfaConfirm'), true, 'Checking…')
    const res = await postJson('/auth/tfa/confirm', { code })
    confirming = false
    if (gone()) return
    busy($('tfaConfirm'), false)

    if (!res.ok) {
      $('tfaError').hidden = false
      tfaCells.clear()
      tfaCells.focus()
      $('tfaConfirm').disabled = true
      return
    }
    state.tfaSetup = null
    showCodes(res.data.codes)
    await loadSecurity()
  })

  $('tfaDisable').addEventListener('click', async () => {
    const proof = await confirmIdentity('Turning two-factor off leaves the password on its own.')
    if (gone() || !proof) return

    busy($('tfaDisable'), true, 'Turning off…')
    const res = await postJson('/auth/tfa/disable', proof)
    if (gone()) return
    busy($('tfaDisable'), false)
    if (res.ok) await loadSecurity()
  })

  $('regenCodes').addEventListener('click', async () => {
    const proof = await confirmIdentity('A fresh set retires the codes you have now.')
    if (gone() || !proof) return

    busy($('regenCodes'), true, 'Making a fresh set…')
    const res = await postJson('/auth/tfa/codes', proof)
    if (gone()) return
    busy($('regenCodes'), false)
    if (!res.ok) return
    showCodes(res.data.codes)
    await loadSecurity()
  })

  function showCodes(codes) {
    $('codesGrid').replaceChildren(
      ...codes.map((code) => {
        const cell = document.createElement('div')
        cell.textContent = code
        return cell
      })
    )
    resetCodesAck()
    $('codesModal').hidden = false
  }

  $('tfaCancel').addEventListener('click', () => {
    state.tfaSetup = null
    renderTfa()
  })

  $('tfaCopy').addEventListener('click', async () => {
    const label = $('tfaCopy').querySelector('span')
    const icon = $('tfaCopy').querySelector('.ph')
    if (!(await copyText($('tfaSecret').textContent))) return
    label.textContent = 'Copied'
    icon.className = 'ph ph-check'
    $('tfaCopy').classList.add('is-done')
    page.after(1600, () => {
      label.textContent = 'Copy'
      icon.className = 'ph ph-copy'
      $('tfaCopy').classList.remove('is-done')
    })
  })

  $('resendVerify').addEventListener('click', async () => {
    busy($('resendVerify'), true, 'Sending…')
    const result = await postJson('/auth/verify/resend', {})
    if (gone()) return
    busy($('resendVerify'), false)

    $('resendMsg').textContent = !result.ok
      ? 'That did not go through. Try again in a moment.'
      : result.data?.mailEnabled === false
        ? 'This server has no mail configured, so the link is in its log.'
        : 'Sent. Open the link in that message to confirm.'
  })

  function describeAgent(agent) {
    const ua = String(agent || '')

    let browser = ''
    if (/Edg\//.test(ua)) browser = 'Edge'
    else if (/OPR\/|Opera/.test(ua)) browser = 'Opera'
    else if (/Firefox\//.test(ua)) browser = 'Firefox'
    else if (/Chrome\//.test(ua)) browser = 'Chrome'
    else if (/Safari\//.test(ua)) browser = 'Safari'

    let os = ''
    if (/Windows/.test(ua)) os = 'Windows'
    else if (/Android/.test(ua)) os = 'Android'
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS'
    else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS'
    else if (/Kobo|Kindle/.test(ua)) os = 'eReader'
    else if (/Linux|X11/.test(ua)) os = 'Linux'

    return { browser, os }
  }

  function renderSecurity() {
    const passkeys = state.passkeys
    $('passkeyList').hidden = passkeys.length === 0
    $('passkeyEmpty').hidden = passkeys.length > 0
    $('addPasskey').textContent = passkeys.length ? 'Add another passkey' : 'Add a passkey'
    $('addPasskey').disabled = !passkeysWork()
    $('passkeyUnsupported').hidden = passkeysWork()

    const keyTpl = $('passkeyRowTpl')
    $('passkeyList').replaceChildren(
      ...passkeys.map((key) => {
        const row = keyTpl.content.firstElementChild.cloneNode(true)
        row.querySelector('.key-row__name').textContent = key.label
        row.querySelector('.key-row__meta').textContent = key.lastUsedAt
          ? `ADDED ${ago(key.createdAt)} · LAST USED ${ago(key.lastUsedAt)}`
          : `ADDED ${ago(key.createdAt)} · NEVER USED`

        const remove = row.querySelector('.row-action')
        remove.addEventListener('click', () => removePasskey(key, remove))
        return row
      })
    )

    renderTfa()

    const sessionTpl = $('sessionRowTpl')
    $('sessionList').replaceChildren(
      ...state.sessions.map((session) => {
        const row = sessionTpl.content.firstElementChild.cloneNode(true)
        const { browser, os } = describeAgent(session.userAgent)

        row.querySelector('.session__dot').classList.toggle('is-current', session.current)
        row.querySelector('.session__name').textContent = session.current
          ? 'This browser'
          : os || browser || 'Unknown device'
        row.querySelector('.session__meta').textContent = [
          browser || 'UNKNOWN BROWSER',
          os || 'UNKNOWN SYSTEM',
          session.current ? 'ACTIVE NOW' : ago(session.lastSeenAt),
        ]
          .join(' · ')
          .toUpperCase()

        const action = row.querySelector('.session__action')
        action.hidden = session.current
        action.textContent = 'Sign out'
        if (!session.current) {
          action.addEventListener('click', () => endOther(session.id, action))
        }
        return row
      })
    )
    $('revokeOthers').hidden = state.sessions.filter((s) => !s.current).length === 0
  }

  async function loadSessions() {
    try {
      const res = await fetch('/auth/sessions', { credentials: 'same-origin' })
      if (res.ok) state.sessions = (await res.json()).sessions || []
    } catch {
    }
    if (gone()) return
    renderSecurity()
  }

  async function endOther(id, button) {
    button.disabled = true
    const res = await sendJson('DELETE', `/auth/sessions/${encodeURIComponent(id)}`)
    await loadSessions()
    if (!res.ok) button.disabled = false
  }

  $('revokeOthers').addEventListener('click', async () => {
    const result = await postJson('/auth/sessions/revoke-others', {})
    if (result.ok) await loadSessions()
  })

  $('nameform').addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = $('namemsg')
    msg.className = 'save-row__msg'

    const result = await postJson('/auth/name', {
      firstName: $('nameFirst').value.trim(),
      lastName: $('nameLast').value.trim(),
    })
    if (gone()) return

    if (!result.ok) {
      msg.classList.add('is-error')
      msg.textContent = result.data?.error || 'That name was not saved'
      return
    }

    state.user = result.data.user
    cacheUser(result.data.user)
    msg.classList.add('is-ok')
    msg.textContent = 'Saved.'
    renderProfile()
  })

  $('pwform').addEventListener('submit', async (e) => {
    e.preventDefault()
    const msg = $('pwmsg')
    msg.className = 'save-row__msg'

    const fail = (text) => {
      msg.classList.add('is-error')
      msg.textContent = text
    }
    if (state.user?.hasPassword && !$('pwcurrent').value) return fail('Enter your current password')
    if ($('pwnew').value !== $('pwagain').value) return fail("Those don't match")

    const result = await postJson('/auth/password', {
      current: $('pwcurrent').value,
      password: $('pwnew').value,
    })
    if (gone()) return

    if (result.ok) {
      msg.classList.add('is-ok')
      msg.textContent = 'Saved. Other sessions signed out.'
      $('pwform').reset()
      if (state.user) state.user.hasPassword = true
      renderProfile()
      await loadSessions()
      return
    }
    fail(result.data?.error || 'That current password is incorrect')
  })

  $('newEmail').addEventListener('input', () => {
    const ready = looksLikeEmail($('newEmail').value)
    $('emailGo').classList.toggle('is-ready', ready)
    $('emailGo').disabled = !ready
    $('emailTaken').hidden = true
  })

  $('emailGo').addEventListener('click', async () => {
    const wanted = $('newEmail').value.trim()
    if (!looksLikeEmail(wanted)) return

    const proof = await confirmIdentity('Changing the address changes how you sign in.')
    if (gone() || !proof) return

    busy($('emailGo'), true, 'Sending…')
    const result = await postJson('/auth/email', { email: wanted, ...proof })
    if (gone()) return
    busy($('emailGo'), false)

    if (!result.ok) {
      $('emailTaken').textContent =
        result.data?.error || 'That address was not accepted. Try another.'
      $('emailTaken').hidden = false
      return
    }

    $('newEmail').value = ''
    $('emailGo').disabled = true
    $('emailGo').classList.remove('is-ready')
    state.pendingEmail = result.data.pendingEmail
    renderPendingEmail()
  })

  $('pendingCancel').addEventListener('click', async () => {
    await postJson('/auth/email/cancel', {})
    if (gone()) return
    state.pendingEmail = null
    renderPendingEmail()
  })

  function renderPendingEmail() {
    const waiting = Boolean(state.pendingEmail)
    $('emailPending').hidden = !waiting
    $('emailIdle').hidden = waiting
    if (!waiting) return

    $('pendingEmail').textContent = state.pendingEmail
    $('pendingText').textContent =
      `Still delivering to ${state.user?.email ?? 'the old address'} until that link is opened. ` +
      `It lasts ${state.emailTokenLasts || '24 hours'} and works once.`
  }

  function renderDelete() {
    const armed = $('delText').value === 'DELETE'
    $('delGo').classList.toggle('is-armed', armed)
    $('delGo').disabled = !armed
  }

  $('delText').addEventListener('input', renderDelete)
  $('delGo').addEventListener('click', () => {
    $('delConfirm').hidden = false
  })
  $('delNo').addEventListener('click', () => {
    $('delConfirm').hidden = true
    $('delText').value = ''
    renderDelete()
  })

  $('delYes').addEventListener('click', async () => {
    const proof = await confirmIdentity('Deleting the account cannot be undone.')
    if (gone() || !proof) return

    $('delYes').disabled = true
    const res = await sendJson('DELETE', '/api/account', proof)
    if (gone()) return
    if (!res.ok) {
      $('delYes').disabled = false
      $('delNote').textContent = res.data?.error || 'That could not be deleted.'
      $('delNote').hidden = false
      return
    }
    History.clear()
    cacheUser(null)
    window.location.href = '/'
  })

  function closeModal(el) {
    el.hidden = true
  }

  for (const modal of document.querySelectorAll('.modal-scrim')) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal)
    })
  }
  page.on(document, 'keydown', (e) => {
    if (e.key !== 'Escape') return
    for (const modal of document.querySelectorAll('.modal-scrim')) closeModal(modal)
  })

  $('passkeyCancel').addEventListener('click', () => closeModal($('passkeyModal')))

  function currentCodes() {
    return [...$('codesGrid').children].map((el) => el.textContent).join('\n')
  }

  $('codesCopy').addEventListener('click', async () => {
    const label = $('codesCopy').querySelector('span')
    const icon = $('codesCopy').querySelector('.ph')
    if (!(await copyText(currentCodes()))) return
    label.textContent = 'Copied'
    icon.className = 'ph ph-check'
    $('codesCopy').classList.add('is-done')
    page.after(1600, () => {
      label.textContent = 'Copy all'
      icon.className = 'ph ph-copy'
      $('codesCopy').classList.remove('is-done')
    })
  })

  $('codesDownload').addEventListener('click', () => {
    const body = `Send to eReader — recovery codes\n${state.user?.email || ''}\n\n${currentCodes()}\n\nEach code works once.\n`
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' }))
    link.download = 'send-to-eReader-recovery-codes.txt'
    link.click()
    URL.revokeObjectURL(link.href)
  })

  let codesAcknowledged = false

  function paintCodesAck() {
    const box = $('codesAck').querySelector('.codes__ack-box')
    box.classList.toggle('is-on', codesAcknowledged)
    box.textContent = codesAcknowledged ? '✓' : ''
    $('codesAck').setAttribute('aria-checked', String(codesAcknowledged))
    $('codesDone').classList.toggle('is-armed', codesAcknowledged)
    $('codesDone').disabled = !codesAcknowledged
  }

  function resetCodesAck() {
    codesAcknowledged = false
    paintCodesAck()
  }

  $('codesAck').addEventListener('click', () => {
    codesAcknowledged = !codesAcknowledged
    paintCodesAck()
  })
  $('codesDone').addEventListener('click', () => closeModal($('codesModal')))

  showTab(window.location.hash.replace('#', ''))
  renderPrefs()

  const status = await getStatus()
  if (gone()) return
  if (!status?.user) {
    const here = window.location.pathname + window.location.search + window.location.hash
    window.location.href = `/login?next=${encodeURIComponent(here)}`
    return
  }
  state.user = status.user
  state.verificationNeeded = status.verificationNeeded
  state.pendingEmail = status.pendingEmail || null
  state.emailTokenLasts = status.emailTokenLasts || ''
  $('delLastWarning').hidden = status.soleAccount !== true

  applyPasswordPolicy(status)
  attachPasswordRules(status)
  renderProfile()
  renderPendingEmail()
  renderVerification()
  renderSecurity()
  renderDelete()

  if (queryParam('verified')) {
    $('confirmedMeta').textContent = 'CONFIRMED JUST NOW — KOBO SYNC IS AVAILABLE'
    showTab('profile')
  }
  if (queryParam('moved')) showTab('profile')
  await loadDevice()
  await loadSessions()
  await loadSecurity()
  await loadLibrary()
})
