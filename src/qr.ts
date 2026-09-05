export type ErrorCorrection = 'L' | 'M' | 'Q' | 'H'

const MAX_VERSION = 10

const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346]

const EC_BLOCKS: Record<ErrorCorrection, number[][]> = {
  L: [
    [],
    [7, 1, 19],
    [10, 1, 34],
    [15, 1, 55],
    [20, 1, 80],
    [26, 1, 108],
    [18, 2, 68],
    [20, 2, 78],
    [24, 2, 97],
    [30, 2, 116],
    [18, 2, 68, 2, 69],
  ],
  M: [
    [],
    [10, 1, 16],
    [16, 1, 28],
    [26, 1, 44],
    [18, 2, 32],
    [24, 2, 43],
    [16, 4, 27],
    [18, 4, 31],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
  ],
  Q: [
    [],
    [13, 1, 13],
    [22, 1, 22],
    [18, 2, 17],
    [26, 2, 24],
    [18, 2, 15, 2, 16],
    [24, 4, 19],
    [18, 2, 14, 4, 15],
    [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17],
    [24, 6, 19, 2, 20],
  ],
  H: [
    [],
    [17, 1, 9],
    [28, 1, 16],
    [22, 2, 13],
    [16, 4, 9],
    [22, 2, 11, 2, 12],
    [28, 4, 15],
    [26, 4, 13, 1, 14],
    [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13],
    [28, 6, 15, 2, 16],
  ],
}

const ALIGNMENT: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

const EC_BITS: Record<ErrorCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 }

const PAD_BYTES = [0xec, 0x11]

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a]! + LOG[b]!]!
}

function generatorPoly(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ poly[j]!
      next[j + 1] = (next[j + 1] ?? 0) ^ mul(poly[j]!, EXP[i]!)
    }
    poly = next
  }
  return poly
}

function remainder(data: number[], degree: number): number[] {
  const gen = generatorPoly(degree)
  const out = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ out[0]!
    out.shift()
    out.push(0)
    for (let i = 0; i < degree; i++) {
      out[i] = out[i]! ^ mul(gen[i + 1]!, factor)
    }
  }
  return out
}

function blockPlan(version: number, ec: ErrorCorrection): { ecLength: number; sizes: number[] } {
  const spec = EC_BLOCKS[ec][version]!
  const ecLength = spec[0]!
  const sizes: number[] = []
  for (let i = 1; i < spec.length; i += 2) {
    for (let n = 0; n < spec[i]!; n++) sizes.push(spec[i + 1]!)
  }
  return { ecLength, sizes }
}

function dataCapacity(version: number, ec: ErrorCorrection): number {
  const { ecLength, sizes } = blockPlan(version, ec)
  return TOTAL_CODEWORDS[version]! - ecLength * sizes.length
}

function pickVersion(byteLength: number, ec: ErrorCorrection): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const countBits = version < 10 ? 8 : 16
    const needed = Math.ceil((4 + countBits + byteLength * 8) / 8)
    if (needed <= dataCapacity(version, ec)) return version
  }
  throw new Error(`${byteLength} bytes does not fit in a version ${MAX_VERSION} QR code`)
}

function encodeData(bytes: Buffer, version: number, ec: ErrorCorrection): number[] {
  const capacity = dataCapacity(version, ec)
  const bits: number[] = []
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }

  push(0b0100, 4)
  push(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)

  const limit = capacity * 8
  push(0, Math.min(4, limit - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)

  const words: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let word = 0
    for (let j = 0; j < 8; j++) word = (word << 1) | bits[i + j]!
    words.push(word)
  }
  for (let pad = 0; words.length < capacity; pad++) words.push(PAD_BYTES[pad % 2]!)
  return words
}

function interleave(words: number[], version: number, ec: ErrorCorrection): number[] {
  const { ecLength, sizes } = blockPlan(version, ec)

  const dataBlocks: number[][] = []
  const ecBlocks: number[][] = []
  let at = 0
  for (const size of sizes) {
    const block = words.slice(at, at + size)
    at += size
    dataBlocks.push(block)
    ecBlocks.push(remainder(block, ecLength))
  }

  const out: number[] = []
  const longest = Math.max(...sizes)
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!)
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of ecBlocks) out.push(block[i]!)
  }
  return out
}

