import { deflateSync } from 'node:zlib'

export type Rgb = readonly [number, number, number]

export type ChartPoint = {
  readonly x: string
  readonly y: number
}

export type ChartSeries = {
  readonly name: string
  readonly rgb: Rgb
  readonly points: readonly ChartPoint[]
}

export type ChartSpec = {
  readonly title: string
  readonly series: readonly ChartSeries[]
  readonly hLine?: { readonly y: number; readonly rgb: Rgb }
}

const WIDTH = 720
const HEIGHT = 400
const LEFT = 56
const RIGHT = 16
const TOP = 36
const BOTTOM = 48

/** 5×7 glyphs, row-major, '.' off and '#' on. Unknown characters are skipped. */
const GLYPH: Record<string, string> = {
  ' ': '......./......./......./......./......./......./.......',
  '.': '......./......./......./......./......./..#.#../.......',
  '-': '......./......./......./#######/......./......./.......',
  '/': '.....#./....#../...#.../..#..../.#...../#....../.......',
  '%': '#...#../#..#.#./#.#.#../..#.#../.#.#.#./.#..#../#...#..',
  '0': '.#####./#.....#/#.....#/#.....#/#.....#/#.....#/.#####.',
  '1': '...#.../..##.../...#.../...#.../...#.../...#.../..###..',
  '2': '.#####./#.....#/.....#./...#.../..#..../.#...../#######',
  '3': '.#####./#.....#/.....#./..###../.....#./#.....#/.#####.',
  '4': '...#.../..##.../.#.#.../#..#.../#######/....#.../....#..',
  '5': '#######/#....../######./.....#./.....#./#.....#/.#####.',
  '6': '.#####./#....../#....../######./#.....#/#.....#/.#####.',
  '7': '#######/.....#./....#.../...#.../..#..../.#...../.#.....',
  '8': '.#####./#.....#/.#####./#.....#/#.....#/#.....#/.#####.',
  '9': '.#####./#.....#/#.....#/.######/.....#./.....#./.#####.',
  'a': '.#####./#.....#/#.....#/#######/#.....#/#.....#/#.....#',
  'b': '######./#.....#/######./#.....#/#.....#/#.....#/######.',
  'c': '.#####./#.....#/#....../#....../#....../#.....#/.#####.',
  'd': '######./#.....#/#.....#/#.....#/#.....#/#.....#/######.',
  'e': '#######/#....../######./#....../#....../#....../#######',
  'f': '#######/#....../######./#....../#....../#....../#......',
  'g': '.#####./#.....#/#....../#..####/#.....#/#.....#/.#####.',
  'h': '#.....#/#.....#/#######/#.....#/#.....#/#.....#/#.....#',
  'i': '..###../...#.../...#.../...#.../...#.../...#.../..###..',
  'l': '#....../#....../#....../#....../#....../#....../#######',
  'm': '#.....#/##...##/#.#.#.#/#..#..#/#.....#/#.....#/#.....#',
  'n': '#.....#/##....#/#.#...#/#..#..#/#...#.#/#....##/#.....#',
  'o': '.#####./#.....#/#.....#/#.....#/#.....#/#.....#/.#####.',
  'p': '######./#.....#/#.....#/######./#....../#....../#......',
  'r': '######./#.....#/#.....#/######./#..#.../#...#../#.....#',
  's': '.#####./#.....#/#....../.#####./.....#./#.....#/.#####.',
  't': '#######/...#.../...#.../...#.../...#.../...#.../...#...',
  'u': '#.....#/#.....#/#.....#/#.....#/#.....#/#.....#/.#####.',
  'v': '#.....#/#.....#/#.....#/#.....#/.#...#./..#.#../...#...',
  'w': '#.....#/#.....#/#.....#/#..#..#/#.#.#.#/##...##/#.....#',
  'y': '#.....#/#.....#/.#...#./..#.#../...#.../...#.../...#...',
}

