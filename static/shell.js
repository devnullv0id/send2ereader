'use strict'

const NAV = [
  { href: '/', label: 'Send', match: ['/', '/send'] },
  { href: '/convert', label: 'Convert', match: ['/convert'] },
  { href: '/history', label: 'History', match: ['/history'] },
  { href: '/waiting', label: 'Waiting', match: ['/waiting'], countable: true, private: true },
  { href: '/settings', label: 'Settings', match: ['/settings'], private: true },
]

function icon(name) {
  return `<i class="ph ph-${name}" aria-hidden="true"></i>`
}

function esc(value) {
  return String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
  }

  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.className = 'offscreen-copy'
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

function navHtml(path, state) {
  return NAV.filter((item) => {
    if (item.private && !state.user) return false
    if (item.countable && !state.waiting && !item.match.includes(path)) return false
    return true
  })
    .map((item) => {
      const current = item.match.includes(path) ? ' aria-current="page"' : ''
      const count = item.countable && state.waiting ? `<span class="nav-count">${state.waiting}</span>` : ''
      return `<a class="nav-pill" href="${item.href}"${current}>${item.label}${count}</a>`
    })
    .join('')
}

function accountHtml(state) {
  if (!state.accounts) return ''
  if (!state.user) {
    return `<a class="account-btn signed-out" href="/login">${icon('user-circle')}Sign in</a>`
  }
  return `<button type="button" class="account-btn" data-account-toggle aria-expanded="false">
    ${icon('user-circle')}<span>${esc(state.user.email)}</span>
  </button>`
}

function menuHtml(state) {
  if (!state.accounts || !state.user) return ''
  return `<div class="menu-anchor" data-account-menu hidden>
    <div class="menu">
      <div class="menu-email">${esc(state.user.email)}</div>
      <a class="menu-item" href="/settings#profile">Account</a>
      <a class="menu-item" href="/settings#history">History</a>
      <a class="menu-item" href="/settings">Settings</a>
      ${state.user.isAdmin ? '<a class="menu-item" href="/admin">Admin</a>' : ''}
      <button type="button" class="menu-item menu-item--danger" data-signout>Sign out</button>
    </div>
  </div>`
}

function drawerHtml(path, state) {
  const links = NAV.filter((item) => !item.private || state.user)
    .map((item) => {
      const current = item.match.includes(path) ? ' aria-current="page"' : ''
      const count =
        item.countable && state.waiting ? `<span class="nav-count">${state.waiting}</span>` : ''
      return `<a class="drawer__item" href="${item.href}"${current}>${item.label}${count}</a>`
    })
    .join('')

  let account = ''
  if (state.accounts && state.user) {
    account = `<div class="drawer__rule"></div>
      <div class="drawer__email">${esc(state.user.email)}</div>
      <a class="drawer__item" href="/settings#profile">Account</a>
      ${state.user.isAdmin ? '<a class="drawer__item" href="/admin">Admin</a>' : ''}
      <button type="button" class="drawer__item drawer__item--danger" data-signout>Sign out</button>`
  } else if (state.accounts) {
    account = `<div class="drawer__rule"></div>
      <a class="drawer__item" href="/login">Sign in</a>`
  }

  return `<div class="drawer-scrim" data-drawer-scrim hidden></div>
  <div class="drawer" id="navdrawer" data-drawer hidden>
    <nav class="drawer__body" aria-label="Main">${links}${account}</nav>
  </div>`
}

function passkeyNoticeHtml(user) {
  if (!user?.passkeysClearedAt) return ''
  const from = user.passkeysClearedFrom ? esc(user.passkeysClearedFrom) : 'a different address'
  return `<div class="modal-scrim" data-passkey-gone>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="passkeyGoneTitle">
      <div class="modal__title" id="passkeyGoneTitle">Your passkey was removed</div>
      <p class="modal__text">This server used to answer as <span class="mono">${from}</span>. A passkey is tied to the address it was created under, so yours stopped being something this address could ever offer you.</p>
      <p class="modal__text">Nothing else changed. Your password, your two-factor codes and your recovery codes all still work. Add a new passkey in Settings when it suits you.</p>
      <div class="modal__actions">
        <a class="btn btn--primary" href="/settings#security">Add a passkey</a>
        <button type="button" class="btn btn--err" data-passkey-gone-later>Not now</button>
      </div>
    </div>
  </div>`
}

