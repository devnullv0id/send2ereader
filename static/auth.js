'use strict'

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

async function getStatus() {
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
}

function setNote(el, message, kind) {
  if (!el) return
  el.textContent = message || ''
  el.className = message ? `note ${kind || ''}`.trim() : 'note'
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
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
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
  const needs = said.length ? `, with ${listOut(said)}` : ''

  for (const input of document.querySelectorAll('input[type="password"]')) {
    input.minLength = min
  }
  for (const note of document.querySelectorAll('[data-password-note]')) {
    if (note.tagName === 'INPUT') note.placeholder = `At least ${min} characters${needs}`
    else if (needs) note.textContent = `At least ${min} characters${needs}.`
    else note.textContent = `At least ${min} characters. Length beats punctuation.`
  }
}

function passwordChecks(rules, min) {
  const checks = [
    { id: 'length', said: `At least ${min} characters`, met: (value) => value.length >= min },
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
    note.textContent = note.textContent.replace(/\b\d+ (?:minutes?|hours?|days?)\b/, value)
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
    button.textContent = busyLabel || 'Working…'
    button.disabled = true
  } else {
    button.textContent = button.dataset.label || button.textContent
    button.disabled = false
  }
}

if (typeof module !== 'undefined') module.exports = { safeNext, looksLikeEmail, applyLinkPolicy }
