'use strict'

var I18N = { language: 'en', languages: [], strings: {} }

function t(text, params) {
  var hit = I18N.strings[text]
  var out = hit === undefined ? text : hit
  if (!params) return out
  return out.replace(/\{(\w+)\}/g, function (whole, name) {
    return params[name] === undefined ? whole : String(params[name])
  })
}

let csrf = null

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS']

async function csrfHeaders(extra) {
  if (!csrf) await getStatus()
  const headers = Object.assign({}, extra || {})
  if (csrf) headers['x-csrf-token'] = csrf
  return headers
}

async function attempt(method, url, body) {
  const headers = { 'content-type': 'application/json' }
  if (csrf && SAFE_METHODS.indexOf(method) === -1) headers['x-csrf-token'] = csrf

  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
  })
  let data = null
  try {
    data = await res.json()
  } catch {
  }
  return { ok: res.ok, status: res.status, data }
}

async function sendJson(method, url, body) {
  try {
    if (!csrf && SAFE_METHODS.indexOf(method) === -1) await getStatus()

    const first = await attempt(method, url, body)
    if (first.status !== 403 || !csrf) return first

    const before = csrf
    await getStatus()
    if (csrf === before) return first

    return await attempt(method, url, body)
  } catch {
    return { ok: false, status: 0, data: null }
  }
}