const VERIFY_HELD = 's2e:verify-nudge-held'

function nudgeHeld() {
  try {
    return sessionStorage.getItem(VERIFY_HELD) === '1'
  } catch {
    return false
  }
}

function holdNudge() {
  try {
    sessionStorage.setItem(VERIFY_HELD, '1')
  } catch {
  }
}

function verifyNudgeHtml(state) {
  const nudge = state.verifyNudge
  if (!nudge || !nudge.needed || nudgeHeld()) return ''

  const left = Number(nudge.remindersLeft) || 0
  const phrase = state.hasRecoveryPhrase
    ? '<p class="modal__text">This server had no mail when your account was made, so you were given six words to get back in with. A confirmed address does that job better, and those words stop working once it is done.</p>'
    : ''
  const later =
    left > 0
      ? `<button type="button" class="btn btn--faint" data-verify-later>${left === 1 ? 'Not now — last time' : 'Not now'}</button>`
      : ''
  const budget =
    left > 0
      ? ''
      : '<p class="modal__text">There are no more reminders left on this account, so this is the last time it is asked.'
        + ' Confirming the address, or changing it, are the two ways on.</p>'

  return `<div class="modal-scrim" data-verify-nudge>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="verifyNudgeTitle">
      <div class="modal__title" id="verifyNudgeTitle">Confirm your email address</div>
      <p class="modal__text">This server can send mail now, and nothing has confirmed that <span class="mono">${esc(state.user.email)}</span> reaches you. It is how you get back in if you forget your password, so it is worth a minute.</p>
      ${phrase}
      ${budget}
      <div class="modal__actions modal__actions--apart">
        ${later}
        <a class="btn btn--err" href="/settings#profile" data-verify-change>Change email</a>
        <button type="button" class="btn btn--primary" data-verify-send data-modal-default>Send me the link</button>
      </div>
    </div>
  </div>`
}

function wireVerifyNudge(overlays) {
  const modal = overlays.querySelector('[data-verify-nudge]')
  if (!modal) return

  modal.querySelector('[data-verify-change]').addEventListener('click', () => {
    holdNudge()
    modal.remove()
  })

  const later = modal.querySelector('[data-verify-later]')
  if (later) {
    later.addEventListener('click', async () => {
      later.disabled = true
      const result = await postJson('/auth/verify/remind-later')
      holdNudge()
      modal.remove()
      const cached = readCachedStatus()
      if (cached?.verifyNudge && result.ok) {
        writeCachedStatus({
          ...cached,
          verifyNudge: { ...cached.verifyNudge, remindersLeft: result.data?.remindersLeft ?? 0 },
        })
      }
    })
  }

  const send = modal.querySelector('[data-verify-send]')
  send.addEventListener('click', async () => {
    send.disabled = true
    const result = await postJson('/auth/verify/resend')
    holdNudge()

    const body = modal.querySelector('.modal')
    const said = result.ok
      ? 'Open the link in it and this is done. It works in any browser.'
      : 'That did not go out. Try again in a minute, or change the address if it is wrong.'

    body.querySelector('.modal__title').textContent = result.ok ? 'On its way' : 'It did not send'
    for (const extra of [...body.querySelectorAll('.modal__text')].slice(1)) extra.remove()
    body.querySelector('.modal__text').textContent = said
    body.querySelector('.modal__actions').innerHTML =
      '<button type="button" class="btn btn--primary" data-verify-done data-modal-default>Got it</button>'
    body.querySelector('[data-verify-done]').addEventListener('click', () => modal.remove())
    body.querySelector('[data-verify-done]').focus()
  })
}

function overlaysHtml(state) {
  if (!state.accounts || !state.user) return ''
  return `${passkeyNoticeHtml(state.user)}${verifyNudgeHtml(state)}<div class="menu-scrim" data-account-scrim hidden></div>
  <div class="modal-scrim" data-signout-modal hidden>
    <div class="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="signoutTitle">
      <div class="modal__title" id="signoutTitle">Sign out?</div>
      <p class="modal__text">Your defaults and Kobo sync stay on the account. This browser's send history is cleared, and anything waiting for your Kobo stays queued on the server.</p>
      <div class="modal__actions">
        <button type="button" class="btn btn--primary" data-signout-confirm>Sign out</button>
        <button type="button" class="btn btn--err" data-signout-cancel>Stay signed in</button>
      </div>
    </div>
  </div>`
}

