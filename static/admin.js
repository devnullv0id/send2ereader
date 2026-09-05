'use strict'

onPage('admin', async (page) => {
  const $ = (id) => document.getElementById(id)

  const gone = () => !page.alive

  const state = {
    me: null,
    groups: [],
    settings: [],
    users: [],
    tab: 'people',
    pending: null,
    addressPending: false,
    runningAddress: '',
    units: {},
    switched: {},
    canRestart: false,
    restore: null,
  }

  const asJson = (body) => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  function plural(count, unit) {
    return `${count} ${unit}${count === 1 ? '' : 's'}`
  }

  function seconds(value) {
    const total = Number(value)
    if (!Number.isFinite(total)) return ''
    if (total % 86400 === 0 && total >= 86400) return plural(total / 86400, 'day')
    if (total % 3600 === 0 && total >= 3600) return plural(total / 3600, 'hour')
    if (total % 60 === 0 && total >= 60) return plural(total / 60, 'minute')
    return plural(total, 'second')
  }

  const SCALES = {
    seconds: [
      { factor: 1, label: 'seconds' },
      { factor: 60, label: 'minutes' },
      { factor: 3600, label: 'hours' },
      { factor: 86400, label: 'days' },
    ],
    bytes: [
      { factor: 1, label: 'bytes' },
      { factor: 1024, label: 'KB' },
      { factor: 1024 * 1024, label: 'MB' },
      { factor: 1024 * 1024 * 1024, label: 'GB' },
    ],
  }

  function splitAmount(total, scale, preferred) {
    const whole = Number(total)
    if (!Number.isFinite(whole)) return { amount: 0, factor: 1 }
    if (preferred && whole % preferred === 0) return { amount: whole / preferred, factor: preferred }
    if (whole === 0) return { amount: 0, factor: preferred || 1 }

    for (let i = scale.length - 1; i >= 0; i--) {
      const step = scale[i]
      if (whole % step.factor === 0) return { amount: whole / step.factor, factor: step.factor }
    }
    return { amount: whole, factor: 1 }
  }

  function notice(title, text) {
    $('noticeTitle').textContent = title
    $('noticeText').textContent = text
    $('noticeModal').hidden = false
    $('noticeOk').focus()
  }

  $('noticeOk').addEventListener('click', () => {
    $('noticeModal').hidden = true
  })

  function readOnlyGroup(id) {
    const here = state.settings.filter((entry) => entry.group === id)
    return here.length > 0 && here.every((entry) => entry.readOnly === true)
  }

  function buildRail() {
    const host = $('railGroups')
    host.replaceChildren()

    let divided = false
    for (const group of state.groups) {
      if (!divided && readOnlyGroup(group.id)) {
        const rule = document.createElement('div')
        rule.className = 'rail__divider'
        host.appendChild(rule)
        divided = true
      }

      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'rail__item'
      item.dataset.tab = group.id
      item.textContent = group.title
      item.addEventListener('click', () => showTab(group.id))
      host.appendChild(item)
    }
  }

  const PANELS = ['people', 'kfx', 'backup', 'restart']

  function showTab(name) {
    const known = [...PANELS, ...state.groups.map((group) => group.id)]
    const tab = known.includes(name) ? name : 'people'
    state.tab = tab

    $('panel-people').hidden = tab !== 'people'
    $('panel-kfx').hidden = tab !== 'kfx'
    $('panel-backup').hidden = tab !== 'backup'
    $('panel-restart').hidden = tab !== 'restart'
    $('panel-settings').hidden = PANELS.includes(tab)

    for (const item of document.querySelectorAll('.rail__item')) {
      const here = item.dataset.tab === tab
      item.classList.toggle('is-active', here)
      item.setAttribute('aria-current', here ? 'true' : 'false')
      if (here) keepInTheRail(item)
    }

    if (!PANELS.includes(tab)) renderGroup(tab)
    history.replaceState(null, '', `#${tab}`)
  }

  for (const item of document.querySelectorAll('.rail__item[data-tab]')) {
    if (item.parentElement.id !== 'railGroups') {
      item.addEventListener('click', () => showTab(item.dataset.tab))
    }
  }

  page.on(window, 'hashchange', () => showTab(window.location.hash.replace('#', '')))

  async function renderExtensions() {
    const result = await send('/api/admin/extensions')
    if (gone() || !result.ok || !result.data?.extensions) return

    const list = result.data.extensions
    $('kfxList').innerHTML = list
      .map((one) => {
        const mark = one.installed ? '&plus;' : '&minus;'
        const words = one.installed
          ? t('Installed')
          : one.pending
            ? t('Installing now')
            : (one.blocked ?? t('Not installed'))
        return `<dt class="${one.installed ? '' : 'is-muted'}">${mark}</dt><dd class="${one.installed ? '' : 'is-muted'}">${t(one.label)} — ${words}</dd>`
      })
      .join('')

    const installed = list.filter((one) => one.installed).length
    $('kfxState').textContent = result.data.busy
      ? t('Something is installing')
      : t('{n} of {total} installed', { n: installed, total: list.length })
  }

  async function load() {
    const [config, people] = await Promise.all([
      send('/api/admin/settings'),
      send('/api/admin/users'),
    ])
    if (gone()) return false

    if (!config.ok || !people.ok) {
      notice(t('That did not load'), t('The server would not hand over the settings. Try reloading.'))
      return false
    }

    state.groups = config.data.groups
    state.settings = config.data.settings
    state.users = people.data.users
    state.canRestart = config.data.canRestart === true
    state.addressPending = config.data.addressPending === true
    state.runningAddress = config.data.runningAddress || ''
    buildRail()
    renderAddressNotice()

    renderBackup(config.data.backup)
    renderRestore(config.data.restore)

    $('restartGo').disabled = !state.canRestart
    $('restartGo').classList.toggle('is-armed', state.canRestart)
    $('restartUnsupported').hidden = state.canRestart
    return true
  }

  function renderBackup(facts) {
    if (!facts) return
    const books = facts.books === 1 ? t('One book') : t('{n} books', { n: facts.books })
    const people = facts.accounts === 1 ? t('one account') : t('{n} accounts', { n: facts.accounts })

    $('backupAccounts').textContent = t(
      '{people}, their devices, their sessions and everything set on this page',
      { people: `${people[0].toUpperCase()}${people.slice(1)}` }
    )
    $('backupBooks').textContent =
      facts.books === 0
        ? t('No books are kept right now, so the archive is the database alone')
        : t('{books} kept in the library, {size} of them', { books, size: bytes(facts.bytes) })
    $('backupSize').textContent =
      facts.books === 0 ? '' : t('About {size} before compression', { size: bytes(facts.bytes) })
  }

  function sayRestore(text, bad) {
    $('restoreMsg').className = bad ? 'save-row__msg is-error' : 'save-row__msg'
    $('restoreMsg').textContent = text
  }

  function renderRestore(held) {
    state.restore = held ?? null
    $('restoreStaged').hidden = !held
    if (!held) return

    $('restoreName').textContent = held.name
    $('restoreFacts').textContent = t(
      '{size}, uploaded {when}. Nothing changes until the next start.',
      { size: bytes(held.size), when: ago(held.stagedAt).toLowerCase() }
    )
  }

  $('restoreFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    $('restoreFile').value = ''
    if (!file) return

    if (!/\.tar\.gz$|\.tgz$/i.test(file.name)) {
      sayRestore(t('That is not a .tar.gz — use the archive this page downloads.'), true)
      return
    }

    sayRestore(t('Uploading {size}…', { size: bytes(file.size) }), false)
    const body = new FormData()
    body.append('file', file, file.name)

    const result = await send('/api/admin/restore', { method: 'POST', body })
    if (gone()) return
    if (!result.ok) {
      sayRestore(result.data?.error || t('The server would not take it.'), true)
      return
    }
    sayRestore('', false)
    renderRestore(result.data.staged)
  })

  $('restoreDrop').addEventListener('click', async () => {
    const result = await send('/api/admin/restore', { method: 'DELETE' })
    if (gone()) return
    if (!result.ok) {
      notice(t('Not removed'), result.data?.error || t('The server refused.'))
      return
    }
    sayRestore(t('Thrown away. Nothing was changed.'), false)
    renderRestore(null)
  })

  $('restoreGo').addEventListener('click', () => {
    const held = state.restore
    if (!held) return

    $('restoreModalWhat').textContent = t('{name}, {size}, replaces what is here.', {
      name: held.name,
      size: bytes(held.size),
    })
    $('restoreModalHow').textContent = state.canRestart
      ? t('Reboot restarts the container now, back on the archive within seconds.')
      : t('Not in a container — Reboot marks the archive and you restart the server yourself.')
    $('restoreModal').hidden = false
    $('restoreCancel').focus()
  })

  $('restoreCancel').addEventListener('click', () => {
    $('restoreModal').hidden = true
  })

  $('restoreReboot').addEventListener('click', async () => {
    $('restoreReboot').disabled = true
    const result = await send('/api/admin/restore/confirm', { method: 'POST' })
    if (gone()) return

    $('restoreReboot').disabled = false
    if (!result.ok) {
      $('restoreModal').hidden = true
      notice(t('Not restored'), result.data?.error || t('The server refused.'))
      return
    }

    $('restoreModal').hidden = true
    if (!result.data.restarting) {
      notice(t('Marked for the next start'), t('Restart the server when you are ready.'))
      await load()
      return
    }

    showTab('restart')
    $('restartWaiting').hidden = false
    $('restartWaitingTitle').textContent = t('Restoring…')
    $('restartWaitingMeta').textContent = t('WIPING AND UNPACKING BEFORE IT ANSWERS AGAIN')
    void waitForTheServer()
  })

  $('restoreCopy').addEventListener('click', async () => {
    const copied = await copyText($('restoreLine').textContent)
    $('restoreCopy').textContent = copied ? t('Copied') : t('Copy failed')
    page.after(2000, () => {
      $('restoreCopy').textContent = t('Copy')
    })
  })

  function askAboutPasskeys(count) {
    $('passkeyWarnCount').textContent =
      count === 1
        ? t('One account has a passkey. It stops working the moment the address moves.')
        : t('{n} accounts have a passkey. They stop working the moment the address moves.', {
            n: count,
          })
    $('passkeyWarnModal').hidden = false
    $('passkeyWarnGo').focus()

    return new Promise((resolve) => {
      const close = (answer) => {
        $('passkeyWarnModal').hidden = true
        $('passkeyWarnGo').removeEventListener('click', yes)
        $('passkeyWarnCancel').removeEventListener('click', no)
        resolve(answer)
      }
      const yes = () => close(true)
      const no = () => close(false)
      $('passkeyWarnGo').addEventListener('click', yes)
      $('passkeyWarnCancel').addEventListener('click', no)
    })
  }

  async function apply(key, value, understood = false) {
    const result = await send('/api/admin/settings', {
      method: 'PUT',
      ...asJson(understood ? { key, value, passkeysUnderstood: true } : { key, value }),
    })
    if (gone()) return

    if (result.status === 409 && result.data?.needsPasskeyConfirmation) {
      const agreed = await askAboutPasskeys(result.data.passkeysAffected ?? 0)
      if (gone()) return
      if (agreed) return apply(key, value, true)

      renderGroup(state.tab)
      return
    }

    if (!result.ok) {
      notice(t('Not saved'), result.data?.error || t('The server refused that value.'))
      await load()
      renderGroup(state.tab)
      return
    }
    state.settings = result.data.settings
    state.addressPending = result.data.addressPending === true
    renderGroup(state.tab)
    renderAddressNotice()
  }

  async function reset(key) {
    const result = await send(`/api/admin/settings/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    })
    if (gone()) return
    if (!result.ok) {
      notice(t('Not reset'), result.data?.error || t('The server refused.'))
      return
    }
    state.settings = result.data.settings
    state.addressPending = result.data.addressPending === true
    renderGroup(state.tab)
    renderAddressNotice()
  }

  const frozen = (spec) => spec.locked === true || spec.readOnly === true

  const ORIGIN = {
    environment: (key) => t('Set in the environment — change {key} there and restart', { key }),
    generated: (key) => t('Generated on first boot — replace {key} in the environment', { key }),
    default: (key) => t('Built-in default — set {key} in the environment', { key }),
  }

  function statusLine(spec) {
    if (spec.locked) return t('Locked in the environment')
    if (spec.readOnly) return (ORIGIN[spec.origin] || ORIGIN.default)(spec.key)
    if (!spec.overridden) return ''
    if (!spec.changed) return t('Changed from this page')
    return t('Changed from this page by {who}, {when}', {
      who: spec.changed.by,
      when: ago(spec.changed.at).toLowerCase(),
    })
  }

  function copyButton(spec, loose = false) {
    const line = `${spec.key}=${spec.value}`

    const button = document.createElement('button')
    button.type = 'button'
    button.className = loose ? 'admin-key__copy admin-key__copy--loose' : 'admin-key__copy'
    button.title = t('Copy {line}', { line })
    button.setAttribute('aria-label', t('Copy {line}', { line }))

    const icon = document.createElement('i')
    icon.className = 'ph ph-copy'
    icon.setAttribute('aria-hidden', 'true')
    button.appendChild(icon)

    const word = document.createElement('span')
    word.className = 'admin-key__copy-word'
    word.textContent = t('Copy')
    if (!loose) button.appendChild(word)

    button.addEventListener('click', async () => {
      if (!(await copyText(line))) return
      icon.className = 'ph ph-check'
      word.textContent = t('Copied')
      button.classList.add('is-done')
      page.after(1600, () => {
        icon.className = 'ph ph-copy'
        word.textContent = t('Copy')
        button.classList.remove('is-done')
      })
    })
    return button
  }

  function inField(field, spec) {
    if (spec.kind === 'secret') return field

    const wrap = document.createElement('span')
    wrap.className = 'admin-key__field'
    if (field.classList.contains('field--amount')) wrap.classList.add('admin-key__field--amount')
    wrap.appendChild(field)
    wrap.appendChild(copyButton(spec))
    return wrap
  }

  function footFor(spec) {
    const foot = document.createElement('div')
    foot.className = 'admin-key__foot'

    const line = statusLine(spec)
    if (line) {
      const said = document.createElement('span')
      said.className = 'admin-key__said'
      said.textContent = line
      foot.appendChild(said)
    }

    if (spec.overridden && !spec.locked) {
      const undo = document.createElement('button')
      undo.type = 'button'
      undo.className = 'btn-link'
      undo.textContent = t('Reset')
      undo.addEventListener('click', () => reset(spec.key))
      foot.appendChild(undo)
    }
    return foot
  }

  function restartChip() {
    const chip = document.createElement('span')
    chip.className = 'admin-key__chip'
    chip.textContent = t('NEEDS A RESTART')
    return chip
  }

  function prefRow(spec, on) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'pref'
    row.disabled = frozen(spec)

    const text = document.createElement('span')
    text.className = 'pref__text'

    const head = document.createElement('span')
    head.className = 'admin-key__head'

    const label = document.createElement('span')
    label.className = 'pref__label'
    label.textContent = spec.label
    head.appendChild(label)
    if (spec.restart) head.appendChild(restartChip())
    text.appendChild(head)

    const desc = document.createElement('span')
    desc.className = 'pref__desc'
    desc.textContent = spec.note
    if (spec.note) text.appendChild(desc)

    row.appendChild(text)

    const toggle = document.createElement('span')
    toggle.className = on ? 'toggle is-on' : 'toggle'
    const knob = document.createElement('span')
    knob.className = 'toggle__knob'
    toggle.appendChild(knob)
    row.appendChild(toggle)

    return row
  }

  function toggleLine(row, spec, copy) {
    const line = document.createElement('div')
    line.className = 'admin-key__line'
    line.appendChild(row)
    if (copy) line.appendChild(copyButton(spec, true))
    return line
  }

  function renderToggle(spec) {
    const block = document.createElement('div')
    block.className = 'admin-key'

    const row = prefRow(spec, spec.value === 'true')
    if (!frozen(spec)) {
      row.addEventListener('click', () => apply(spec.key, spec.value === 'true' ? 'false' : 'true'))
    }

    block.appendChild(toggleLine(row, spec, true))
    block.appendChild(footFor(spec))
    return block
  }

  const OFF_WORDS = ['', '0', 'false', 'no', 'off', 'none']
  const ON_WORDS = ['1', 'true', 'yes', 'on']

  const switchedOn = (value) => !OFF_WORDS.includes(String(value).trim().toLowerCase())
  const addressOf = (value) => (ON_WORDS.includes(String(value).trim().toLowerCase()) ? '' : value)

  function renderToggled(spec) {
    const block = document.createElement('div')
    block.className = 'admin-key'

    const on = state.switched[spec.key] ?? switchedOn(spec.value)

    const row = prefRow(spec, on)
    if (!frozen(spec)) {
      row.addEventListener('click', () => {
        if (on) {
          delete state.switched[spec.key]
          void apply(spec.key, 'false')
          return
        }
        state.switched[spec.key] = true
        renderGroup(state.tab)
        $(`key-${spec.key}`)?.focus()
      })
    }

    block.appendChild(toggleLine(row, spec, true))

    if (on) {
      const field = document.createElement('input')
      field.className = 'field field--inline'
      field.id = `key-${spec.key}`
      field.type = 'text'
      field.value = addressOf(spec.value)
      field.placeholder = spec.placeholder
      field.spellcheck = false
      field.disabled = frozen(spec)

      const row2 = document.createElement('div')
      row2.className = 'field-row'
      row2.appendChild(field)
      block.appendChild(row2)

      let last = field.value
      field.addEventListener('change', () => {
        const typed = field.value.trim()
        if (typed === last) return
        last = typed
        state.switched[spec.key] = true
        void apply(spec.key, typed)
      })
    }

    block.appendChild(footFor(spec))
    return block
  }

  function renderTextual(spec, beside) {
    const block = document.createElement('div')
    block.className = 'admin-key'

    const head = document.createElement('div')
    head.className = 'admin-key__head'

    const label = document.createElement('span')
    label.className = 'admin-key__label'
    label.textContent = spec.label
    head.appendChild(label)

    if (spec.restart) head.appendChild(restartChip())
    block.appendChild(head)

    if (spec.note) {
      const note = document.createElement('p')
      note.className = 'admin-key__note'
      note.textContent = spec.note
      block.appendChild(note)
    }

    const row = document.createElement('div')
    row.className = 'field-row'

    const scale = SCALES[spec.unit]
    const scaled = scale ? splitAmount(spec.value, scale, state.units[spec.key]) : null

    if (spec.kind === 'choice') return renderChoice(spec, block)

    const field = document.createElement('input')
    field.className =
      spec.kind === 'int' ? 'field field--inline field--amount' : 'field field--inline'
    field.id = `key-${spec.key}`
    field.type = spec.kind === 'secret' ? 'password' : spec.kind === 'int' ? 'number' : 'text'
    field.value = scaled ? String(scaled.amount) : spec.value
    field.disabled = frozen(spec)
    field.spellcheck = false
    if (spec.kind === 'secret') {
      field.autocomplete = 'new-password'
      field.placeholder = spec.isSet ? '••••••••••••' : t('Not set')
    } else if (spec.placeholder) {
      field.placeholder = spec.placeholder
    }

    const divisor = scaled ? scaled.factor : 1
    if (spec.min !== null) field.min = String(Math.ceil(spec.min / divisor))
    if (spec.max !== null) field.max = String(Math.floor(spec.max / divisor))
    row.appendChild(inField(field, spec))

    let picker = null
    if (scale) {
      picker = document.createElement('select')
      picker.className = 'field field--inline field--unit'
      picker.id = `unit-${spec.key}`
      picker.disabled = frozen(spec)
      for (const step of scale) {
        const option = document.createElement('option')
        option.value = String(step.factor)
        option.textContent = t(step.label)
        picker.appendChild(option)
      }
      picker.value = String(divisor)
      row.appendChild(picker)
    } else if (spec.unit) {
      const unit = document.createElement('span')
      unit.className = 'save-row__msg'
      unit.textContent = spec.unit
      row.appendChild(unit)
    }

    if (beside && beside.kind === 'choice') {
      const mine = state.settings.indexOf(spec)
      const theirs = state.settings.indexOf(beside)
      const control = choiceControl(beside)
      if (theirs >= 0 && theirs < mine) row.insertBefore(control, row.firstChild)
      else row.appendChild(control)
    }

    block.appendChild(row)

    if (beside?.note) {
      const extra = document.createElement('p')
      extra.className = 'admin-key__note'
      extra.textContent = beside.note
      block.appendChild(extra)
    }

    block.appendChild(footFor(spec))
    if (beside && statusLine(beside)) block.appendChild(footFor(beside))

    let last = spec.value
    const commit = () => {
      const typed = field.value.trim()
      if (typed === '') return

      const value = scale ? String(Number(typed) * Number(picker.value)) : typed
      if (value === last) return
      if (spec.kind === 'secret' && value === '') return
      last = value
      void apply(spec.key, value)
    }

    field.addEventListener('change', commit)
    if (picker) {
      picker.addEventListener('change', () => {
        state.units[spec.key] = Number(picker.value)
        commit()
        renderGroup(state.tab)
      })
    }

    return block
  }

  function choiceControl(spec) {
    const holder = document.createElement('span')
    holder.className = 'admin-key__pair'

    const picker = document.createElement('select')
    picker.className = 'field field--inline field--choice'
    picker.id = `key-${spec.key}`
    picker.disabled = frozen(spec)

    for (const choice of spec.choices || []) {
      const option = document.createElement('option')
      option.value = choice.value
      option.textContent = choice.label
      picker.appendChild(option)
    }
    picker.value = spec.value

    picker.addEventListener('change', async () => {
      await apply(spec.key, picker.value)
      if (spec.key === 'SMTP_SECURITY') await suggestPort(picker.value)
    })

    holder.appendChild(picker)
    holder.appendChild(copyButton(spec, true))
    return holder
  }

  function renderChoice(spec, block) {
    const row = document.createElement('div')
    row.className = 'field-row'
    row.appendChild(choiceControl(spec))

    block.appendChild(row)
    block.appendChild(footFor(spec))
    return block
  }

  const PORT_FOR = { starttls: '587', ssl: '465', none: '25' }
  const CONVENTIONAL = ['25', '465', '587']

  async function suggestPort(security) {
    const wanted = PORT_FOR[security]
    if (!wanted) return

    const port = state.settings.find((entry) => entry.key === 'SMTP_PORT')
    if (!port || frozen(port) || port.value === wanted) return
    if (!CONVENTIONAL.includes(port.value)) return

    await apply('SMTP_PORT', wanted)
  }

  function renderAddressNotice() {
    const box = $('addressPending')
    box.hidden = !state.addressPending
    if (!state.addressPending) return

    const wanted = state.settings.find((entry) => entry.key === 'DOMAIN')?.value ?? ''
    const scheme = state.settings.find((entry) => entry.key === 'PROTOCOL')?.value ?? 'http'

    $('addressNow').textContent = state.runningAddress
    $('addressText').textContent = t(
      'Everything still uses that until a restart moves it to {address}.',
      { address: `${scheme}://${wanted}` }
    )
    $('addressRestart').disabled = !state.canRestart
  }

  $('addressRestart').addEventListener('click', () => showTab('restart'))

  const BEHIND = {
    SMTP_HOST: 'SMTP_ENABLED',
    SMTP_PORT: 'SMTP_ENABLED',
    SMTP_SECURITY: 'SMTP_ENABLED',
    SMTP_TLS: 'SMTP_ENABLED',
    SMTP_USERNAME: 'SMTP_ENABLED',
    SMTP_PASSWORD: 'SMTP_ENABLED',
    SMTP_FROM_EMAIL: 'SMTP_ENABLED',
    SMTP_FROM_NAME: 'SMTP_ENABLED',
    SMTP_TIMEOUT_SECONDS: 'SMTP_ENABLED',
    OIDC_PROVIDER_NAME: 'OIDC_ENABLED',
    OIDC_CONFIG_URL: 'OIDC_ENABLED',
    OIDC_CLIENT_ID: 'OIDC_ENABLED',
    OIDC_CLIENT_SECRET: 'OIDC_ENABLED',
    OIDC_ADMIN_GROUP: 'OIDC_ENABLED',
  }

  function shown(spec) {
    const parent = BEHIND[spec.key]
    if (!parent) return true
    return state.settings.find((entry) => entry.key === parent)?.value === 'true'
  }

  function renderGroup(id) {
    const group = state.groups.find((entry) => entry.id === id)
    if (!group) return

    $('groupTitle').textContent = group.title
    $('groupIntro').textContent = group.intro

    const host = $('keys')
    host.replaceChildren()

    const here = state.settings.filter((entry) => entry.group === id).filter(shown)
    const inlined = new Map()
    for (const spec of here) {
      if (spec.inlineWith) inlined.set(spec.inlineWith, spec)
    }

    let toggles = null
    for (const spec of here) {
      if (spec.inlineWith) continue
      if (spec.kind === 'toggled') {
        toggles = null
        host.appendChild(renderToggled(spec))
        continue
      }
      if (spec.kind !== 'bool') {
        toggles = null
        host.appendChild(renderTextual(spec, inlined.get(spec.key)))
        continue
      }
      if (!toggles) {
        toggles = document.createElement('div')
        toggles.className = 'pref-list'
        host.appendChild(toggles)
      }
      toggles.appendChild(renderToggle(spec))
    }
  }

  function initials(person) {
    const letters = `${person.firstName[0] ?? ''}${person.lastName[0] ?? ''}`.toUpperCase()
    return letters || person.email[0].toUpperCase()
  }

  function renderPeople() {
    const host = $('people')
    host.replaceChildren()

    for (const person of state.users) {
      const row = document.createElement('div')
      row.className = 'admin-person'

      const avatar = document.createElement('div')
      avatar.className = 'admin-person__avatar'
      avatar.textContent = initials(person)
      row.appendChild(avatar)

      const who = document.createElement('div')
      who.className = 'admin-person__who'

      const name = document.createElement('div')
      name.className = 'admin-person__name'
      name.textContent =
        person.firstName || person.lastName
          ? `${person.firstName} ${person.lastName}`.trim()
          : t('No name given')
      if (!person.firstName && !person.lastName) name.classList.add('is-muted')
      who.appendChild(name)

      const mail = document.createElement('div')
      mail.className = 'admin-person__mail'
      mail.textContent = person.email
      who.appendChild(mail)

      const tags = document.createElement('div')
      tags.className = 'admin-person__tags'
      const badges = []
      if (person.isAdmin) badges.push(t('ADMIN'))
      if (person.id === state.me?.id) badges.push(t('YOU'))
      if (!person.emailVerified) badges.push(t('UNVERIFIED'))
      if (person.totpEnabled) badges.push(t('TWO-FACTOR'))
      if (!person.hasPassword) badges.push(t('SSO ONLY'))
      for (const text of badges) {
        const tag = document.createElement('span')
        tag.className = 'admin-person__tag'
        tag.textContent = text
        tags.appendChild(tag)
      }
      who.appendChild(tags)
      row.appendChild(who)

      const facts = document.createElement('div')
      facts.className = 'admin-person__facts'
      const kept = person.books === 1 ? t('1 book kept') : t('{n} books kept', { n: person.books })
      facts.textContent = t('{kept} · signed in {when}', {
        kept,
        when: ago(person.lastLoginAt).toLowerCase(),
      })
      row.appendChild(facts)

      const actions = document.createElement('div')
      actions.className = 'admin-person__actions'

      if (!person.isFounder) {
        const grant = document.createElement('button')
        grant.type = 'button'
        grant.className = 'btn-link'
        grant.textContent = person.isAdmin ? t('Take away admin') : t('Make admin')
        grant.addEventListener('click', () => setAdmin(person, !person.isAdmin))
        actions.appendChild(grant)
      }

      if (!person.isFounder && person.id !== state.me?.id) {
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'btn-link btn-link--danger'
        remove.textContent = t('Delete')
        remove.addEventListener('click', () => askToDelete(person))
        actions.appendChild(remove)
      }

      row.appendChild(actions)
      host.appendChild(row)
    }

    $('peopleEmpty').hidden = state.users.length > 1
  }

  async function setAdmin(person, isAdmin) {
    const result = await send(`/api/admin/users/${encodeURIComponent(person.id)}/admin`, {
      method: 'POST',
      ...asJson({ isAdmin }),
    })
    if (gone()) return
    if (!result.ok) {
      notice(t('Not changed'), result.data?.error || t('The server refused.'))
      return
    }
    await refreshPeople()
  }

  function askToDelete(person) {
    state.pending = person
    const named =
      person.firstName || person.lastName
        ? `${person.firstName} ${person.lastName}`.trim()
        : person.email
    const kept =
      person.books === 0
        ? t('Nothing is kept for this account.')
        : person.books === 1
          ? t('The one book they kept goes with it.')
          : t('The {n} books they kept go with it.', { n: person.books })
    $('confirmText').textContent = t('{name} — {email}. {kept}', {
      name: named,
      email: person.email,
      kept,
    })
    $('confirmModal').hidden = false
    $('confirmCancel').focus()
  }

  $('confirmCancel').addEventListener('click', () => {
    $('confirmModal').hidden = true
    state.pending = null
  })

  $('confirmGo').addEventListener('click', async () => {
    const person = state.pending
    if (!person) return
    $('confirmModal').hidden = true
    state.pending = null

    const result = await send(`/api/admin/users/${encodeURIComponent(person.id)}`, {
      method: 'DELETE',
    })
    if (gone()) return
    if (!result.ok) {
      notice(t('Not deleted'), result.data?.error || t('The server refused.'))
      return
    }
    await refreshPeople()
  })

  async function waitForTheServer() {
    const started = Date.now()
    while (page.alive && Date.now() - started < 120000) {
      await new Promise((r) => page.after(1500, r))
      if (!page.alive) return
      try {
        const res = await fetch('/healthz', { cache: 'no-store' })
        if (res.ok) {
          window.location.reload()
          return
        }
      } catch {
      }
    }
    if (!page.alive) return
    $('restartWaitingTitle').textContent = t('It has not come back')
    $('restartWaitingMeta').textContent = t('CHECK THE CONTAINER — IT MAY HAVE FAILED TO START')
  }

  $('restartGo').addEventListener('click', async () => {
    $('restartGo').disabled = true
    const result = await send('/api/admin/restart', { method: 'POST' })
    if (gone()) return

    if (!result.ok) {
      $('restartGo').disabled = false
      notice(t('Not restarted'), result.data?.error || t('The server refused.'))
      return
    }

    $('restartWaiting').hidden = false
    void waitForTheServer()
  })

  async function refreshPeople() {
    const people = await send('/api/admin/users')
    if (gone() || !people.ok) return
    state.users = people.data.users
    renderPeople()
  }

  const status = await getStatus()
  if (gone()) return
  state.me = status?.user ?? null

  if (!(await load())) return
  if (gone()) return

  renderPeople()
  void renderExtensions()
  showTab(window.location.hash.replace('#', ''))
})
