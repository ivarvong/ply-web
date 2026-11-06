// The thin adapter: span events of one Worker over a window, through the CD's own query path (scripts/cd/o11y.ts:
// `cf o11y telemetry query`, paged, retried per the rollout policy's telemetry.query bound). cf reads the account and
// token the CD uses (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, or a `cf` login). Long windows are cut into slices so
// each stays under the CD's page ceiling (TELEMETRY_MAX_PAGES x TELEMETRY_PAGE events).
import { queryAll, type QueryRetry } from '../cd/o11y.ts'
import { serviceFilter, spanTypeFilter, telemetryQuery, type Filter } from '../cd/telemetry.ts'

export type SpanQuery = {
  readonly worker: string
  readonly from: number
  readonly to: number
  /** Slice length. Each slice is one paged query. */
  readonly sliceMs: number
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

/** The filters every calibration query uses: this Worker's span events (ply's spans and the runtime's request spans). */
export function spanFilters(worker: string): Filter[] {
  return [serviceFilter(worker), spanTypeFilter()]
}

/** The query body of the first slice: what a citation names as its `query`. */
export function citedQuery(query: SpanQuery): ReturnType<typeof telemetryQuery> {
  return telemetryQuery('events', query.from, query.to, spanFilters(query.worker), null)
}

export async function querySpanEvents(query: SpanQuery, retry: QueryRetry, secrets: readonly string[] = []): Promise<unknown[]> {
  const out: unknown[] = []
  for (const slice of slices(query.from, query.to, query.sliceMs)) {
    out.push(...await queryAll('events', slice.from, slice.to, spanFilters(query.worker), retry, secrets))
  }
  return out
}