function headerHtml(path, state) {
  return `<div class="wrap">
    <a class="wordmark" href="/">
      ${icon('paper-plane-tilt')}<span>Send to eReader</span>
    </a>
    ${navHtml(path, state)}
    ${accountHtml(state)}
    <button type="button" class="nav-toggle" data-drawer-toggle aria-expanded="false"
      aria-controls="navdrawer" aria-label="Menu">${icon('list')}</button>
  </div>
  ${menuHtml(state)}`
}

const FOOTER_HTML = `<div class="wrap">
  <span>Maintained by devnullv0id. Inspired by djazz.</span>
  <span>Fastify, kepubify, and whatever converters this server was given</span>
  <a href="https://github.com/devnullv0id/send2ereader" rel="noreferrer">Source on GitHub</a>
</div>`

const closeMenus = []

function wireDrawer(header, overlays) {
  const toggle = header.querySelector('[data-drawer-toggle]')
  const drawer = overlays.querySelector('[data-drawer]')
  const scrim = overlays.querySelector('[data-drawer-scrim]')
  if (!toggle || !drawer || !scrim) return

  const shell = document.querySelector('.shell')

  const setOpen = (open) => {
    drawer.hidden = !open
    scrim.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    document.body.classList.toggle('is-drawer-open', open)

    if (shell) shell.inert = open

    if (open) {
      const first = drawer.querySelector('.drawer__item')
      if (first) first.focus()
    } else if (document.activeElement && drawer.contains(document.activeElement)) {
      toggle.focus()
    }
  }

  toggle.addEventListener('click', () => setOpen(drawer.hidden))
  scrim.addEventListener('click', () => setOpen(false))
  drawer.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false)
  })

  const gone = overlays.querySelector('[data-passkey-gone]')
  if (gone) {
    const acknowledge = async () => {
      gone.remove()
      await fetch('/auth/passkeys/cleared/ack', {
        method: 'POST',
        credentials: 'same-origin',
        headers: await csrfHeaders(),
      })
      const cached = readCachedStatus()
      if (cached?.user) {
        writeCachedStatus({
          ...cached,
          user: { ...cached.user, passkeysClearedAt: null, passkeysClearedFrom: null },
        })
      }
    }
    gone.querySelector('[data-passkey-gone-later]').addEventListener('click', acknowledge)
    gone.querySelector('a').addEventListener('click', acknowledge)
  }

  const modal = overlays.querySelector('[data-signout-modal]')
  const signout = drawer.querySelector('[data-signout]')
  if (modal && signout) {
    signout.addEventListener('click', () => {
      setOpen(false)
      modal.hidden = false
    })
  }

  closeMenus.push(() => setOpen(false))
}

function wireAccountMenu(header, overlays) {
  const toggle = header.querySelector('[data-account-toggle]')
  const menu = header.querySelector('[data-account-menu]')
  const scrim = overlays.querySelector('[data-account-scrim]')
  if (!toggle || !menu || !scrim) return

  const setOpen = (open) => {
    menu.hidden = !open
    scrim.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
  }

  toggle.addEventListener('click', () => setOpen(menu.hidden))
  scrim.addEventListener('click', () => setOpen(false))

  const modal = overlays.querySelector('[data-signout-modal]')

  closeMenus.push(() => {
    setOpen(false)
    modal.hidden = true
  })

  header.querySelector('[data-signout]').addEventListener('click', () => {
    setOpen(false)
    modal.hidden = false
  })
  overlays.querySelector('[data-signout-cancel]').addEventListener('click', () => {
    modal.hidden = true
  })
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true
  })

  overlays.querySelector('[data-signout-confirm]').addEventListener('click', async () => {
    await postJson('/auth/logout')
    if (typeof History !== 'undefined' && typeof History.clear === 'function') History.clear()
    cacheUser(null)
    window.location.href = '/'
  })
}

