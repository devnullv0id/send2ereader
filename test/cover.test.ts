import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { calibreArgs } from '../src/convert/index.js'
import { readEpubCover } from '../src/epub/cover.js'
import { ZipFile } from '../src/epub/zip.js'
import { COVER_PNG, type CoverStyle, epubWithCover, makeZip, sampleEpub } from './helpers.js'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 's2e-cover-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

let counter = 0
async function onDisk(data: Buffer, extension = '.epub'): Promise<string> {
  const path = join(dir, `book-${counter++}${extension}`)
  await writeFile(path, data)
  return path
}

describe('calibre arguments', () => {
  const on = { calibreOutputProfile: 'kindle_pw3', kindleShareNotSync: true }
  const off = { calibreOutputProfile: 'kindle_pw3', kindleShareNotSync: false }

  it.each(['azw3', 'mobi'] as const)('marks %s so the Kindle uses the embedded cover', (format) => {
    const args = calibreArgs('in.epub', `out.${format}`, { converter: 'calibre', format }, on)
    expect(args).toContain('--share-not-sync')
  })

  it.each(['epub', 'kepub'] as const)('leaves %s alone', (format) => {
    const args = calibreArgs('in.kfx', `out.${format}`, { converter: 'calibre', format }, on)
    expect(args).not.toContain('--share-not-sync')
    expect(args).not.toContain('--output-profile')
  })

  it('can be switched off for someone who wants calibre stock behaviour', () => {
    const step = { converter: 'calibre', format: 'azw3' } as const
    expect(calibreArgs('in.epub', 'out.azw3', step, off)).not.toContain('--share-not-sync')
  })

  it('still puts the input and output first, in that order', () => {
    const step = { converter: 'calibre', format: 'azw3' } as const
    expect(calibreArgs('in.epub', 'out.azw3', step, on).slice(0, 2)).toEqual([
      'in.epub',
      'out.azw3',
    ])
  })

  it('keeps the old MOBI format for pre-KF8 hardware', () => {
    const step = { converter: 'calibre', format: 'mobi' } as const
    const args = calibreArgs('in.epub', 'out.mobi', step, on)
    expect(args.join(' ')).toContain('--mobi-file-type old')
  })
})

describe('reading a zip', () => {
  it('reads a deflated entry, which is what real writers produce', async () => {
    const path = await onDisk(makeZip([{ name: 'a.txt', data: 'hello', deflate: true }]))
    const zip = await ZipFile.open(path)
    expect((await zip.read('a.txt', 1024))?.toString()).toBe('hello')
    await zip.close()
  })

  it('reads a stored entry', async () => {
    const path = await onDisk(makeZip([{ name: 'a.txt', data: 'hello' }]))
    const zip = await ZipFile.open(path)
    expect((await zip.read('a.txt', 1024))?.toString()).toBe('hello')
    await zip.close()
  })

  it('refuses an entry larger than the caller allows', async () => {
    const path = await onDisk(makeZip([{ name: 'big', data: 'x'.repeat(5000), deflate: true }]))
    const zip = await ZipFile.open(path)
    expect(await zip.read('big', 100)).toBeNull()
    await zip.close()
  })

  it('returns null for a name that is not there', async () => {
    const path = await onDisk(makeZip([{ name: 'a.txt', data: 'hello' }]))
    const zip = await ZipFile.open(path)
    expect(await zip.read('missing.txt', 1024)).toBeNull()
    await zip.close()
  })

  it('rejects something that is not a zip at all', async () => {
    const path = await onDisk(Buffer.from('just some bytes'), '.bin')
    await expect(ZipFile.open(path)).rejects.toThrow(/zip/i)
  })
})

describe('finding the cover in a book', () => {
  it.each<CoverStyle>(['meta', 'properties', 'guide-page', 'name-only'])(
    'declared by %s',
    async (style) => {
      const cover = await readEpubCover(await onDisk(epubWithCover(style)))
      expect(cover, style).not.toBeNull()
      expect(cover?.data.equals(COVER_PNG)).toBe(true)
      expect(cover?.contentType).toBe('image/png')
    }
  )

  it('returns null for a book that simply has no cover', async () => {
    expect(await readEpubCover(await onDisk(epubWithCover('none')))).toBeNull()
  })

  it('returns null rather than throwing on a file with no OPF', async () => {
    expect(await readEpubCover(await onDisk(sampleEpub()))).toBeNull()
  })

  it('returns null rather than throwing on something that is not an EPUB', async () => {
    expect(await readEpubCover(await onDisk(Buffer.from('not a book'), '.bin'))).toBeNull()
  })

  it('returns null rather than throwing on a file that is not there', async () => {
    expect(await readEpubCover(join(dir, 'no-such-book.epub'))).toBeNull()
  })

  it('ignores a cover the manifest points at but the archive does not contain', async () => {
    const broken = makeZip([
      { name: 'mimetype', data: 'application/epub+zip' },
      {
        name: 'META-INF/container.xml',
        data: '<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>',
      },
      {
        name: 'c.opf',
        data: `<package><metadata><meta name="cover" content="c"/></metadata>
          <manifest><item id="c" href="gone.png" media-type="image/png"/></manifest></package>`,
      },
    ])
    expect(await readEpubCover(await onDisk(broken))).toBeNull()
  })
})

describe('an archive that lies about its own sizes', () => {
  function withClaimedSizes(compressed: number, uncompressed: number): Buffer {
    const zip = makeZip([{ name: 'META-INF/container.xml', data: '<container/>' }])

    const eocd = zip.length - 22
    const directoryOffset = zip.readUInt32LE(eocd + 16)
    zip.writeUInt32LE(compressed, directoryOffset + 20)
    zip.writeUInt32LE(uncompressed, directoryOffset + 24)
    return zip
  }

  it('does not reserve four gigabytes because a header asked it to', async () => {
    const path = join(dir, 'liar.epub')
    await writeFile(path, withClaimedSizes(0xffffffff, 12))

    const before = process.memoryUsage().arrayBuffers
    const zip = await ZipFile.open(path)
    try {
      const out = await zip.read('META-INF/container.xml', 4 * 1024 * 1024)
      const grew = process.memoryUsage().arrayBuffers - before

      expect(grew, 'nothing near the 4GB the header claimed').toBeLessThan(64 * 1024 * 1024)
      expect(out, 'and the short read is refused rather than trusted').toBeNull()
    } finally {
      await zip.close()
    }
  })

  it('still reads an honest archive', async () => {
    const path = join(dir, 'honest.epub')
    await writeFile(path, makeZip([{ name: 'META-INF/container.xml', data: '<container/>' }]))

    const zip = await ZipFile.open(path)
    try {
      const out = await zip.read('META-INF/container.xml', 4 * 1024 * 1024)
      expect(out?.toString()).toBe('<container/>')
    } finally {
      await zip.close()
    }
  })

  it('survives a central directory claiming to be enormous', async () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello' }])
    const eocd = zip.length - 22
    zip.writeUInt32LE(0xffffffff, eocd + 12)

    const path = join(dir, 'huge-directory.epub')
    await writeFile(path, zip)

    await expect(ZipFile.open(path).then((z) => z.close())).resolves.not.toThrow()
  })
})
