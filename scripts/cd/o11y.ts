import { TELEMETRY_MAX_PAGES, TELEMETRY_PAGE } from './baseline.ts'
import { cfOk } from './cf.ts'
import { extractJson } from './json.ts'
import { pageCursor, telemetryQuery, unwrapEvents, type Filter } from './telemetry.ts'

export type CapturedQuery = {
  readonly events: unknown[]
  readonly raw: string
  readonly query: ReturnType<typeof telemetryQuery>
}

/** Every page of one observability query, plus the raw pages and the first query body. */
export async function queryCaptured(
  view: 'events' | 'traces',
  from: number,
  to: number,
  filters: readonly Filter[],
  secrets: readonly string[] = [],
): Promise<CapturedQuery> {
  const out: unknown[] = []
  const pages: string[] = []
  let offset: string | undefined
  let first: ReturnType<typeof telemetryQuery> | null = null
  for (let page = 0; page < TELEMETRY_MAX_PAGES; page++) {
    const body = telemetryQuery(view, from, to, filters, offset)
    if (!first) first = body
    const stdout = await cfOk(['o11y', 'telemetry', 'query', '--body', JSON.stringify(body)], secrets)
    pages.push(stdout)
    const events = unwrapEvents(extractJson(stdout))
    out.push(...events)
    // A short page is the last page. On 2026-11-01 the ramp pages were short of
    // TELEMETRY_PAGE because the index held that many rows: the series sum equalled
    // the page, sampleInterval was 1, and statistics.abr_level was 1.
    if (events.length < TELEMETRY_PAGE) {
      return { events: out, raw: pages.join('\n'), query: first }
    }
    const cursor = pageCursor(events)
    if (!cursor) throw new Error('a full telemetry page has no $metadata.id cursor')
    offset = cursor
  }
  throw new Error(`more than ${TELEMETRY_MAX_PAGES} pages of telemetry`)
}

/** Every page of one observability query. A thrown error means telemetry is unavailable. */
export async function queryAll(
  view: 'events' | 'traces',
  from: number,
  to: number,
  filters: readonly Filter[],
  secrets: readonly string[] = [],
): Promise<unknown[]> {
  return (await queryCaptured(view, from, to, filters, secrets)).events
}