function explainUnbacked(root) {
  for (const el of root.querySelectorAll('[data-unbacked]')) {
    if (!el.title) el.title = `Not available yet: this needs ${el.dataset.unbacked}.`
  }
}

const shellState = {
  accounts: false,
  user: null,
  waiting: 0,
  verifyNudge: null,
  hasRecoveryPhrase: false,
}

let drawn = ''

function shellSignature() {
  const nudge = shellState.verifyNudge?.needed ? '1' : '0'
  return `${currentPath()}|${shellState.accounts}|${shellState.user?.email ?? ''}|${shellState.waiting}|${nudge}`
}

function currentPath() {
  return window.location.pathname.replace(/(.)\/+$/, '$1')
}

function overlayHost() {
  let host = document.querySelector('[data-shell-overlays]')
  if (!host) {
    host = document.createElement('div')
    host.setAttribute('data-shell-overlays', '')
    document.body.appendChild(host)
  }
  return host
}

function renderShell() {
  const header = document.querySelector('header.header')
  if (!header) return
  header.innerHTML = headerHtml(currentPath(), shellState)
  const overlays = overlayHost()
  overlays.innerHTML = drawerHtml(currentPath(), shellState) + overlaysHtml(shellState)
  closeMenus.length = 0
  wireDrawer(header, overlays)
  wireAccountMenu(header, overlays)
  wireVerifyNudge(overlays)
  const footer = document.querySelector('footer.footer')
  if (footer) footer.innerHTML = FOOTER_HTML
  drawn = shellSignature()
}

async function refreshShell() {
  const status = await getStatus()
  if (!status) return

  if (status.setupPending && currentPath() !== '/setup/start') {
    window.location.href = '/setup/start'
    return
  }

  shellState.accounts = Boolean(status.enabled)
  shellState.user = status.user || null
  shellState.waiting = 0
  shellState.verifyNudge = status.verifyNudge || null
  shellState.hasRecoveryPhrase = status.hasRecoveryPhrase === true

  const canHaveDevices = status.user?.emailVerified === true || status.verificationNeeded === false

  if (shellState.user && canHaveDevices) {
    try {
      const res = await fetch('/api/waiting/count', { credentials: 'same-origin' })
      if (res.ok) shellState.waiting = (await res.json()).count || 0
    } catch {
    }
  }

  writeCachedStatus({ ...status, waiting: shellState.waiting })

  if (shellSignature() !== drawn) renderShell()
}

function pageScope() {
  const listeners = []
  const timers = []
  const leavers = []

  const scope = {
    alive: true,

    on(target, type, handler, options) {
      target.addEventListener(type, handler, options)
      listeners.push([target, type, handler, options])
    },

    every(ms, fn) {
      const id = setInterval(fn, ms)
      timers.push([clearInterval, id])
      return id
    },

    frame(fn) {
      let handle = requestAnimationFrame(function step() {
        handle = requestAnimationFrame(step)
        fn()
      })
      leavers.push(() => cancelAnimationFrame(handle))
    },

    after(ms, fn) {
      const id = setTimeout(fn, ms)
      timers.push([clearTimeout, id])
      return id
    },

    leave(fn) {
      leavers.push(fn)
    },

    end() {
      scope.alive = false
      for (const [target, type, handler, options] of listeners) {
        target.removeEventListener(type, handler, options)
      }
      for (const [cancel, id] of timers) cancel(id)
      for (const fn of leavers) fn()
      listeners.length = 0
      timers.length = 0
      leavers.length = 0
    },
  }
  return scope
}

const PAGE_INITS = {}

let pendingPage = null

let currentScope = null

function onPage(names, init) {
  for (const name of [].concat(names)) PAGE_INITS[name] = init
  if (pendingPage && PAGE_INITS[pendingPage]) startPage(pendingPage)
}

function startPage(name) {
  if (!PAGE_INITS[name]) {
    pendingPage = name
    return false
  }
  pendingPage = null
  currentScope = pageScope()
  PAGE_INITS[name](currentScope)
  return true
}

function endPage() {
  if (currentScope) currentScope.end()
  currentScope = null
}

const SOFT_PATHS = new Set([
  '/',
  '/send',
  '/convert',
  '/history',
  '/waiting',
  '/settings',
  '/account',
  '/setup',
  '/login',
  '/register',
  '/auth/forgot',
  '/auth/reset',
])

