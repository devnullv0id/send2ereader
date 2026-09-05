'use strict'

onPage('history', async (page) => {
  const $ = (id) => document.getElementById(id)
  const VIEW_KEY = 's2e_history_view'

  let whyNoDownload = t('Sign in and turn keeping on to download books again')

  function renderLocal() {
    const entries = History.all()
    const any = entries.length > 0

    $('empty').hidden = any
    $('rows').hidden = !any
    $('clearbtn').hidden = !any

    const tpl = $('rowTpl')
    $('list').replaceChildren(
      ...entries.map((entry) => {
        const row = tpl.content.firstElementChild.cloneNode(true)
        row.querySelector('.list__dot').classList.add(entry.ok ? 'is-ok' : 'is-error')
        row.querySelector('.list__name').textContent = entry.filename
        row.querySelector('.list__meta').textContent = [
          entry.destination ? t(entry.destination.toUpperCase()) : '',
          entry.format?.toUpperCase(),
          size(entry.size),
          ago(entry.at),
        ]
          .filter(Boolean)
          .join(' · ')

        row.querySelector('.list__collect').title = whyNoDownload

        row.querySelector('.list__cancel').addEventListener('click', () => {
          History.drop(entry.at)
          renderLocal()
        })
        return row
      })
    )
  }

  let books = []
  let ticking = []

  function pad(n) {
    return n < 10 ? `0${n}` : `${n}`
  }

  function remaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000))
    const d = Math.floor(total / 86400)
    const h = Math.floor((total % 86400) / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return t('{d}D {h}H {m}M {s}S LEFT', { d: pad(d), h: pad(h), m: pad(m), s: pad(s) })
  }

  function by(authors) {
    return Array.isArray(authors) && authors.length ? authors.join(', ') : ''
  }

  let drawnSecond = -1

  function tick() {
    const now = Date.now()
    const second = Math.floor(now / 1000)
    const relabel = second !== drawnSecond
    drawnSecond = second

    for (const item of ticking) {
      const left = item.until - now
      const span = item.until - item.from
      const fraction = span > 0 ? Math.max(0, Math.min(1, left / span)) : 0
      item.bar.style.setProperty('--prog', `${(fraction * 100).toFixed(4)}%`)
      if (!relabel) continue
      item.label.textContent = remaining(left)
      item.expiry.classList.toggle('is-soon', left < 7200000)
    }
  }

  function renderKept() {
    const any = books.length > 0
    $('emptyKept').hidden = any
    $('rows').hidden = !any
    $('views').hidden = !any

    ticking = []
    drawnSecond = -1

    const tpl = $('keptTpl')
    $('list').replaceChildren(
      ...books.map((book) => {
        const row = tpl.content.firstElementChild.cloneNode(true)

        const spine = row.querySelector('.list__spine')
        if (book.hasCover) {
          const cover = row.querySelector('.list__cover')
          cover.addEventListener('error', () => {
            cover.hidden = true
            spine.hidden = false
          })
          cover.src = `/api/library/${encodeURIComponent(book.id)}/cover`
          cover.hidden = false
          spine.hidden = true
        }

        row.querySelector('.list__name').textContent = book.title || book.name
        const author = by(book.authors)
        const byline = row.querySelector('.list__by')
        byline.textContent = author
        byline.hidden = !author

        row.querySelector('.list__meta').textContent = [
          book.format?.toUpperCase(),
          size(book.size),
          book.source === 'convert' ? t('CONVERTED') : t('SENT'),
          ago(book.createdAt),
        ]
          .filter(Boolean)
          .join(' · ')

        const collect = row.querySelector('.list__collect')
        collect.href = `/api/library/${encodeURIComponent(book.id)}/download`
        collect.setAttribute('download', book.name)

        row.querySelector('.list__cancel').addEventListener('click', () => remove(book))

        ticking.push({
          expiry: row.querySelector('.expiry'),
          bar: row.querySelector('.expiry__bar'),
          label: row.querySelector('.expiry__label'),
          from: Date.parse(book.createdAt),
          until: Date.parse(book.expiresAt),
        })
        return row
      })
    )

    const tile = $('tileTpl')
    $('tiles').replaceChildren(
      ...books.map((book) => {
        const node = tile.content.firstElementChild.cloneNode(true)
        node.href = `/api/library/${encodeURIComponent(book.id)}/download`
        node.setAttribute('download', book.name)
        const author = by(book.authors)
        node.title = author ? `${book.title} — ${author}` : book.title
        node.setAttribute('aria-label', node.title)

        const spine = node.querySelector('.tile__spine')
        node.querySelector('.tile__title').textContent = book.title || book.name
        if (book.hasCover) {
          const cover = node.querySelector('.tile__cover')
          cover.addEventListener('error', () => {
            cover.hidden = true
            spine.hidden = false
          })
          cover.src = `/api/library/${encodeURIComponent(book.id)}/cover`
          cover.hidden = false
        } else {
          spine.hidden = false
        }
        return node
      })
    )

    tick()
  }

  async function load() {
    try {
      const res = await fetch('/api/library/books', { credentials: 'same-origin' })
      if (!res.ok || !page.alive) return
      const data = await res.json()
      books = data.books || []
      renderKept()
    } catch {
    }
  }

  // Matched on the book id, never the filename two sends of the same book would share.
  async function remove(book) {
    try {
      await sendJson('DELETE', `/api/library/${encodeURIComponent(book.id)}`)
    } catch {
    }
    for (const entry of History.all()) {
      if (entry.bookId === book.id) History.drop(entry.at)
    }
    await load()
  }

  function setView(view) {
    const tiles = view === 'tiles'
    $('views').dataset.seg = tiles ? '1' : '0'
    for (const option of $('views').querySelectorAll('.auth-modes__option')) {
      option.classList.toggle('is-selected', (option.dataset.view === 'tiles') === tiles)
    }
    $('list').hidden = tiles
    $('tiles').hidden = !tiles
    try {
      window.localStorage.setItem(VIEW_KEY, tiles ? 'tiles' : 'list')
    } catch {
    }
  }

  for (const option of $('views').querySelectorAll('.auth-modes__option')) {
    option.addEventListener('click', () => setView(option.dataset.view))
  }

  $('clearbtn').addEventListener('click', () => {
    History.clear()
    renderLocal()
  })

  const status = await getStatus()
  if (!page.alive) return

  let kept = false
  let ceiling = 0
  if (status?.user) {
    try {
      const res = await fetch('/api/library/books', { credentials: 'same-origin' })
      if (!page.alive) return
      if (res.ok) {
        const data = await res.json()
        books = data.books || []
        kept = (data.retainMinutes || 0) > 0 || books.length > 0
        ceiling = data.ceilingMinutes || 0
      }
    } catch {
    }
  }

  const adminOff = Boolean(status?.user) && !kept && ceiling === 0
  const mine = Boolean(status?.user) && !kept && ceiling > 0

  if (adminOff) whyNoDownload = t('The administrator turned off keeping books on this server')
  else if (mine)
    whyNoDownload = t('Keeping is off for your account — turn it on under Settings → History')

  $('subLocal').hidden = kept || mine || adminOff
  $('subLocalUser').hidden = !mine
  $('subLocalAdmin').hidden = !adminOff
  $('subKept').hidden = !kept
  $('noteLocal').hidden = kept || mine || adminOff
  $('noteLocalUser').hidden = !mine
  $('noteLocalAdmin').hidden = !adminOff
  $('noteKept').hidden = !kept
  $('empty').hidden = true
  $('emptyKept').hidden = true

  if (!kept) {
    $('views').hidden = true
    $('tiles').hidden = true
    $('list').hidden = false
    renderLocal()
    return
  }

  $('clearbtn').hidden = true

  let saved = 'list'
  try {
    saved = window.localStorage.getItem(VIEW_KEY) === 'tiles' ? 'tiles' : 'list'
  } catch {
  }
  setView(saved)
  renderKept()

  page.frame(() => {
    if (!ticking.length || document.hidden) return
    tick()
  })
  page.every(60000, () => {
    if (!document.hidden) void load()
  })
})
