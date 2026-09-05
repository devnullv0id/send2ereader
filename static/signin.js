'use strict'

onPage(['login', 'register', 'forgot', 'reset', 'setup', 'linked'], async (page) => {
  const $ = (id) => document.getElementById(id)

  const NOTE_MS = 3000
  const LINK_POLL_MS = 2000
  const LINK_WATCH_MS = 20 * 60 * 1000

  const DESIGN_TEXT = {
    noAccount: 'No account for that address on this server. Create one first.',
    noPassword:
      'That account has no password. Sign in by link or code, then set one in Settings.',
    wrongPassword: "Wrong password. Reset it if you've forgotten.",
    badEmail: "That doesn't look like an email address.",
    accountExists: 'An account already exists for that address. Sign in instead.',
    mismatch: "Those two don't match.",
  }

  const PLACEHOLDER = {
    resetEmail: 'you@example.com',
  }

  let failTimer = null

  function fail(message) {
    const note = $('note')
    if (!note) return

    if (failTimer) clearTimeout(failTimer)
    failTimer = null

    note.textContent = message
    note.hidden = !message
    if (!message) return

    failTimer = page.after(NOTE_MS, () => {
      note.hidden = true
      failTimer = null
    })
  }

  const rememberBoxes = [...document.querySelectorAll('[data-remember]')]

  function applyStayPolicy(status) {
    if (!status) return
    const allowed = status.staySignedIn !== false
    for (const box of rememberBoxes) box.hidden = !allowed
    if (!allowed) setRemember(false)
  }

  function remembering() {
    return rememberBoxes.length === 0 || rememberBoxes[0].getAttribute('aria-checked') === 'true'
  }

  const fromBase64Url = (value) =>
    Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

  const toBase64Url = (buffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

  function setRemember(on) {
    for (const box of rememberBoxes) {
      box.setAttribute('aria-checked', String(on))
      const tick = box.querySelector('.checkbox')
      tick.classList.toggle('is-on', on)
      tick.textContent = on ? '✓' : ''
    }
  }

  for (const box of rememberBoxes) {
    box.addEventListener('click', () => setRemember(!remembering()))
  }
  setRemember(true)
  applyStayPolicy(readCachedStatus())

  const status = await getStatus()
  if (!page.alive) return
  applyStayPolicy(status)
  applyPasswordPolicy(status)
  attachPasswordRules(status)

  applyLinkPolicy(status)

  for (const toggle of document.querySelectorAll('[data-reveal]')) {
    toggle.addEventListener('click', () => {
      const fields = [...document.querySelectorAll('input[autocomplete$="password"]')]
      const shown = toggle.getAttribute('aria-pressed') === 'true'
      for (const field of fields) field.type = shown ? 'password' : 'text'

      toggle.setAttribute('aria-pressed', String(!shown))
      toggle.setAttribute('aria-label', shown ? 'Show the passwords' : 'Hide the passwords')
      toggle.querySelector('.ph').className = shown ? 'ph ph-eye' : 'ph ph-eye-slash'
    })
  }

  const MARK_TITLE = {
    email: {
      ok: 'This is a valid email address.',
      bad: 'This is not a valid email address.',
    },
    match: {
      ok: 'The passwords match.',
      bad: 'The passwords do not match.',
    },
  }

  function setMark(field, ok, bad, titles) {
    field.setAttribute('aria-invalid', String(bad))
    const mark = field.parentElement.querySelector('.auth__status')
    if (!mark) return

    mark.className = `auth__status${ok ? ' is-ok' : bad ? ' is-bad' : ''}`
    if (ok || bad) mark.title = ok ? titles.ok : titles.bad
    else mark.removeAttribute('title')

    mark.querySelector('.ph').className = ok
      ? 'ph ph-check-circle'
      : bad
        ? 'ph ph-x-circle'
        : 'ph'
  }

  for (const mark of document.querySelectorAll('.auth__status')) {
    mark.addEventListener('click', () => mark.parentElement.querySelector('input')?.focus())
  }

  function markEmail(field) {
    const empty = field.value.trim() === ''
    const good = field.checkValidity() && looksLikeEmail(field.value)
    setMark(field, !empty && good, !empty && !good, MARK_TITLE.email)
  }

  function markMatch() {
    const password = $('password')
    const confirm = $('confirm')
    if (!password || !confirm) return
    const empty = confirm.value === ''
    const same = confirm.value === password.value
    setMark(confirm, !empty && same, !empty && !same, MARK_TITLE.match)
  }

  for (const field of document.querySelectorAll('input[type="email"]')) {
    for (const event of ['input', 'change']) {
      field.addEventListener(event, () => markEmail(field))
    }
    markEmail(field)
  }

  if ($('confirm')) {
    for (const field of [$('password'), $('confirm')]) {
      for (const event of ['input', 'change']) field.addEventListener(event, markMatch)
    }
    markMatch()
  }

  function gate(form, button) {
    if (!form || !button) return () => {}
    const confirm = form.querySelector('#confirm')
    const email = form.querySelector('input[type="email"]')

    const check = () => {
      const password = form.querySelector('#password')
      const matched = !confirm || !password || confirm.value === password.value
      const addressed = !email || looksLikeEmail(email.value)
      button.disabled = !(form.checkValidity() && matched && addressed)
    }

    form.addEventListener('input', check)
    check()
    return check
  }

  function showRecoveryPhrase(phrase, onDone) {
    const host = $('codesPhrase')
    if (!host || !phrase) return onDone()

    host.replaceChildren()
    const cell = document.createElement('span')
    cell.className = 'codes__word'
    cell.textContent = phrase
    host.appendChild(cell)

    const asText = phrase
    $('codesCopy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(asText)
        $('codesCopy').querySelector('span').textContent = 'Copied'
      } catch {
      }
    })

    $('codesDownload').addEventListener('click', () => {
      const blob = new Blob([`${asText}\n`], { type: 'text/plain' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = 'send2ereader-recovery-phrase.txt'
      link.click()
      URL.revokeObjectURL(link.href)
    })

    let saved = false
    $('codesAck').addEventListener('click', () => {
      saved = !saved
      $('codesAck').setAttribute('aria-checked', String(saved))
      $('codesAck').querySelector('.codes__ack-box').classList.toggle('is-on', saved)
      $('codesDone').disabled = !saved
    })

    $('codesDone').addEventListener('click', () => {
      if (!saved) return
      $('codesModal').hidden = true
      onDone()
    })

    $('codesModal').hidden = false
    $('codesAck').focus()
  }

  const loginForm = $('loginform')
  if (loginForm) {
    function notice(title, text) {
      $('noticeTitle').textContent = title
      $('noticeText').textContent = text
      $('noticeModal').hidden = false
      $('noticeOk').focus()
    }

    function dismissNotice() {
      $('noticeModal').hidden = true

      const here = new URL(window.location.href)
      here.searchParams.delete('error')
      here.searchParams.delete('moved')
      history.replaceState(null, '', here.pathname + here.search + here.hash)
    }

    $('noticeOk').addEventListener('click', dismissNotice)

    $('noticeModal').addEventListener('click', (e) => {
      if (e.target === $('noticeModal')) dismissNotice()
    })

    page.on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && !$('noticeModal').hidden) dismissNotice()
    })

    if (queryParam('error') === 'verify') {
      notice(
        'That confirmation link no longer works',
        'It has expired, or it was already used. Sign in and ask for another from your account page.'
      )
    }
    if (queryParam('error') === 'link') {
      notice(
        'That sign-in link no longer works',
        'A sign-in link is good once and for fifteen minutes. Ask for another and open the newest message.'
      )
    }
    if (queryParam('error') === 'email') {
      notice(
        'That address link no longer works',
        'It has expired, was already used, or someone else took the address in the meantime. Sign in and ask again from your account page.'
      )
    }
    if (queryParam('moved')) {
      notice(
        'That is the address now',
        'Sign in with it from here on. The old one has been told, and it no longer signs in to this account.'
      )
    }
    if (status?.registrationOpen) $('registerlink').hidden = false
    if (status?.ssoEnabled) {
      $('ssofield').hidden = false
      if (status.ssoProvider) $('ssolabel').textContent = `Continue with ${status.ssoProvider}`
    }

    const check = gate(loginForm, $('submitbtn'))

    const options = [...document.querySelectorAll('.auth-modes__option')]
    options.forEach((option, index) => {
      option.addEventListener('click', () => {
        $('modes').dataset.seg = String(index)
        for (const other of options) {
          const on = other === option
          other.classList.toggle('is-selected', on)
          other.setAttribute('aria-selected', String(on))
        }
        for (const pane of document.querySelectorAll('[data-pane]')) {
          pane.hidden = pane.dataset.pane !== option.dataset.mode
        }
        if (option.dataset.mode !== 'link') {
          stopWaiting()
          $('linkSent').hidden = true
        }
        $('password').required = option.dataset.mode === 'password'
        check()
      })
    })

    $('sendLink').addEventListener('click', () => {
      if (!$('email').checkValidity() || !looksLikeEmail($('email').value)) {
        $('email').reportValidity()
        return
      }
      const email = $('email').value
      showSent()
      void postJson('/auth/link/request', { email, remember: remembering() }).then(() => {
        if (!page.alive) return
        waitForTheLink()
      })
    })

    let sentTimer = null

    function showSent() {
      const box = $('linkSent')
      const form = $('loginform')
      const first = document.querySelector('.auth__field-wrap')
      const last = document.querySelector('[data-pane="link"] [data-remember]')

      const frame = form.getBoundingClientRect()
      const top = first.getBoundingClientRect().top - frame.top
      const bottom = (last.hidden ? first : last).getBoundingClientRect().bottom - frame.top
      box.style.setProperty('--cover-top', `${Math.round(top)}px`)
      box.style.setProperty('--cover-height', `${Math.round(bottom - top)}px`)

      box.hidden = false
      if (sentTimer) clearTimeout(sentTimer)
      sentTimer = page.after(NOTE_MS, () => {
        box.hidden = true
        sentTimer = null
      })
    }

    function stopWaiting() {
      if (!watching) return
      clearInterval(watching)
      watching = 0
    }

    function waitForTheLink() {
      if (watching) return
      const until = Date.now() + LINK_WATCH_MS

      watching = page.every(LINK_POLL_MS, async () => {
        if (Date.now() > until) return stopWaiting()

        const now = await getStatus()
        if (!page.alive || !watching || !now) return

        if (now.user) {
          stopWaiting()
          cacheUser(now.user)
          window.location.href = safeNext('/')
          return
        }
        if (now.awaitingSecondFactor && $('codeStep').hidden) {
          stopWaiting()
          askForCode()
        }
      })
    }

    if (status && status.mailEnabled === false) {
      $('linkSentText').textContent =
        'We don’t say which addresses exist. This server has no mail configured, so the link is in its log.'
    }

    const recoveryLink = $('useAccountCode')
    if (recoveryLink) recoveryLink.hidden = status?.recoveryPhraseInUse !== true
    if (recoveryLink && !recoveryLink.hidden) {
      let usingCode = false

      const paintRecovery = () => {
        const field = $('password')
        field.type = usingCode ? 'text' : 'password'
        field.placeholder = usingCode ? 'six words joined by hyphens' : ''
        field.value = ''
        field.autocomplete = usingCode ? 'one-time-code' : 'current-password'
        recoveryLink.textContent = usingCode
          ? 'Use my password instead'
          : 'Lost your password? Use your recovery phrase'
        $('submitbtn').textContent = usingCode ? 'Sign in with the phrase' : 'Sign in'
      }

      recoveryLink.addEventListener('click', (event) => {
        event.preventDefault()
        usingCode = !usingCode
        paintRecovery()
        $('password').focus()
      })

      loginForm.dataset.mode = 'password'
      Object.defineProperty(loginForm, 'usingCode', { get: () => usingCode })
    }

    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      fail('')
      busy($('submitbtn'), true, 'Signing in…')

      const byCode = loginForm.usingCode === true
      const result = byCode
        ? await postJson('/auth/login/recovery', {
            email: $('email').value,
            phrase: $('password').value,
            remember: remembering(),
          })
        : await postJson('/auth/login', {
            email: $('email').value,
            password: $('password').value,
            remember: remembering(),
          })
      busy($('submitbtn'), false)

      if (result.ok && result.data?.secondFactor) {
        askForCode()
        return
      }
      if (result.ok) {
        cacheUser(result.data?.user)
        window.location.href = safeNext('/')
        return
      }
      if (!result.data?.error) {
        fail('Could not reach the server')
        return
      }

      fail(
        byCode ? 'That recovery phrase does not match that address.' : DESIGN_TEXT.wrongPassword
      )
      $('password').value = ''
      $('password').focus()
    })

    let recovering = false
    let checking = false
    let watching = 0

    const codeCells = attachCodeCells($('codeCells'), {
      length: 6,
      numeric: true,
      autocomplete: 'one-time-code',
      label: 'The six digits your authenticator app shows',
      onInput: (value) => {
        $('codebtn').disabled = value.length < 6
        sayCode('')
      },
      onComplete: () => {
        if (!checking) $('codeform').requestSubmit()
      },
    })

    function typedCode() {
      return recovering ? $('recoveryCode').value.trim() : codeCells.value
    }

    function askForCode() {
      $('firstStep').hidden = true
      $('codeStep').hidden = false
      codeCells.focus()
    }

    if (queryParam('step') === 'code' && status?.awaitingSecondFactor) askForCode()

    let codeNoteTimer = null

    function sayCode(text) {
      if (codeNoteTimer) clearTimeout(codeNoteTimer)
      codeNoteTimer = null

      $('codenote').textContent = text
      $('codenote').hidden = !text
      if (!text) return

      codeNoteTimer = page.after(NOTE_MS, () => {
        $('codenote').hidden = true
        codeNoteTimer = null
      })
    }

    $('recoveryCode').addEventListener('input', () => {
      $('codebtn').disabled = $('recoveryCode').value.trim().length < 10
      sayCode('')
    })

    $('codeBack').addEventListener('click', () => {
      void postJson('/auth/login/cancel', {})
      $('codeStep').hidden = true
      $('firstStep').hidden = false
      codeCells.clear()
      $('recoveryCode').value = ''
      $('codebtn').disabled = true
      if (recovering) $('useRecovery').click()
      sayCode('')
      $('password').value = ''
      $('email').focus()
    })

    $('useRecovery').addEventListener('click', () => {
      recovering = !recovering
      $('codeLabel').textContent = recovering ? 'Recovery code' : 'Code'
      $('useRecovery').textContent = recovering
        ? 'Use the authenticator instead'
        : 'Use a recovery code instead'

      $('codeCells').hidden = recovering
      $('recoveryCode').hidden = !recovering
      sayCode('')
      codeCells.clear()
      $('recoveryCode').value = ''
      $('codebtn').disabled = true
      sayCode('')
      if (recovering) $('recoveryCode').focus()
      else codeCells.focus()
    })

    $('codeform').addEventListener('submit', async (event) => {
      event.preventDefault()
      if (checking) return
      checking = true
      sayCode('')
      busy($('codebtn'), true, 'Checking…')

      const result = await postJson('/auth/login/second-factor', { code: typedCode() })
      checking = false
      busy($('codebtn'), false)

      if (result.ok) {
        cacheUser(result.data?.user)
        window.location.href = safeNext('/')
        return
      }
      if (result.status === 440) {
        sayCode('That took too long. Start again with your password.')
        return
      }
      sayCode(
        recovering
          ? 'That recovery code has been used, or was never one of yours.'
          : 'That code did not match. Codes change every 30 seconds, so use the one showing now.'
      )
      if (recovering) {
        $('recoveryCode').select()
      } else {
        codeCells.clear()
        codeCells.focus()
      }
      $('codebtn').disabled = true
    })

    const passkeysUsable =
      status?.passkeysPossible !== false && typeof window.PublicKeyCredential === 'function'
    $('passkeyfield').hidden = !passkeysUsable

    $('passkeybtn').addEventListener('click', async () => {
      $('passkeynote').hidden = true
      busy($('passkeybtn'), true, 'Ask your device…')

      const begun = await postJson('/auth/passkey/login/options', {})
      if (!begun.ok) {
        busy($('passkeybtn'), false)
        return sayPasskey('That did not start. Try again in a moment.')
      }

      let assertion
      try {
        assertion = await navigator.credentials.get({
          publicKey: {
            ...begun.data.options,
            challenge: fromBase64Url(begun.data.options.challenge),
            allowCredentials: (begun.data.options.allowCredentials || []).map((c) => ({
              ...c,
              id: fromBase64Url(c.id),
            })),
          },
        })
      } catch {
        busy($('passkeybtn'), false)
        return sayPasskey('No passkey was offered for this site on this device.')
      }

      const result = await postJson('/auth/passkey/login', {
        remember: remembering(),
        response: {
          id: assertion.id,
          rawId: toBase64Url(assertion.rawId),
          type: assertion.type,
          clientExtensionResults: assertion.getClientExtensionResults(),
          response: {
            clientDataJSON: toBase64Url(assertion.response.clientDataJSON),
            authenticatorData: toBase64Url(assertion.response.authenticatorData),
            signature: toBase64Url(assertion.response.signature),
            userHandle: assertion.response.userHandle
              ? toBase64Url(assertion.response.userHandle)
              : null,
          },
        },
      })
      busy($('passkeybtn'), false)

      if (result.ok && result.data?.secondFactor) {
        askForCode()
        return
      }
      if (result.ok) {
        cacheUser(result.data?.user)
        window.location.href = safeNext('/')
        return
      }
      sayPasskey(result.data?.error || 'That passkey was not accepted.')
    })

    function sayPasskey(text) {
      $('passkeynote').textContent = text
      $('passkeynote').hidden = false
    }
  }

  const linkedCard = $('linkedCard')
  if (linkedCard) {
    const now = await getStatus()
    if (!page.alive) return

    if (now?.awaitingSecondFactor) {
      $('linkedTitle').textContent = 'Nearly there'
      $('linkedText').textContent =
        'Enter the code from your authenticator app in the tab where you asked for the link.'
      $('linkedHere').textContent = 'Enter it here instead'
      $('linkedHere').href = '/login?step=code'
    } else if (!now?.user) {
      $('linkedTitle').textContent = 'That link no longer works'
      $('linkedText').textContent =
        'A sign-in link is good once and for fifteen minutes. Ask for another and open the newest message.'
      $('linkedHere').textContent = 'Back to sign in'
      $('linkedHere').href = '/login'
    }
  }

  const registerForm = $('registerform')
  const setupForm = $('setupform')
  const claimForm = registerForm || setupForm

  if (claimForm) {
    if (setupForm) {
      if (status && !status.unclaimed) {
        window.location.href = '/login?step=code'
        return
      }
      if (status && status.mailEnabled === false) {
        $('mailnote').textContent =
          'This server has no mail configured, so the confirmation link will be written to its ' +
          'log rather than sent. Use a real address anyway — it is how you reset a lost password.'
      }
    }

    gate(claimForm, $('submitbtn'))

    claimForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      fail('')

      if ($('password').value !== $('confirm').value) {
        fail(DESIGN_TEXT.mismatch)
        $('confirm').focus()
        return
      }

      busy($('submitbtn'), true, 'Creating…')
      const result = await postJson('/auth/register', {
        email: $('email').value,
        password: $('password').value,
        firstName: $('firstName').value.trim(),
        lastName: $('lastName').value.trim(),
        remember: remembering(),
      })
      busy($('submitbtn'), false)

      if (result.ok) {
        cacheUser(result.data?.user)
        const next = result.data?.claimed ? '/setup/start' : '/settings#profile'
        showRecoveryPhrase(result.data?.recoveryPhrase, () => {
          window.location.href = next
        })
        return
      }
      if (result.status === 409) return fail(DESIGN_TEXT.accountExists)
      if (result.status === 0) return fail('Could not reach the server')
      fail(result.data?.error || DESIGN_TEXT.badEmail)
    })
  }

  const forgotForm = $('forgotform')
  if (forgotForm) {
    gate(forgotForm, $('submitbtn'))

    forgotForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      busy($('submitbtn'), true, 'Sending…')
      await postJson('/auth/reset/request', { email: $('email').value })
      if (!page.alive) return
      busy($('submitbtn'), false)

      $('sent').hidden = false
      if (status && status.mailEnabled === false) {
        $('sentText').textContent =
          'We don’t say which addresses exist. This server has no mail configured, so the link is in its log.'
      }
    })
  }

  const resetForm = $('resetform')
  if (resetForm) {
    $('resetEmail').textContent = PLACEHOLDER.resetEmail
    gate(resetForm, $('submitbtn'))

    resetForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      fail('')

      if ($('password').value !== $('confirm').value) {
        fail(DESIGN_TEXT.mismatch)
        $('confirm').focus()
        return
      }

      busy($('submitbtn'), true, 'Saving…')
      const result = await postJson('/auth/reset', {
        token: queryParam('token') || '',
        password: $('password').value,
        remember: remembering(),
      })
      busy($('submitbtn'), false)

      if (result.ok && result.data?.secondFactor) {
        window.location.href = '/login'
        return
      }
      if (result.ok) {
        cacheUser(result.data?.user)
        window.location.href = '/settings#profile'
        return
      }
      fail(result.data?.error || 'That link is invalid or has expired.')
    })
  }
})