let renderedUrl = ''

let navSeq = 0

async function ensureScripts(doc) {
  const path = (src) => new URL(src, window.location.href).pathname
  const here = new Set(
    [...document.querySelectorAll('script[src]')].map((s) => path(s.getAttribute('src')))
  )
  for (const tag of doc.querySelectorAll('script[src]')) {
    const src = tag.getAttribute('src')
    if (here.has(path(src))) continue
    here.add(path(src))
    await new Promise((resolve) => {
      const script = document.createElement('script')
      script.src = src
      script.addEventListener('load', resolve)
      script.addEventListener('error', resolve)
      document.head.appendChild(script)
    })
  }
}

async function navigate(href, options = {}) {
  const seq = ++navSeq
  const asked = new URL(href, window.location.href)

  let res
  try {
    res = await fetch(asked.href, { credentials: 'same-origin' })
  } catch {
    window.location.href = asked.href
    return
  }
  if (seq !== navSeq) return

  const isHtml = res.ok && (res.headers.get('content-type') || '').includes('text/html')
  const html = isHtml ? await res.text() : ''
  if (seq !== navSeq) return

  const next = html ? new DOMParser().parseFromString(html, 'text/html') : null
  const name = next?.body?.dataset.page
  if (!name) {
    window.location.href = asked.href
    return
  }

  const landed = new URL(res.url || asked.href)
  if (landed.pathname === asked.pathname) landed.hash = asked.hash

  await ensureScripts(next)
  if (seq !== navSeq) return
  if (!PAGE_INITS[name]) {
    window.location.href = landed.href
    return
  }

  window.history.replaceState({ ...window.history.state, y: window.scrollY }, '')

  endPage()
  document.title = next.title
  document.body.dataset.page = name
  document.body.innerHTML = next.body.innerHTML

  if (options.push !== false) window.history.pushState({ y: 0 }, '', landed.href)
  renderedUrl = landed.pathname + landed.search

  renderShell()
  explainUnbacked(document)
  startPage(name)

  if (typeof options.restore === 'number') window.scrollTo(0, options.restore)
  else if (landed.hash) document.getElementById(landed.hash.slice(1))?.scrollIntoView()
  else window.scrollTo(0, 0)

  void refreshShell()
}

function startRouter() {
  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
  renderedUrl = window.location.pathname + window.location.search

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return

    const link = e.target.closest?.('a[href]')
    if (!link || link.target || link.hasAttribute('download')) return

    const url = new URL(link.getAttribute('href'), window.location.href)
    if (url.origin !== window.location.origin) return
    if (!SOFT_PATHS.has(url.pathname.replace(/(.)\/+$/, '$1'))) return
    if (url.pathname === window.location.pathname && url.search === window.location.search) return

    e.preventDefault()
    void navigate(url.href)
  })

  window.addEventListener('popstate', () => {
    if (window.location.pathname + window.location.search === renderedUrl) return
    void navigate(window.location.href, {
      push: false,
      restore: window.history.state?.y ?? 0,
    })
  })
}

async function mountShell() {
  explainUnbacked(document)

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      for (const close of closeMenus) close()
      return
    }
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return

    const scrims = [...document.querySelectorAll('.modal-scrim:not([hidden])')]
    const open = scrims[scrims.length - 1]
    if (!open) return

    const target = e.target
    const tag = target?.tagName
    if (tag === 'BUTTON' || tag === 'A' || tag === 'TEXTAREA' || tag === 'SELECT') return

    const fallback = open.querySelector('[data-modal-default]')
    if (!fallback || fallback.disabled) return

    e.preventDefault()
    fallback.click()
  })

  if (!document.querySelector('header.header')) return

  const cached = readCachedStatus()
  if (cached) {
    shellState.accounts = Boolean(cached.enabled)
    shellState.user = cached.user || null
    shellState.waiting = cached.waiting || 0
    shellState.verifyNudge = cached.verifyNudge || null
    shellState.hasRecoveryPhrase = cached.hasRecoveryPhrase === true
  }
  renderShell()

  startRouter()
  const name = document.body.dataset.page
  if (name) startPage(name)

  await refreshShell()
}

document.addEventListener('DOMContentLoaded', mountShell)
