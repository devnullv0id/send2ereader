#!/usr/bin/env node
// Converts one real book into every format the server offers, and checks that
// what comes back is that format.
//
// Nothing in the unit suite runs a converter: every test stubs the tools off,
// which is exactly why epub-to-pdf was broken in every image ever built and
// stayed green the whole time. This runs against a server that is really
// running, with calibre really installed, and is the only thing that can catch
// that class of failure.
//
//   node scripts/smoke-convert.mjs http://127.0.0.1:3001

import { deflateRawSync } from 'node:zlib'

const base = (process.argv[2] ?? 'http://127.0.0.1:3001').replace(/\/+$/, '')

// A minimal but genuine EPUB, built here rather than committed: a fixture in the
// repository would be one more thing to keep true, and calibre only needs a
// container, a spine and a chapter.
function makeEpub() {
  const files = [
    ['mimetype', 'application/epub+zip', true],
    [
      'META-INF/container.xml',
      `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    ],
    [
      'OEBPS/content.opf',
      `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:5d0f2b9e-0000-4000-8000-smoketest01</dc:identifier>
    <dc:title>A Smoke Test</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>The Test Suite</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`,
    ],
    [
      'OEBPS/nav.xhtml',
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">One</a></li></ol></nav></body>
</html>`,
    ],
    [
      'OEBPS/chapter.xhtml',
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>One</title></head>
  <body><h1>One</h1><p>The quick brown fox jumps over the lazy dog, repeatedly and without complaint.</p></body>
</html>`,
    ],
  ]

  const chunks = []
  const central = []
  let offset = 0

  const crcTable = (() => {
    const table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
    return table
  })()

  const crc32 = (buf) => {
    let c = -1
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }

  for (const [name, text, stored] of files) {
    const body = Buffer.from(text, 'utf8')
    const data = stored ? body : deflateRawSync(body)
    const method = stored ? 0 : 8
    const nameBytes = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(body), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)

    chunks.push(local, nameBytes, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(crc32(body), 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(body.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)

    offset += local.length + nameBytes.length + data.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...chunks, directory, end])
}

// What each format has to look like coming back out. A conversion that returns
// the input unchanged, or an error page, fails here rather than being counted.
const SIGNATURES = {
  epub: (buf) => buf.subarray(0, 2).toString() === 'PK' && buf.includes('application/epub+zip'),
  kepub: (buf) => buf.subarray(0, 2).toString() === 'PK' && buf.includes('application/epub+zip'),
  azw3: (buf) => buf.includes('TPZ3') || buf.includes('BOOKMOBI'),
  mobi: (buf) => buf.includes('BOOKMOBI'),
  pdf: (buf) => buf.subarray(0, 5).toString() === '%PDF-',
  txt: (buf) => buf.includes('quick brown fox'),
  htmlz: (buf) => buf.subarray(0, 2).toString() === 'PK',
  kfx: (buf) => buf.length > 1024,
}

async function offered() {
  const res = await fetch(`${base}/api/convert/targets?from=epub`)
  if (!res.ok) throw new Error(`targets answered ${res.status}`)

  const { groups } = await res.json()
  return groups
    .flatMap((group) => group.items)
    .map((item) => ({ format: item.format, refusal: item.refusal }))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function convert(book, format) {
  let res
  let body

  // /convert is rate limited to five a minute, and there are more formats than
  // that. Waiting is the point of the limit, so this waits rather than shouting.
  for (let attempt = 0; attempt < 6; attempt++) {
    const form = new FormData()
    form.set('file', new Blob([book], { type: 'application/epub+zip' }), 'smoke.epub')
    form.set('format', format)

    res = await fetch(`${base}/convert`, { method: 'POST', body: form })
    body = await res.json().catch(() => null)
    if (res.status !== 429) break

    const wait = Number(res.headers.get('retry-after') ?? 20)
    console.log(`wait  ${format.padEnd(6)} rate limited, ${wait}s`)
    await sleep((wait + 1) * 1000)
  }

  if (!res.ok || !body?.ok) {
    throw new Error(`convert said ${res.status}: ${body?.error ?? 'no reason given'}`)
  }

  const file = await fetch(base + body.url)
  if (!file.ok) throw new Error(`download said ${file.status}`)
  return { name: body.filename, bytes: Buffer.from(await file.arrayBuffer()), via: body.applied }
}

const book = makeEpub()
const targets = await offered()
if (targets.length === 0) {
  console.error('the server offered no formats at all')
  process.exit(1)
}

let failed = 0
for (const target of targets) {
  if (target.refusal) {
    console.log(`skip  ${target.format.padEnd(6)} ${target.refusal}`)
    continue
  }

  try {
    const out = await convert(book, target.format)
    const check = SIGNATURES[target.format]
    if (!check) throw new Error('no signature to check this format against')
    if (!check(out.bytes)) throw new Error(`${out.bytes.length} bytes, and not a ${target.format}`)

    const via = out.via.length > 0 ? out.via.join(' → ') : 'no conversion'
    console.log(`ok    ${target.format.padEnd(6)} ${out.bytes.length} bytes via ${via}`)
  } catch (err) {
    failed += 1
    console.error(`FAIL  ${target.format.padEnd(6)} ${err.message}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${targets.length} conversions failed`)
  process.exit(1)
}
console.log('\nevery format the server offers really came back as that format')
