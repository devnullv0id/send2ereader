import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { otpauthUri } from '../src/auth/totp.js'
import { type ErrorCorrection, encodeQr, encodeQrFitting, qrSvg } from '../src/qr.js'

const OTPAUTH = otpauthUri('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'me@example.com', 'Send to eReader')

const digest = (grid: (0 | 1)[][]) =>
  createHash('sha256')
    .update(grid.map((row) => row.join('')).join('\n'))
    .digest('hex')
    .slice(0, 16)

const versionOf = (grid: (0 | 1)[][]) => (grid.length - 17) / 4

function formatValue(ec: ErrorCorrection, mask: number): number {
  const bits = { L: 1, M: 0, Q: 3, H: 2 }[ec]
  const data = (bits << 3) | mask
  let value = data << 10
  for (let i = 14; i >= 10; i--) {
    if ((value >>> i) & 1) value ^= 0b10100110111 << (i - 10)
  }
  return ((data << 10) | value) ^ 0b101010000010010
}

function readFormat(
  grid: (0 | 1)[][],
  copy: 'first' | 'second'
): { ec: string; mask: number } | null {
  const n = grid.length
  const places: [number, number][] =
    copy === 'first'
      ? [
          [8, 0],
          [8, 1],
          [8, 2],
          [8, 3],
          [8, 4],
          [8, 5],
          [8, 7],
          [8, 8],
          [7, 8],
          [5, 8],
          [4, 8],
          [3, 8],
          [2, 8],
          [1, 8],
          [0, 8],
        ]
      : [
          [n - 1, 8],
          [n - 2, 8],
          [n - 3, 8],
          [n - 4, 8],
          [n - 5, 8],
          [n - 6, 8],
          [n - 7, 8],
          [8, n - 8],
          [8, n - 7],
          [8, n - 6],
          [8, n - 5],
          [8, n - 4],
          [8, n - 3],
          [8, n - 2],
          [8, n - 1],
        ]

  const read = places.map(([r, c]) => grid[r]![c]!).join('')
  for (const ec of ['L', 'M', 'Q', 'H'] as ErrorCorrection[]) {
    for (let mask = 0; mask < 8; mask++) {
      const value = formatValue(ec, mask)
      const want = places.map((_, i) => (value >>> (14 - i)) & 1).join('')
      if (want === read) return { ec, mask }
    }
  }
  return null
}

describe('the shape every reader looks for first', () => {
  const grid = encodeQr(OTPAUTH, 'M')
  const n = grid.length

  it('sizes the grid to the version it picked', () => {
    expect(n).toBe(versionOf(grid) * 4 + 17)
    expect(versionOf(grid)).toBe(8)
  })

  it.each([
    ['top left', 0, 0],
    ['top right', 0, -7],
    ['bottom left', -7, 0],
  ])('draws the %s finder as seven rings', (_where, top, left) => {
    const row0 = top < 0 ? n + top : top
    const col0 = left < 0 ? n + left : left
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
        expect(grid[row0 + r]![col0 + c], `${r},${c}`).toBe(ring === 2 ? 0 : 1)
      }
    }
  })

  it('keeps the separator around each finder light', () => {
    for (let i = 0; i < 8; i++) {
      expect(grid[7]![i], `top-left row`).toBe(0)
      expect(grid[i]![7], `top-left col`).toBe(0)
      expect(grid[7]![n - 1 - i], 'top-right row').toBe(0)
      expect(grid[n - 8]![i], 'bottom-left row').toBe(0)
    }
  })

  it('alternates the timing patterns between the finders', () => {
    for (let i = 8; i < n - 8; i++) {
      const want = i % 2 === 0 ? 1 : 0
      expect(grid[6]![i], `row 6 col ${i}`).toBe(want)
      expect(grid[i]![6], `col 6 row ${i}`).toBe(want)
    }
  })

  it('sets the one module that is always dark', () => {
    expect(grid[n - 8]![8]).toBe(1)
  })
})

describe('the format information, checked against its own BCH code', () => {
  it.each<[ErrorCorrection]>([['L'], ['M'], ['Q'], ['H']])(
    'writes a valid, matching pair of copies at level %s',
    (ec) => {
      const { grid } = encodeQrFitting('a short payload', ec)
      const first = readFormat(grid, 'first')
      const second = readFormat(grid, 'second')

      expect(first, 'first copy is not a valid format code').not.toBeNull()
      expect(second, 'second copy is not a valid format code').not.toBeNull()
      expect(first).toEqual(second)
      expect(first?.ec).toBe(ec)
      expect(first?.mask).toBeGreaterThanOrEqual(0)
      expect(first?.mask).toBeLessThan(8)
    }
  )
})

