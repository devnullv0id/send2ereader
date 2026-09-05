'use strict'

onPage('waiting', async (page) => {
  const $ = (id) => document.getElementById(id)

  const status = await getStatus()
  if (!page.alive) return
  if (!status?.user) {
    window.location.href = '/login?next=%2Fwaiting'
    return
  }

  let books = []
  let ttlSeconds = 0

  function remaining(seconds) {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return h > 0 ? t('{h}H {m}M LEFT', { h, m }) : t('{m}M LEFT', { m })
  }

  function format(name) {
    if (/\.kepub\.epub$/i.test(name)) return t('KOBO EPUB')
    return (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toUpperCase()
  }

  function render() {
    const any = books.length > 0
    $('empty').hidden = any
    $('rows').hidden = !any
    $('cancelall').hidden = !any

    const tpl = $('rowTpl')
    $('list').replaceChildren(
      ...books.map((book) => {
        const row = tpl.content.firstElementChild.cloneNode(true)
        row.querySelector('.list__name').textContent = book.title || book.name
        row.querySelector('.list__meta').textContent = t('{format} · {size} · QUEUED {when}', {
          format: format(book.name),
          size: size(book.size),
          when: ago(book.queuedAt),
        })

        const left = ttlSeconds ? Math.max(0, (book.expiresIn / ttlSeconds) * 100) : 0
        const expiry = row.querySelector('.expiry')
        expiry.classList.toggle('is-soon', book.expiresIn < 7200)
        expiry.querySelector('.expiry__bar').style.setProperty('--prog', `${Math.round(left)}%`)
        expiry.querySelector('.expiry__label').textContent = remaining(book.expiresIn)

        const collect = row.querySelector('.list__collect')
        collect.href = `/api/waiting/${encodeURIComponent(book.id)}/download`
        collect.setAttribute('download', book.name)

        row.querySelector('.list__cancel').addEventListener('click', () => cancel(book.id))
        return row
      })
    )
  }

  async function load() {
    try {
      const res = await fetch('/api/waiting', { credentials: 'same-origin' })
      if (!res.ok || !page.alive) return
      const data = await res.json()
      books = data.books || []
      ttlSeconds = data.ttlSeconds || 0
      const hours = Math.round(ttlSeconds / 3600)
      if (hours && hours !== 24) {
        $('sub').textContent = t('Queued for your Kobo, dropped once taken or after {n} hours.', {
          n: hours,
        })
      }
      render()
    } catch {
    }
  }

  async function cancel(id) {
    try {
      await sendJson('DELETE', `/api/waiting/${encodeURIComponent(id)}`)
    } catch {
    }
    await load()
  }

  $('cancelall').addEventListener('click', async () => {
    for (const book of [...books]) await cancel(book.id)
  })

  await load()

  page.every(1000, () => {
    if (!books.length || document.hidden) return
    books = books.map((b) => ({ ...b, expiresIn: Math.max(0, b.expiresIn - 1) }))
    render()
  })
  page.every(30000, () => {
    if (!document.hidden) void load()
  })
})
