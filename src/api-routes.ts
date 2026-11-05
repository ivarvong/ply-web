// The /v1 git routes, as `METHOD /path` keys of the READS and WRITES tables in src/index.js.
// Every one runs under src/edge-trace.ts's tracer. test/worker-spans.test.js drives each key here and asserts its ply
// spans reach Workers tracing, so a route added to index.js and not here stops the Worker at load (assertRouteTable).
// /v1/flags and /v1/flags/eval are not git routes: they make no ply call and record no ply span.

export const API_READ_ROUTES = [
  'GET /v1/refs',
  'GET /v1/discover',
  'GET /v1/tree',
  'GET /v1/commit',
  'GET /v1/read',
] as const

export const API_WRITE_ROUTES = [
  'POST /v1/edit',
  'POST /v1/branch',
  'DELETE /v1/branch',
  'POST /v1/tag',
  'DELETE /v1/tag',
  'POST /v1/merge',
  'POST /v1/rebase',
  'POST /v1/cherry-pick',
  'POST /v1/revert',
] as const

export type ApiRoute = (typeof API_READ_ROUTES)[number] | (typeof API_WRITE_ROUTES)[number]

export const API_ROUTES: readonly ApiRoute[] = [...API_READ_ROUTES, ...API_WRITE_ROUTES]

function drift(kind: string, want: readonly string[], table: Readonly<Record<string, unknown>>): string[] {
  const have = Object.keys(table)
  const missing = want.filter(key => !have.includes(key)).map(key => `${kind} table lacks ${key}`)
  const extra = have.filter(key => !want.includes(key)).map(key => `${kind} route ${key} is not in src/api-routes.ts`)
  return [...missing, ...extra]
}

/** Throws when the dispatch tables and this list differ. src/index.js calls it once, at module load. */
export function assertRouteTable(reads: Readonly<Record<string, unknown>>, writes: Readonly<Record<string, unknown>>): void {
  const problems = [...drift('read', API_READ_ROUTES, reads), ...drift('write', API_WRITE_ROUTES, writes)]
  if (problems.length > 0) throw new Error(`/v1 route table drift: ${problems.join('; ')}`)
}
