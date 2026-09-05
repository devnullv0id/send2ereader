import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fromOpf, readEpubMetadata } from '../src/epub/metadata.js'
import { epubWithCover, epubWithOpfMetadata, sampleEpub } from './helpers.js'

let dir: string
let counter = 0

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 's2e-meta-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function onDisk(data: Buffer, extension = '.epub'): Promise<string> {
  const path = join(dir, `book-${counter++}${extension}`)
  await writeFile(path, data)
  return path
}

describe('reading the package metadata', () => {
  it('reads the Dublin Core fields', () => {
    const meta = fromOpf(`<metadata>
      <dc:title>The Left Hand of Darkness</dc:title>
      <dc:creator>Ursula K. Le Guin</dc:creator>
      <dc:language>en-GB</dc:language>
      <dc:publisher>Ace Books</dc:publisher>
    </metadata>`)

    expect(meta.title).toBe('The Left Hand of Darkness')
    expect(meta.authors).toEqual(['Ursula K. Le Guin'])
    expect(meta.language).toBe('en-GB')
    expect(meta.publisher).toBe('Ace Books')
  })

  it('reads unprefixed elements too', () => {
    const meta = fromOpf(
      '<metadata><title>Bare Namespace</title><creator>A. Writer</creator></metadata>'
    )
    expect(meta.title).toBe('Bare Namespace')
    expect(meta.authors).toEqual(['A. Writer'])
  })

  it('keeps every creator, in order', () => {
    const meta = fromOpf(`<metadata>
      <dc:creator>First Author</dc:creator>
      <dc:creator opf:role="aut">Second Author</dc:creator>
    </metadata>`)
    expect(meta.authors).toEqual(['First Author', 'Second Author'])
  })

  it('decodes entities, which titles are full of', () => {
    const meta = fromOpf(`<metadata>
      <dc:title>Sense &amp; Sensibility</dc:title>
      <dc:creator>Charlotte Bront&#235; &#x26; Sister</dc:creator>
    </metadata>`)
    expect(meta.title).toBe('Sense & Sensibility')
    expect(meta.authors).toEqual(['Charlotte Brontë & Sister'])
  })

  it('collapses the whitespace of a pretty-printed package', () => {
    const meta = fromOpf('<metadata><dc:title>\n    A Long\n    Title\n  </dc:title></metadata>')
    expect(meta.title).toBe('A Long Title')
  })

  it('strips the markup out of a description', () => {
    const meta = fromOpf(
      '<metadata><dc:description>&lt;p&gt;A <b>bold</b> blurb.&lt;/p&gt;</dc:description></metadata>'
    )
    expect(meta.description).toBe('A bold blurb.')
  })

  it('caps a runaway description', () => {
    const long = 'x'.repeat(5000)
    expect(
      fromOpf(`<metadata><dc:description>${long}</dc:description></metadata>`)?.description
    ).toHaveLength(2000)
  })

  it('ignores titles outside the metadata block', () => {
    const meta = fromOpf(`<package>
      <metadata><dc:title>The Real Title</dc:title></metadata>
      <guide><reference type="cover" title="Cover" href="c.xhtml"/></guide>
    </package>`)
    expect(meta.title).toBe('The Real Title')
  })

  it('returns nulls for a package that declares nothing', () => {
    const meta = fromOpf('<metadata><dc:identifier>urn:uuid:1</dc:identifier></metadata>')
    expect(meta).toEqual({
      title: null,
      authors: [],
      language: null,
      description: null,
      publisher: null,
    })
  })

  it('treats an empty element as absent rather than as an empty title', () => {
    expect(fromOpf('<metadata><dc:title>   </dc:title></metadata>').title).toBeNull()
  })
})

describe('reading metadata off a file', () => {
  it('reads a real EPUB', async () => {
    const path = await onDisk(
      epubWithOpfMetadata('<dc:title>From The File</dc:title><dc:creator>N. Writer</dc:creator>')
    )
    const meta = await readEpubMetadata(path)
    expect(meta?.title).toBe('From The File')
    expect(meta?.authors).toEqual(['N. Writer'])
  })

  it('reads the same book the cover comes from', async () => {
    const meta = await readEpubMetadata(await onDisk(epubWithCover('meta')))
    expect(meta?.title).toBe('A Book')
    expect(meta?.authors).toEqual(['Ursula Wright'])
    expect(meta?.language).toBe('de')
  })

  it('returns null for a file with no package document', async () => {
    expect(await readEpubMetadata(await onDisk(sampleEpub()))).toBeNull()
  })

  it('returns null rather than throwing on something that is not an EPUB', async () => {
    expect(await readEpubMetadata(await onDisk(Buffer.from('not a book'), '.bin'))).toBeNull()
  })

  it('returns null rather than throwing on a file that is not there', async () => {
    expect(await readEpubMetadata(join(dir, 'no-such-book.epub'))).toBeNull()
  })
})
