import { createReadStream, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { prepareUploadDir } from '../src/files.js'
import { contentsOf, multipart, multipartHeaders, sampleEpub } from './helpers.js'

let app: FastifyInstance

const noTools = {
  kepubify: false,
  calibre: false,
  pdfcropmargins: false,
  kfxInput: false,
  kfxOutput: false,
  layoutFix: false,
}

beforeEach(async () => {
  await prepareUploadDir(true)
  app = await buildApp({ tools: noTools, logger: false, accounts: false })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

function body(format: string, filename = 'book.epub') {
  return multipart([
    { name: 'format', value: format },
    { name: 'layoutFix', value: 'off' },
    { name: 'file', value: sampleEpub(), filename, contentType: 'application/epub+zip' },
  ])
}

const post = (payload: Buffer) =>
  app.inject({ method: 'POST', url: '/convert', headers: multipartHeaders, payload })

describe('the targets the page is offered', () => {
  it('answers for a named source', async () => {
    const res = await app.inject({ url: '/api/convert/targets?from=epub' })
    expect(res.statusCode).toBe(200)

    const { groups } = res.json()
    expect(groups.map((g: { name: string }) => g.name)).toEqual(['Kobo', 'Kindle', 'Anything else'])
  })

  it('refuses in a sentence rather than by omission', async () => {
    const res = await app.inject({ url: '/api/convert/targets?from=epub' })
    const kfx = res
      .json()
      .groups.flatMap((g: { items: unknown[] }) => g.items)
      .find((i: { format: string }) => i.format === 'kfx')

    expect(kfx.refusal).toMatch(/Kindle Previewer/)
  })

  it('still answers with no source, so the grid is never empty', async () => {
    const res = await app.inject({ url: '/api/convert/targets' })
    expect(res.statusCode).toBe(200)
    expect(res.json().groups.flatMap((g: { items: unknown[] }) => g.items)).toHaveLength(8)
  })
})

describe('converting a file', () => {
  it('hands back a link whose last segment is the filename', async () => {
    const res = await post(body('epub', 'My Book.epub'))
    expect(res.statusCode).toBe(200)

    const data = res.json()
    expect(data.ok).toBe(true)
    expect(data.filename).toBe('My Book.epub')
    expect(data.url).toBe(`/convert/${data.id}/${encodeURIComponent('My Book.epub')}`)
  })

  it('refuses a target the tools cannot reach, before running anything', async () => {
    const res = await post(body('azw3'))
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toMatch(/calibre/)
  })

  it('will not be talked into a format that is not a target at all', async () => {
    const res = await post(body('cbz'))
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/format/i)
  })

  it('rejects a body with no file', async () => {
    const res = await post(multipart([{ name: 'format', value: 'epub' }]))
    expect(res.statusCode).toBe(400)
  })

  it('leaves nothing on disk when it refuses', async () => {
    await post(body('azw3'))
    expect(await contentsOf(config.uploadDir)).toEqual([])
  })
})

describe('collecting the result', () => {
  async function convert() {
    const data = (await post(body('epub', 'My Book.epub'))).json()
    return data as { id: string; url: string; filename: string }
  }

  it('serves the bytes as an attachment', async () => {
    const { url } = await convert()
    const res = await app.inject({ url })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('epub')
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.rawPayload.length).toBeGreaterThan(0)
  })

  it('deletes the file as it serves it, which is what the page promises', async () => {
    const { url } = await convert()
    await app.inject({ url })

    await vi.waitFor(async () => {
      expect(await contentsOf(config.uploadDir), 'nothing left behind').toEqual([])
    })
    expect((await app.inject({ url })).statusCode, 'and it is gone').toBe(404)
  })

  it('needs the filename as well as the id', async () => {
    const { id } = await convert()
    expect((await app.inject({ url: `/convert/${id}/other.epub` })).statusCode).toBe(404)
  })

  it('is a 404 for an id that was never issued', async () => {
    const res = await app.inject({ url: '/convert/00000000-0000-0000-0000-000000000000/x.epub' })
    expect(res.statusCode).toBe(404)
  })

  it('purges anything uncollected when the server stops', async () => {
    await convert()
    expect((await contentsOf(config.uploadDir)).length).toBeGreaterThan(0)

    await app.close()
    expect(await contentsOf(config.uploadDir)).toEqual([])

    app = await buildApp({ tools: noTools, logger: false, accounts: false })
    await app.ready()
  })
})

describe('the page itself', () => {
  it('is served at /convert', async () => {
    const res = await app.inject({
      url: '/convert',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('Convert a book')
  })
})

describe('a download that breaks off part way', () => {
  it('leaves the file collectable instead of throwing it away', async () => {
    const stored = app.conversions.add({
      name: 'book.epub',
      path: join(config.uploadDir, 'still-here.epub'),
      format: 'epub',
      size: 5,
      owner: null,
    })
    await writeFile(stored.path, 'hello')

    // What a dropped connection does: the stream is destroyed before it ends.
    const stream = createReadStream(stored.path)
    stream.on('end', () => {
      void app.conversions.remove(stored.id)
    })
    stream.destroy()
    await new Promise<void>((resolve) => stream.on('close', () => resolve()))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(app.conversions.get(stored.id, null), 'the sender can ask again').not.toBeNull()
    expect(existsSync(stored.path), 'and the bytes are still there').toBe(true)
  })

  it('still clears up once the transfer actually finishes', async () => {
    const stored = app.conversions.add({
      name: 'book.epub',
      path: join(config.uploadDir, 'collected.epub'),
      format: 'epub',
      size: 5,
      owner: null,
    })
    await writeFile(stored.path, 'hello')

    const res = await app.inject({ url: `/convert/${stored.id}/book.epub` })
    expect(res.statusCode).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(app.conversions.get(stored.id, null), 'one shot, as promised').toBeNull()
  })
})

describe('a real client that hangs up mid-transfer', () => {
  it('keeps the file, because the transfer never finished', async () => {
    const big = join(config.uploadDir, 'big-result.epub')
    await writeFile(big, Buffer.alloc(24 * 1024 * 1024, 'x'))

    const stored = app.conversions.add({
      name: 'big.epub',
      path: big,
      format: 'epub',
      size: 24 * 1024 * 1024,
      owner: null,
    })

    await app.listen({ port: 0, host: '127.0.0.1' })
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`

    const controller = new AbortController()
    let cut = false
    try {
      const res = await fetch(`${base}/convert/${stored.id}/big.epub`, {
        signal: controller.signal,
      })
      const reader = res.body!.getReader()
      await reader.read() // one chunk, then walk away
      controller.abort()
      await reader.read()
    } catch {
      cut = true
    }

    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(cut, 'the client really did hang up').toBe(true)
    expect(app.conversions.get(stored.id, null), 'still collectable').not.toBeNull()
    expect(existsSync(big), 'and the bytes survived').toBe(true)
  })
})
