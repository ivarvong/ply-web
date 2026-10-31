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