describe('choosing a version for what it has to carry', () => {
  it('grows only when the payload no longer fits', () => {
    expect(versionOf(encodeQr('a'.repeat(14), 'M'))).toBe(1)
    expect(versionOf(encodeQr('a'.repeat(15), 'M'))).toBe(2)
    expect(versionOf(encodeQr('a'.repeat(17), 'L'))).toBe(1)
    expect(versionOf(encodeQr('a'.repeat(18), 'L'))).toBe(2)
  })

  it('takes a smaller code when less correction is asked for', () => {
    const text = 'a'.repeat(60)
    expect(versionOf(encodeQr(text, 'L'))).toBeLessThan(versionOf(encodeQr(text, 'H')))
  })

  it('counts the bytes of a string, not its characters', () => {
    expect(versionOf(encodeQr('ü'.repeat(100), 'L'))).toBe(
      versionOf(encodeQr('a'.repeat(200), 'L'))
    )
  })

  it('says so rather than truncating when the payload is too big', () => {
    expect(() => encodeQr('a'.repeat(272), 'L')).toThrow(/does not fit/)
  })

  it('fits an ordinary sign-in URI at the correction level it asks for', () => {
    const uri = otpauthUri('J'.repeat(32), 'matthias.pammer@gmail.com', 'Send to eReader')
    expect(encodeQrFitting(uri, 'M').ec).toBe('M')
  })
})

describe('giving up correction rather than giving up the code', () => {
  it('keeps the asked-for level whenever it fits', () => {
    expect(encodeQrFitting('short', 'H').ec).toBe('H')
    expect(encodeQrFitting('short', 'M').ec).toBe('M')
  })

  it('steps down a level for an address too long to fit at M', () => {
    const uri = otpauthUri(
      'J'.repeat(32),
      `${'a'.repeat(40)}@${'b'.repeat(30)}.example.com`,
      'Send to eReader'
    )
    expect(() => encodeQr(uri, 'M')).toThrow()
    expect(encodeQrFitting(uri, 'M').ec).toBe('L')
  })

  it('never steps up, because more correction means less room', () => {
    const uri = otpauthUri('J'.repeat(32), 'me@example.com', 'Send to eReader')
    expect(encodeQrFitting(uri, 'L').ec).toBe('L')
  })

  it('still refuses what will not fit at any level', () => {
    expect(() => encodeQrFitting('a'.repeat(272), 'H')).toThrow(/does not fit/)
  })
})

describe('the matrices themselves, pinned so a change has to be deliberate', () => {
  it.each([
    {
      name: 'hello there friend',
      text: 'hello there friend',
      ec: 'M' as const,
      version: 2,
      want: '1bb7702fef1f2137',
    },
    { name: 'a', text: 'a', ec: 'L' as const, version: 1, want: '56bb324cb2e86a13' },
    {
      name: 'an otpauth URI',
      text: OTPAUTH,
      ec: 'M' as const,
      version: 8,
      want: '8a853eb2173f308f',
    },
    {
      name: 'non-ASCII text',
      text: 'Grüße aus München',
      ec: 'Q' as const,
      version: 2,
      want: '52942194588dd6c4',
    },
  ])('draws $name the same way every time', ({ text, ec, version, want }) => {
    const grid = encodeQr(text, ec)
    expect(versionOf(grid)).toBe(version)
    expect(digest(grid)).toBe(want)
  })
})

describe('the SVG the settings page embeds', () => {
  const svg = qrSvg(OTPAUTH, 'M')

  it('is one self-contained element with no external anything', () => {
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg.replace(/xmlns="[^"]*"/, '')).not.toMatch(/https?:|<script|<image|url\(/)
  })

  it('scales with the viewBox rather than fixed pixels', () => {
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/)
    expect(/<svg[^>]*>/.exec(svg)?.[0]).not.toMatch(/\swidth=|\sheight=/)
  })

  it('leaves the quiet zone a reader needs on all four sides', () => {
    const size = Number(/viewBox="0 0 (\d+)/.exec(svg)?.[1])
    expect(size).toBe(encodeQr(OTPAUTH, 'M').length + 4)
  })

  it('paints its own white ground, so a dark page cannot invert it', () => {
    expect(svg).toContain('fill="#fff"')
    expect(svg).toContain('fill="#000"')
  })

  it('names itself for a screen reader', () => {
    expect(svg).toMatch(/role="img"/)
    expect(svg).toMatch(/aria-label="[^"]+"/)
  })
})