function glyphRows(ch: string): string[] {
  const raw = GLYPH[ch.toLowerCase()] ?? GLYPH[' '] ?? ''
  return raw.split('/')
}

function drawText(buf: Uint8Array, x: number, y: number, text: string, rgb: Rgb): void {
  let cursor = x
  for (const ch of text) {
    const rows = glyphRows(ch)
    for (let row = 0; row < rows.length; row++) {
      const bits = rows[row] ?? ''
      for (let col = 0; col < bits.length; col++) {
        if (bits[col] !== '#') continue
        set(buf, cursor + col, y + row, rgb)
      }
    }
    cursor += 8
  }
}

function set(buf: Uint8Array, x: number, y: number, rgb: Rgb): void {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return
  const i = (y * WIDTH + x) * 3
  buf[i] = rgb[0]
  buf[i + 1] = rgb[1]
  buf[i + 2] = rgb[2]
}

function fill(buf: Uint8Array, x: number, y: number, w: number, h: number, rgb: Rgb): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) set(buf, xx, yy, rgb)
  }
}

function hline(buf: Uint8Array, y: number, rgb: Rgb): void {
  for (let x = LEFT; x < WIDTH - RIGHT; x++) set(buf, x, y, rgb)
}

function crc32(data: Uint8Array): number {
  let c = ~0
  for (const byte of data) {
    c ^= byte
    for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type), Buffer.from(data)])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A small bar chart. Empty series still produce a titled PNG. */
export function chartPng(spec: ChartSpec): Buffer {
  const buf = new Uint8Array(WIDTH * HEIGHT * 3)
  buf.fill(255)
  const ink: Rgb = [15, 23, 42]
  drawText(buf, 16, 12, spec.title, ink)
  const plotW = WIDTH - LEFT - RIGHT
  const plotH = HEIGHT - TOP - BOTTOM
  fill(buf, LEFT, TOP, plotW, 1, ink)
  fill(buf, LEFT, TOP + plotH, plotW, 1, ink)
  fill(buf, LEFT, TOP, 1, plotH, ink)
  const ys = spec.series.flatMap(series => series.points.map(point => point.y))
  if (spec.hLine) ys.push(spec.hLine.y)
  const max = Math.max(1, ...ys, 0)
  const yOf = (value: number) => TOP + plotH - Math.round((value / max) * (plotH - 4))
  if (spec.hLine) hline(buf, yOf(spec.hLine.y), spec.hLine.rgb)
  const labels = spec.series[0]?.points.map(point => point.x) ?? []
  const groups = Math.max(labels.length, 1)
  const groupW = plotW / groups
  const barW = Math.max(2, Math.floor((groupW * 0.8) / Math.max(spec.series.length, 1)))
  spec.series.forEach((series, seriesIndex) => {
    series.points.forEach((point, index) => {
      const x = Math.round(LEFT + index * groupW + 4 + seriesIndex * barW)
      const y = yOf(point.y)
      const h = TOP + plotH - y
      if (h > 0) fill(buf, x, y, barW - 1, h, series.rgb)
    })
  })
  labels.forEach((label, index) => {
    drawText(buf, Math.round(LEFT + index * groupW + 2), HEIGHT - 28, label, ink)
  })
  spec.series.forEach((series, index) => {
    const x = LEFT + index * 120
    fill(buf, x, HEIGHT - 16, 10, 8, series.rgb)
    drawText(buf, x + 14, HEIGHT - 18, series.name, ink)
  })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(WIDTH, 0)
  ihdr.writeUInt32BE(HEIGHT, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3))
  for (let y = 0; y < HEIGHT; y++) {
    const row = y * (1 + WIDTH * 3)
    raw[row] = 0
    Buffer.from(buf.buffer, buf.byteOffset + y * WIDTH * 3, WIDTH * 3).copy(raw, row + 1)
  }
  const idat = deflateSync(raw)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array())])
}
