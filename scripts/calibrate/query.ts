// The thin adapter: span events of one Worker over a window, through the CD's own query path (scripts/cd/o11y.ts:
// `cf o11y telemetry query`, paged, retried per the rollout policy's telemetry.query bound). cf reads the account and
// token the CD uses (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, or a `cf` login). Long windows are cut into slices so
// each stays under the CD's page ceiling (TELEMETRY_MAX_PAGES x TELEMETRY_PAGE events).
import { queryAll, type QueryRetry } from '../cd/o11y.ts'
import { API_ROUTES } from '../../src/api-routes.ts'
import { serviceFilter, spanTypeFilter, telemetryQuery, type Filter } from '../cd/telemetry.ts'

export type SpanQuery = {
  readonly worker: string
  readonly from: number
  readonly to: number
  /** Slice length. Each slice is one paged query. */
  readonly sliceMs: number
  /**
   * Keep only these `ply.route` values. Null means the default allowlist
   * (`DEFAULT_CALIBRATE_ROUTES`) unless `includeNoisy` is true.
   */
  readonly routes: readonly string[] | null
  /** When true and `routes` is null, do not allowlist: return every span of the Worker. */
  readonly includeNoisy: boolean
}

export type Slice = { readonly from: number; readonly to: number }

/** [from, to) cut into consecutive slices of at most `sliceMs`. */
export function slices(from: number, to: number, sliceMs: number): Slice[] {
  if (!(sliceMs > 0)) throw new Error('slice must be positive')
  if (!(to > from)) throw new Error('window must end after it starts')
  const out: Slice[] = []
  for (let at = from; at < to; at += sliceMs) out.push({ from: at, to: Math.min(to, at + sliceMs) })
  return out
}

/**
 * Routes that dominate Workers Observability under the million-client rate/viewer load (issue #73 loop
 * 2026-11-08): ~18M viewer + ~4.8M rate.* spans / 24h vs tens of thousands of /v1 spans. Child spans of
 * those routes often omit `ply.route`, so a `neq` exclude still pages them and overflows TELEMETRY_MAX_PAGES
 * even on a one-hour slice. Default queries therefore allowlist the calibration routes (every /v1 git
 * route plus `GET /`); pass `includeNoisy: true` (or `--include-noisy`) for an unfiltered span query, and
 * shrink `--slice` when you do.
 */
export const NOISY_ROUTES = ['viewer', 'rate.check', 'rate.flush', 'rate.refresh'] as const

/** Default allowlist: every /v1 git route plus the unauthenticated root probe. */
export const DEFAULT_CALIBRATE_ROUTES: readonly string[] = [...API_ROUTES, 'GET /']

export type SpanFilterOpts = {
  /** Keep only these `ply.route` values (`in`/`eq`). Null keeps DEFAULT_CALIBRATE_ROUTES unless includeNoisy. */
  readonly routes: readonly string[] | null
  /** When true and `routes` is null, do not allowlist: return every span of the Worker. */
  readonly includeNoisy: boolean
}

const DEFAULT_SPAN_FILTER_OPTS: SpanFilterOpts = { routes: null, includeNoisy: false }

/** The filters every calibration query uses: this Worker's span events (ply's spans and the runtime's request spans). */
export function spanFilters(worker: string, opts: SpanFilterOpts = DEFAULT_SPAN_FILTER_OPTS): Filter[] {
  const filters: Filter[] = [serviceFilter(worker), spanTypeFilter()]
  const routes = opts.routes
  if (routes !== null && routes.length > 0) {
    filters.push({
      key: 'ply.route',
      operation: routes.length === 1 ? 'eq' : 'in',
      type: 'string',
      value: routes.join(','),
    })
    return filters
  }
  if (opts.includeNoisy) return filters
  filters.push({
    key: 'ply.route',
    operation: 'in',
    type: 'string',
    value: DEFAULT_CALIBRATE_ROUTES.join(','),
  })
  return filters
}

/** The query body of the first slice: what a citation names as its `query`. */
export function citedQuery(query: SpanQuery): ReturnType<typeof telemetryQuery> {
  return telemetryQuery('events', query.from, query.to, spanFilters(query.worker, query), null)
}

export async function querySpanEvents(query: SpanQuery, retry: QueryRetry, secrets: readonly string[] = []): Promise<unknown[]> {
  const out: unknown[] = []
  const filters = spanFilters(query.worker, query)
  for (const slice of slices(query.from, query.to, query.sliceMs)) {
    out.push(...await queryAll('events', slice.from, slice.to, filters, retry, secrets))
  }
  return out
}