type Bit = 0 | 1

interface Canvas {
  size: number
  version: number
  modules: Bit[][]
  fixed: boolean[][]
}

function newCanvas(version: number): Canvas {
  const size = version * 4 + 17
  return {
    size,
    version,
    modules: Array.from({ length: size }, () => new Array<Bit>(size).fill(0)),
    fixed: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  }
}

function set(canvas: Canvas, row: number, col: number, bit: Bit): void {
  canvas.modules[row]![col] = bit
  canvas.fixed[row]![col] = true
}

function reserve(canvas: Canvas, row: number, col: number): void {
  canvas.fixed[row]![col] = true
}

function placeFinder(canvas: Canvas, top: number, left: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const row = top + r
      const col = left + c
      if (row < 0 || row >= canvas.size || col < 0 || col >= canvas.size) continue
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
      set(canvas, row, col, inside && ring !== 2 ? 1 : 0)
    }
  }
}

function placeAlignment(canvas: Canvas): void {
  const centres = ALIGNMENT[canvas.version]!
  const last = canvas.size - 8
  for (const row of centres) {
    for (const col of centres) {
      const nearFinder =
        (row <= 8 && col <= 8) || (row <= 8 && col >= last) || (row >= last && col <= 8)
      if (nearFinder) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const ring = Math.max(Math.abs(r), Math.abs(c))
          set(canvas, row + r, col + c, ring === 1 ? 0 : 1)
        }
      }
    }
  }
}

function placeStatic(canvas: Canvas): void {
  const size = canvas.size
  placeFinder(canvas, 0, 0)
  placeFinder(canvas, 0, size - 7)
  placeFinder(canvas, size - 7, 0)
  placeAlignment(canvas)

  for (let i = 8; i < size - 8; i++) {
    const bit: Bit = i % 2 === 0 ? 1 : 0
    set(canvas, 6, i, bit)
    set(canvas, i, 6, bit)
  }

  set(canvas, size - 8, 8, 1)

  for (let i = 0; i <= 8; i++) {
    reserve(canvas, 8, i)
    reserve(canvas, i, 8)
  }
  for (let i = 0; i < 8; i++) {
    reserve(canvas, 8, size - 1 - i)
    reserve(canvas, size - 1 - i, 8)
  }

  if (canvas.version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3)
      const b = (i % 3) + size - 11
      reserve(canvas, a, b)
      reserve(canvas, b, a)
    }
  }
}

function placeData(canvas: Canvas, words: number[]): void {
  const size = canvas.size
  const bits: Bit[] = []
  for (const word of words) {
    for (let i = 7; i >= 0; i--) bits.push(((word >>> i) & 1) as Bit)
  }

  let at = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (const col of [right, right - 1]) {
        if (canvas.fixed[row]![col]) continue
        canvas.modules[row]![col] = bits[at++] ?? 0
      }
    }
    upward = !upward
  }
}

const MASKS: ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

function formatBits(ec: ErrorCorrection, mask: number): number {
  const data = (EC_BITS[ec] << 3) | mask
  let value = data << 10
  for (let i = 14; i >= 10; i--) {
    if ((value >>> i) & 1) value ^= 0b10100110111 << (i - 10)
  }
  return ((data << 10) | value) ^ 0b101010000010010
}

function versionBits(version: number): number {
  let value = version << 12
  for (let i = 17; i >= 12; i--) {
    if ((value >>> i) & 1) value ^= 0b1111100100101 << (i - 12)
  }
  return (version << 12) | value
}

function applyFormat(grid: Bit[][], ec: ErrorCorrection, mask: number): void {
  const size = grid.length
  const bits = formatBits(ec, mask)
  const at = (i: number): Bit => ((bits >>> (14 - i)) & 1) as Bit

  for (let i = 0; i <= 5; i++) grid[8]![i] = at(i)
  grid[8]![7] = at(6)
  grid[8]![8] = at(7)
  grid[7]![8] = at(8)
  for (let i = 9; i <= 14; i++) grid[14 - i]![8] = at(i)

  for (let i = 0; i <= 6; i++) grid[size - 1 - i]![8] = at(i)
  for (let i = 7; i <= 14; i++) grid[8]![size - 15 + i] = at(i)

  grid[size - 8]![8] = 1
}