function postJson(url, body) {
  return sendJson('POST', url, body)
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

function size(value) {
  if (!value) return ''
  const mb = value / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`
}

function bytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = Number(value)
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit++
  }
  const rounded = amount >= 100 || Number.isInteger(amount) ? Math.round(amount) : amount.toFixed(1)
  return `${rounded} ${units[unit]}`
}

function ago(iso) {
  if (!iso) return t('NEVER')
  const seconds = Math.floor((Date.now() - Date.parse(iso)) / 1000)
  if (!Number.isFinite(seconds) || seconds < 60) return t('JUST NOW')
  if (seconds < 3600) return t('{n} MIN AGO', { n: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('{n} HR AGO', { n: Math.floor(seconds / 3600) })
  return t('{n} DAYS AGO', { n: Math.floor(seconds / 86400) })
}

function badge(el, done, current, mark) {
  el.className = `step__badge${done ? ' is-complete' : current ? ' is-current' : ''}`
  el.textContent = done ? '✓' : mark
}

const STATUS_CACHE_KEY = 's2e_status_v1'

function readCachedStatus() {
  try {
    const raw = sessionStorage.getItem(STATUS_CACHE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeCachedStatus(status) {
  try {
    if (status) sessionStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(status))
    else sessionStorage.removeItem(STATUS_CACHE_KEY)
  } catch {
  }
}

function cacheUser(user) {
  const status = readCachedStatus()
  if (status) writeCachedStatus({ ...status, user: user || null })
}

const HEALTH_CACHE_KEY = 's2e_health_v1'

function readCachedHealth() {
  try {
    const raw = sessionStorage.getItem(HEALTH_CACHE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeCachedHealth(health) {
  try {
    sessionStorage.setItem(HEALTH_CACHE_KEY, JSON.stringify(health))
  } catch {
  }
}

async function getHealth() {
  const res = await fetch('/healthz')
  const health = await res.json()
  writeCachedHealth(health)
  return health
}

// The shell and the page ask while loading; one request serves both.
let asking = null

async function getStatus() {
  if (asking) return asking

  asking = (async () => {
    try {
      const res = await fetch('/auth/status', { credentials: 'same-origin' })
      if (!res.ok) return null
      const status = await res.json()
      csrf = status.csrf || null
      writeCachedStatus(status)
      return status
    } catch {
      return null
    }
  })()

  try {
    return await asking
  } finally {
    asking = null
  }
}

// Same rule as getStatus: one request, two readers.
let counting = null

async function getWaitingCount() {
  if (counting) return counting

  counting = (async () => {
    try {
      const res = await fetch('/api/waiting/count', { credentials: 'same-origin' })
      if (!res.ok) return 0
      return (await res.json()).count || 0
    } catch {
      return 0
    }
  })()

  try {
    return await counting
  } finally {
    counting = null
  }
}

function queryParam(name) {
  return new URLSearchParams(window.location.search).get(name)
}

function safeNext(fallback) {
  const next = queryParam('next') || ''
  if (!next) return fallback
  try {
    const here = window.location.origin
    const target = new URL(next, here)
    if (target.origin !== here) return fallback
    return target.pathname + target.search + target.hash
  } catch {
    return fallback
  }
}

function listOut(items) {
  if (items.length <= 1) return items[0] || ''
  return t('{list} and {last}', {
    list: items.slice(0, -1).join(', '),
    last: items[items.length - 1],
  })
}

const PASSWORD_TESTS = {
  upper: /\p{Lu}/u,
  lower: /\p{Ll}/u,
  digit: /\p{Nd}/u,
  symbol: /[^\p{L}\p{Nd}\s]/u,
}

function saidOf(need) {
  return typeof need === 'string' ? need : need.said
}

function applyPasswordPolicy(status) {
  const rules = (status && status.passwordRules) || {}
  const min = (status && status.minPasswordLength) || rules.minLength
  if (!min) return

  const said = (rules.needs || []).map(saidOf)

  for (const input of document.querySelectorAll('input[type="password"]')) {
    input.minLength = min
  }
  for (const note of document.querySelectorAll('[data-password-note]')) {
    if (note.tagName === 'INPUT') {
      note.placeholder = said.length
        ? t('At least {min} characters, with {needs}', { min, needs: listOut(said) })
        : t('At least {min} characters', { min })
    } else if (said.length) {
      note.textContent = t('At least {min} characters, with {needs}.', {
        min,
        needs: listOut(said),
      })
    } else {
      note.textContent = t('At least {min} characters. Length beats punctuation.', { min })
    }
  }
}

function passwordChecks(rules, min) {
  const checks = [
    {
      id: 'length',
      said: t('At least {min} characters', { min }),
      met: (value) => value.length >= min,
    },
  ]
  for (const need of rules.needs || []) {
    const id = typeof need === 'string' ? '' : need.id
    const test = PASSWORD_TESTS[id]
    if (!test) continue
    const capital = saidOf(need).replace(/^a /, 'A ').replace(/^an /, 'An ')
    checks.push({ id, said: capital, met: (value) => test.test(value) })
  }
  return checks
}

function attachPasswordRules(status) {
  const rules = (status && status.passwordRules) || {}
  const min = (status && status.minPasswordLength) || rules.minLength
  if (!min) return

  const checks = passwordChecks(rules, min)

  for (const host of document.querySelectorAll('[data-pw-rules]')) {
    if (host.dataset.pwWired === 'yes') continue
    host.dataset.pwWired = 'yes'

    const field = document.getElementById(host.dataset.pwRules)
    if (!field) continue

    host.replaceChildren()
    const clip = document.createElement('div')
    clip.className = 'pw-rules__clip'
    host.appendChild(clip)

    const list = document.createElement('ul')
    list.className = 'pw-rules__box'
    clip.appendChild(list)

    const rows = checks.map((check) => {
      const row = document.createElement('li')
      row.className = 'pw-rule'

      const mark = document.createElement('span')
      mark.className = 'pw-rule__mark'
      mark.setAttribute('aria-hidden', 'true')
      row.appendChild(mark)

      const text = document.createElement('span')
      text.className = 'pw-rule__text'
      text.textContent = check.said
      row.appendChild(text)

      list.appendChild(row)
      return { row, check }
    })

    const paint = () => {
      const value = field.value
      let unmet = 0
      for (const { row, check } of rows) {
        const met = check.met(value)
        if (!met) unmet++
        row.classList.toggle('is-met', met)
      }
      host.classList.toggle('is-done', unmet === 0 && value !== '')
    }

    const fold = () => {
      const wanted = document.activeElement === field
      host.classList.toggle('is-open', wanted)
      host.setAttribute('aria-hidden', wanted ? 'false' : 'true')
    }

    field.addEventListener('focus', fold)
    field.addEventListener('blur', fold)
    field.addEventListener('input', () => {
      paint()
      fold()
    })

    paint()
    fold()
  }
}

function applyLinkPolicy(status) {
  if (!status) return
  const lasts = {
    'sign-in': status.signInLinkLasts,
    email: status.emailTokenLasts,
  }
  for (const note of document.querySelectorAll('[data-link-ttl]')) {
    const value = lasts[note.dataset.linkTtl]
    if (!value) continue
    note.textContent = note.textContent.replace(/\d+ \p{L}+/u, value)
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function looksLikeEmail(value) {
  return EMAIL_RE.test(String(value ?? '').trim())
}

function busy(button, isBusy, busyLabel) {
  if (!button) return
  if (isBusy) {
    button.dataset.label = button.textContent
    button.textContent = busyLabel || t('Working…')
    button.disabled = true
  } else {
    button.textContent = button.dataset.label || button.textContent
    button.disabled = false
  }
}

if (typeof module !== 'undefined') module.exports = { safeNext, looksLikeEmail, applyLinkPolicy }
