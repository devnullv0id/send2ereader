#!/usr/bin/env node

const bases = process.argv.slice(2)
if (bases.length === 0) {
  console.error('usage: compare-instances.mjs <base> [other base]')
  process.exit(2)
}

const ROUTES = [
  ['/', 'Send'],
  ['/send', 'Send'],
  ['/convert', 'Convert'],
  ['/history', 'History'],
  ['/waiting', 'Waiting'],
  ['/receive', 'the device page'],
  ['/login', 'Sign in'],
  ['/register', 'Create account'],
  ['/setup', 'First admin'],
  ['/setup/start', 'Setup assistant'],
  ['/settings', 'Settings'],
  ['/admin', 'Admin'],
  ['/auth/forgot', 'Forgot'],
  ['/auth/reset', 'Reset'],
  ['/auth/linked', 'Linked'],
  ['/healthz', 'health'],
  ['/auth/status', 'status'],
  ['/api/convert/targets?from=epub', 'targets'],
  ['/nope', 'not found'],
]

const titleOf = (body) => (/<title>([^<]*)<\/title>/i.exec(body) ?? [, ''])[1].trim()

const stamps = (body) =>
  [...body.matchAll(/(?:href|src)="(\/[\w./-]+\.(?:css|js))\?v=([0-9a-f]+)"/g)].map(
    (m) => `${m[1]}?v=${m[2]}`
  )

async function walk(base, cookie) {
  const rows = []
  for (const [path, what] of ROUTES) {
    const headers = cookie ? { cookie } : {}
    let res
    try {
      res = await fetch(base + path, { headers, redirect: 'manual' })
    } catch (err) {
      rows.push({ path, what, status: 'unreachable', note: err.message })
      continue
    }

    const type = (res.headers.get('content-type') ?? '').split(';')[0]
    const body = res.status < 300 ? await res.text() : ''
    rows.push({
      path,
      what,
      status: res.status,
      to: res.headers.get('location') ?? '',
      type,
      title: type.includes('html') ? titleOf(body) : '',
      bytes: body.length,
      assets: type.includes('html') ? stamps(body).length : 0,
      csp: (res.headers.get('content-security-policy') ?? '').length > 0,
      cache: res.headers.get('cache-control') ?? '',
    })
  }
  return rows
}

async function signedInCookie(base) {
  const account = {
    email: 'walker@example.com',
    password: 'a-perfectly-fine-password',
    firstName: 'Wal',
    lastName: 'Ker',
  }
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(account),
  })
  if (!res.ok) return null

  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ')

  const status = await (await fetch(`${base}/auth/status`, { headers: { cookie } })).json()
  const headers = { cookie, 'content-type': 'application/json', 'x-csrf-token': status.csrf }
  await fetch(`${base}/api/setup/complete`, { method: 'POST', headers, body: '{}' })
  return cookie
}

const results = []
for (const base of bases) {
  const cookie = await signedInCookie(base)
  results.push({ base, cookie: Boolean(cookie), rows: await walk(base, cookie) })
}

const pad = (s, n) => String(s).padEnd(n)

for (const { base, cookie, rows } of results) {
  console.log(`\n${base}   ${cookie ? 'signed in as an admin' : 'anonymous (registration refused)'}`)
  console.log(`  ${pad('route', 32)}${pad('code', 6)}${pad('type', 11)}${pad('assets', 7)}title / redirect`)
  for (const r of rows) {
    const tail = r.to || r.title || (r.type ? `${r.bytes} bytes` : r.note ?? '')
    console.log(
      `  ${pad(r.path, 32)}${pad(r.status, 6)}${pad((r.type || '').replace('application/', ''), 11)}${pad(r.assets || '', 7)}${tail}`
    )
  }
}

if (results.length === 2) {
  const [a, b] = results
  const differences = []
  for (let i = 0; i < a.rows.length; i++) {
    const x = a.rows[i]
    const y = b.rows[i]
    const same =
      x.status === y.status && x.to === y.to && x.type === y.type && x.title === y.title
    if (!same) differences.push({ path: x.path, a: x, b: y })
  }

  console.log('\ndifferences')
  if (differences.length === 0) {
    console.log('  none — both instances serve the same routes the same way')
  } else {
    for (const d of differences) {
      console.log(`  ${d.path}`)
      console.log(`      ${a.base}  ${d.a.status} ${d.a.to || d.a.title}`)
      console.log(`      ${b.base}  ${d.b.status} ${d.b.to || d.b.title}`)
    }
  }
  process.exit(differences.length === 0 ? 0 : 1)
}