function applyVersion(canvas: Canvas): void {
  if (canvas.version < 7) return
  const size = canvas.size
  const bits = versionBits(canvas.version)
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) as Bit
    const a = Math.floor(i / 3)
    const b = (i % 3) + size - 11
    canvas.modules[a]![b] = bit
    canvas.modules[b]![a] = bit
  }
}

function masked(canvas: Canvas, mask: number): Bit[][] {
  const rule = MASKS[mask]!
  return canvas.modules.map((row, r) =>
    row.map((bit, c) => (canvas.fixed[r]![c] || !rule(r, c) ? bit : ((bit ^ 1) as Bit)))
  )
}

function runPenalty(line: (0 | 1)[]): number {
  let score = 0
  let run = 1
  for (let i = 1; i < line.length; i++) {
    if (line[i] === line[i - 1]) {
      run++
    } else {
      if (run >= 5) score += run - 2
      run = 1
    }
  }
  if (run >= 5) score += run - 2
  return score
}

const FINDER_RUN = [1, 0, 1, 1, 1, 0, 1]

function finderPenalty(line: (0 | 1)[]): number {
  let score = 0
  for (let i = 0; i + 7 <= line.length; i++) {
    if (!FINDER_RUN.every((bit, j) => line[i + j] === bit)) continue
    const before = line.slice(Math.max(0, i - 4), i)
    const after = line.slice(i + 7, i + 11)
    if (before.length === 4 && before.every((b) => b === 0)) score += 40
    if (after.length === 4 && after.every((b) => b === 0)) score += 40
  }
  return score
}

function penalty(grid: Bit[][]): number {
  const size = grid.length
  let score = 0

  for (let r = 0; r < size; r++) {
    const row = grid[r]!
    const col = grid.map((line) => line[r]!)
    score += runPenalty(row) + runPenalty(col)
    score += finderPenalty(row) + finderPenalty(col)
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const a = grid[r]![c]
      if (a === grid[r]![c + 1] && a === grid[r + 1]![c] && a === grid[r + 1]![c + 1]) score += 3
    }
  }

  const dark = grid.flat().filter((bit) => bit === 1).length
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10

  return score
}

export function encodeQr(text: string, ec: ErrorCorrection = 'M'): Bit[][] {
  const bytes = Buffer.from(text, 'utf8')
  const version = pickVersion(bytes.length, ec)

  const canvas = newCanvas(version)
  placeStatic(canvas)
  applyVersion(canvas)
  placeData(canvas, interleave(encodeData(bytes, version, ec), version, ec))

  let best: Bit[][] | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    const candidate = masked(canvas, mask)
    applyFormat(candidate, ec, mask)
    const score = penalty(candidate)
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best!
}

const WEAKER: Record<ErrorCorrection, ErrorCorrection[]> = {
  H: ['H', 'Q', 'M', 'L'],
  Q: ['Q', 'M', 'L'],
  M: ['M', 'L'],
  L: ['L'],
}

export function encodeQrFitting(
  text: string,
  ec: ErrorCorrection = 'M'
): { grid: Bit[][]; ec: ErrorCorrection } {
  let refusal: unknown
  for (const level of WEAKER[ec]) {
    try {
      return { grid: encodeQr(text, level), ec: level }
    } catch (err) {
      refusal = err
    }
  }
  throw refusal
}

export function qrSvg(text: string, ec: ErrorCorrection = 'M', quiet = 2): string {
  const { grid } = encodeQrFitting(text, ec)
  const size = grid.length + quiet * 2

  let path = ''
  grid.forEach((row, r) => {
    row.forEach((bit, c) => {
      if (bit === 1) path += `M${c + quiet} ${r + quiet}h1v1h-1z`
    })
  })

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"`,
    ` shape-rendering="crispEdges" role="img" aria-label="Two-factor setup code">`,
    `<rect width="${size}" height="${size}" fill="#fff"/>`,
    `<path d="${path}" fill="#000"/>`,
    `</svg>`,
  ].join('')
}
