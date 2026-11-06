import { assertNever } from '../../src/never.ts'
import { TELEMETRY_MAX_PAGES, TELEMETRY_PAGE } from './baseline.ts'
import { runCf } from './cf.ts'
import { extractJson } from './json.ts'
import type { RolloutPolicy } from './policy.ts'
import { currentLog, recordQueryAttempt, retryQuery, type QueryAttempt, type QueryBound } from './query-retry.ts'
import { pageCursor, telemetryQuery, unwrapEvents, type Filter } from './telemetry.ts'

export type CapturedQuery = {
  readonly events: unknown[]
  readonly raw: string
  readonly query: ReturnType<typeof telemetryQuery>
}

export type QueryRetry = {
  readonly bound: QueryBound
  readonly sleep: (ms: number) => Promise<void>
  readonly note: (ordinal: number, attempt: QueryAttempt) => Promise<void>
}

export function telemetryQueryRetry(policy: RolloutPolicy): QueryRetry {
  return {
    bound: { attempts: policy.telemetry.query.attempts, backoffMs: policy.telemetry.query.backoffMs },
    sleep: ms => new Promise(resolve => {
      setTimeout(resolve, ms)
    }),
    note: (ordinal, attempt) => recordQueryAttempt(currentLog(), ordinal, attempt),
  }
}

async function queryPage(
  body: ReturnType<typeof telemetryQuery>,
  secrets: readonly string[],
  retry: QueryRetry,
): Promise<string> {
  const result = await retryQuery(retry.bound, {
    once: async () => {
      const started = Date.now()
      const ran = await runCf(['o11y', 'telemetry', 'query', '--body', JSON.stringify(body)], secrets)
      return { code: ran.code, stdout: ran.stdout, stderr: ran.stderr, latencyMs: Date.now() - started }
    },
    sleep: retry.sleep,
  })
  let ordinal = 0
  for (const attempt of result.attempts) {
    ordinal += 1
    await retry.note(ordinal, attempt)
  }
  switch (result.kind) {
    case 'ok':
      return result.stdout
    case 'lost': {
      const last = result.attempts[result.attempts.length - 1]
      const detail = last && last.kind === 'transient' ? last.detail : 'no attempt'
      throw new Error(`telemetry query failed after ${result.attempts.length} attempts: ${detail}`)
    }
    default:
      return assertNever(result)
  }
}

/** Every page of one observability query, plus the raw pages and the first query body. */
export async function queryCaptured(
  view: 'events' | 'traces',
  from: number,
  to: number,
  filters: readonly Filter[],
  retry: QueryRetry,
  secrets: readonly string[] = [],
): Promise<CapturedQuery> {
  const out: unknown[] = []
  const pages: string[] = []
  let offset: string | null = null
  let first: ReturnType<typeof telemetryQuery> | null = null
  for (let page = 0; page < TELEMETRY_MAX_PAGES; page++) {
    const body = telemetryQuery(view, from, to, filters, offset)
    if (!first) first = body
    const stdout = await queryPage(body, secrets, retry)
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
  retry: QueryRetry,
  secrets: readonly string[] = [],
): Promise<unknown[]> {
  return (await queryCaptured(view, from, to, filters, retry, secrets)).events
}

/** Width of one slice of a sliced query. 10 s of ply's non-span events under load was 3719 events in 4 pages (2026-11-06). */
export const SLICE_MS = 10_000

/** Events that are not child spans: invocations and logs. Spans are ~85% of ply's events under load and gate nothing. */
export function notSpanFilter(): Filter {
  return { key: '$metadata.type', operation: 'neq', type: 'string', value: 'span' }
}

/**
 * One query over [from, to], run as parallel `SLICE_MS` windows so a busy window pages in
 * parallel instead of serially into TELEMETRY_MAX_PAGES. Rows are deduplicated by `$metadata.id`.
 */
export async function queryCapturedSliced(
  view: 'events' | 'traces',
  from: number,
  to: number,
  filters: readonly Filter[],
  retry: QueryRetry,
): Promise<CapturedQuery> {
  const bounds: [number, number][] = []
  for (let start = from; start < to; start += SLICE_MS) bounds.push([start, Math.min(to, start + SLICE_MS)])
  if (bounds.length === 0) bounds.push([from, to])
  const parts = await Promise.all(bounds.map(([start, end]) => queryCaptured(view, start, end, filters, retry)))
  const seen = new Set<string>()
  const events: unknown[] = []
  for (const part of parts) {
    for (const event of part.events) {
      const id = metaId(event)
      if (id !== '') {
        if (seen.has(id)) continue
        seen.add(id)
      }
      events.push(event)
    }
  }
  const first = parts[0]
  if (!first) throw new Error('sliced query with no slice')
  return { events, raw: parts.map(part => part.raw).join('\n'), query: telemetryQuery(view, from, to, filters, null) }
}

function metaId(event: unknown): string {
  if (typeof event !== 'object' || event === null || !('$metadata' in event)) return ''
  const meta = event.$metadata
  if (typeof meta !== 'object' || meta === null || !('id' in meta)) return ''
  return typeof meta.id === 'string' ? meta.id : ''
}
