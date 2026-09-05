import { describe, expect, it } from 'vitest'
import { stripStoreIdentity } from '../src/convert/kindle-asin.js'

function tag(id: number, value: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(id, 0)
  head.writeUInt32BE(8 + value.length, 4)
  return Buffer.concat([head, value])
}

function palmBook(tags: Buffer[]): Buffer {
  const exth = Buffer.concat([
    Buffer.from('EXTH'),
    (() => {
      const head = Buffer.alloc(8)
      head.writeUInt32BE(12 + tags.reduce((n, t) => n + t.length, 0), 0)
      head.writeUInt32BE(tags.length, 4)
      return head
    })(),
    ...tags,
  ])

  const record0 = Buffer.concat([Buffer.from('MOBI-ish header padding'), exth])
  const header = Buffer.alloc(78 + 8)
  header.writeUInt16BE(1, 76)
  header.writeUInt32BE(header.length, 78)
  return Buffer.concat([header, record0])
}

function tagsOf(book: Buffer): number[] {
  const at = book.indexOf('EXTH')
  const count = book.readUInt32BE(at + 8)
  const ids: number[] = []
  let cursor = at + 12
  for (let seen = 0; seen < count; seen += 1) {
    ids.push(book.readUInt32BE(cursor))
    cursor += book.readUInt32BE(cursor + 4)
  }
  return ids
}

const MADE_UP = '676569a2-53b2-4df7-81be-a00087ab12cd'

describe('the fake store identity calibre writes into KF8', () => {
  it('removes the ASIN calibre made up, which is always a UUID', () => {
    const book = palmBook([tag(113, Buffer.from(MADE_UP)), tag(201, Buffer.from([0, 0, 0, 11]))])

    expect(stripStoreIdentity(book)).toBe(true)
    expect(tagsOf(book)).not.toContain(113)
  })

  it('keeps a real ASIN that came with the book', () => {
    const book = palmBook([
      tag(113, Buffer.from('B002XHNKZ0')),
      tag(201, Buffer.from([0, 0, 0, 11])),
    ])

    stripStoreIdentity(book)
    expect(tagsOf(book)).toContain(113)
  })

  it('keeps a real source, and drops only calibre’s own library UUID', () => {
    const mine = palmBook([tag(112, Buffer.from('Project Gutenberg'))])
    stripStoreIdentity(mine)
    expect(tagsOf(mine)).toContain(112)

    const calibres = palmBook([tag(112, Buffer.from(`calibre:${MADE_UP}`))])
    stripStoreIdentity(calibres)
    expect(tagsOf(calibres)).not.toContain(112)
  })

  it('leaves the cover and thumbnail records alone', () => {
    const book = palmBook([
      tag(113, Buffer.from(MADE_UP)),
      tag(201, Buffer.from([0, 0, 0, 11])),
      tag(202, Buffer.from([0, 0, 0, 12])),
    ])

    stripStoreIdentity(book)
    expect(tagsOf(book)).toEqual(expect.arrayContaining([201, 202]))
  })

  it('keeps every record the same length, so the Palm offsets still point where they did', () => {
    const book = palmBook([tag(113, Buffer.from(MADE_UP)), tag(201, Buffer.from([0, 0, 0, 11]))])
    const before = book.length

    stripStoreIdentity(book)
    expect(book.length).toBe(before)
  })

  it('reports no change for a file that carries no invented identity', () => {
    const book = palmBook([tag(201, Buffer.from([0, 0, 0, 11]))])
    expect(stripStoreIdentity(book)).toBe(false)
  })

  it('leaves a file with no EXTH block untouched', () => {
    expect(stripStoreIdentity(Buffer.alloc(200))).toBe(false)
  })
})
