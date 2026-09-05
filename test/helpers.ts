import { crc32, deflateRawSync } from 'node:zlib'
import { MARKER } from '../src/files.js'

export interface ZipEntry {
  name: string
  data: string | Buffer
  deflate?: boolean
}

export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const { name, data, deflate } of entries) {
    const nameBuf = Buffer.from(name)
    const raw = Buffer.from(data as string)
    const stored = deflate ? deflateRawSync(raw) : raw
    const method = deflate ? 8 : 0
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, stored)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(stored.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + stored.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuf, end])
}

export function sampleEpub(): Buffer {
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: '<?xml version="1.0"?><container version="1.0"/>',
    },
  ])
}

export const COVER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

export type CoverStyle = 'meta' | 'properties' | 'guide-page' | 'name-only' | 'none'

export function epubWithOpfMetadata(metadata: string): Buffer {
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0"?><container version="1.0"><rootfiles><rootfile
        full-path="OEBPS/content.opf"/></rootfiles></container>`,
      deflate: true,
    },
    {
      name: 'OEBPS/content.opf',
      data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${metadata}</metadata>
  <manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`,
      deflate: true,
    },
    { name: 'OEBPS/ch1.xhtml', data: '<html><body><p>Text.</p></body></html>', deflate: true },
  ])
}

export function epubWithCover(style: CoverStyle): Buffer {
  const metaTag = style === 'meta' ? '<meta name="cover" content="cover-img"/>' : ''
  const properties = style === 'properties' ? ' properties="cover-image"' : ''
  const guide =
    style === 'guide-page'
      ? '<guide><reference type="cover" title="Cover" href="cover.xhtml"/></guide>'
      : ''
  const imageId = { meta: 'cover-img', 'name-only': 'the-cover-image' }[style as string] ?? 'img1'
  const imageHref = style === 'name-only' ? 'img/cover.png' : 'images/front.png'

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>A Book</dc:title><dc:language>de</dc:language>
    <dc:creator>Ursula Wright</dc:creator>
    <dc:identifier id="id">urn:uuid:1234</dc:identifier>
    ${metaTag}
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>
    ${style === 'none' ? '' : `<item id="${imageId}" href="${imageHref}" media-type="image/png"${properties}/>`}
  </manifest>
  <spine><itemref idref="cover-page"/><itemref idref="ch1"/></spine>
  ${guide}
</package>`

  const entries: ZipEntry[] = [
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0"?><container version="1.0"
        xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile
        full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
        </rootfiles></container>`,
      deflate: true,
    },
    { name: 'OEBPS/content.opf', data: opf, deflate: true },
    {
      name: 'OEBPS/cover.xhtml',
      data: `<html xmlns="http://www.w3.org/1999/xhtml"><body><div><img
        src="./${imageHref}" alt="Cover"/></div></body></html>`,
      deflate: true,
    },
    { name: 'OEBPS/ch1.xhtml', data: '<html><body><p>Text.</p></body></html>', deflate: true },
  ]
  if (style !== 'none') {
    entries.push({ name: `OEBPS/${imageHref}`, data: COVER_PNG, deflate: true })
  }
  return makeZip(entries)
}

export const BOUNDARY = '----send2ereadertestboundary'

interface Part {
  name: string
  value: string | Buffer
  filename?: string
  contentType?: string
}

export function multipart(parts: Part[]): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`
    const headers =
      `--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n` +
      (part.filename ? `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n` : '') +
      '\r\n'
    chunks.push(Buffer.from(headers), Buffer.from(part.value), Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(chunks)
}

export const multipartHeaders = {
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS']

interface Injectable {
  inject(opts: unknown): Promise<{ json(): { csrf?: string | null } }>
  rawInject?(opts: unknown): Promise<unknown>
}

// A signed-in page always holds the token the server handed it, so a test standing
// in for that page should too. Anything that sets x-csrf-token itself is left alone,
// which is how the tests for the check itself send a wrong one or none at all.
// app.rawInject is the untouched original, for asserting what happens without it.
export function asBrowser<T>(app: T): T {
  const target = app as Injectable
  const raw = target.inject.bind(target)
  target.rawInject = raw

  target.inject = async (opts: unknown) => {
    const options = opts as { method?: string; headers?: Record<string, unknown> } | undefined
    const method = String(options?.method ?? 'GET').toUpperCase()
    const headers = options?.headers ?? {}
    const cookie = headers.cookie

    if (SAFE_METHODS.includes(method) || !cookie || 'x-csrf-token' in headers) return raw(opts)

    const status = await raw({ url: '/auth/status', headers: { cookie } })
    const csrf = status.json().csrf
    if (!csrf) return raw(opts)

    return raw({ ...(options as object), headers: { ...headers, 'x-csrf-token': csrf } })
  }

  return app
}

// The managed directories carry a marker file that says they are ours to empty,
// so "what is in here" means everything except that.
export async function contentsOf(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(dir)
  return entries.filter((entry) => entry !== MARKER)
}
