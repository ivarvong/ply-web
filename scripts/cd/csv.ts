export type CsvRow = {
  readonly step: string
  readonly method: string
  readonly path: string
  readonly status: number
  readonly ms: number
  readonly pass: boolean
  readonly cfRay: string
  readonly requestId: string
  readonly artifactsRay: string
  readonly version: string
  readonly build: string
  readonly serverTiming: string
  readonly detail: string
}

const COLUMNS = [
  'step',
  'method',
  'path',
  'status',
  'ms',
  'pass',
  'cf_ray',
  'x_ply_request_id',
  'x_artifacts_ray',
  'x_ply_version',
  'x_ply_build',
  'server_timing',
  'detail',
] as const

function cell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function csvLine(row: CsvRow): string {
  const values = [
    row.step,
    row.method,
    row.path,
    String(row.status),
    String(row.ms),
    row.pass ? 'pass' : 'fail',
    row.cfRay,
    row.requestId,
    row.artifactsRay,
    row.version,
    row.build,
    row.serverTiming,
    row.detail,
  ]
  return values.map(cell).join(',')
}

export function csvDocument(rows: readonly CsvRow[]): string {
  return [COLUMNS.join(','), ...rows.map(csvLine)].join('\n') + '\n'
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === ',') {
      row.push(cell)
      cell = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      if (row.some(value => value !== '')) rows.push(row)
      row = []
      cell = ''
      continue
    }
    cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    if (row.some(value => value !== '')) rows.push(row)
  }
  return rows
}

/** x-ply-request-id → cf-ray from a smoke CSV. Rows without either field are skipped. */
export function raysByRequestId(text: string): ReadonlyMap<string, string> {
  const rows = parseCsv(text)
  const header = rows[0]
  if (!header) return new Map()
  const idAt = header.indexOf('x_ply_request_id')
  const rayAt = header.indexOf('cf_ray')
  if (idAt < 0 || rayAt < 0) return new Map()
  const out = new Map<string, string>()
  for (const row of rows.slice(1)) {
    const id = row[idAt] ?? ''
    const ray = row[rayAt] ?? ''
    if (id !== '' && ray !== '') out.set(id, ray)
  }
  return out
}
