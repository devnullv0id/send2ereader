'use strict'

const History = (() => {
  const KEY = 's2e_history_v1'
  const LIMIT = 50

  function all() {
    try {
      const raw = window.localStorage.getItem(KEY)
      const entries = raw ? JSON.parse(raw) : []
      return Array.isArray(entries) ? entries : []
    } catch {
      return []
    }
  }

  function save(entries) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(entries.slice(0, LIMIT)))
    } catch {
    }
  }

  function add(entry) {
    save([{ ...entry, at: new Date().toISOString() }, ...all()])
  }

  function recent(count) {
    const seen = new Set()
    const out = []
    for (const entry of all()) {
      if (!entry.ok || seen.has(entry.filename)) continue
      seen.add(entry.filename)
      out.push(entry)
      if (out.length >= count) break
    }
    return out
  }

  function clear() {
    try {
      window.localStorage.removeItem(KEY)
    } catch {
    }
  }

  return { all, add, recent, clear }
})()
