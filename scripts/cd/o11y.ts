import { createHash } from 'node:crypto'
import { dig } from '../../src/absent.ts'
import { assertNever } from '../../src/never.ts'
import { TELEMETRY_MAX_PAGES, TELEMETRY_PAGE } from './baseline.ts'
import { runCf } from './cf.ts'
import { extractJson } from './json.ts'
import { activeLog } from './log.ts'
import type { RolloutPolicy } from './policy.ts'
import { currentLog, recordQueryAttempt, retryQuery, type QueryAttempt, type QueryBound } from './query-retry.ts'
import { dedupeRows, pageCursor, telemetryQuery, unwrapEvents, type Filter } from './telemetry.ts'

export type CapturedQuery = {
  readonly events: unknown[]
  /**
   * sha256 of each page's stdout as the run log stored it (its command `stdoutDigest`, blob `blobs/<sha256>.gz`).
   * An observation cites pages by digest instead of embedding them again.
   */
  readonly pages: readonly string[]
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
  body: object,
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

/** Every page of one observability query, repeats removed, plus each page's capture digest and the first query body. */
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
    const log = activeLog()
    pages.push(log ? log.digest(stdout) : createHash('sha256').update(stdout).digest('hex'))
    const events = unwrapEvents(extractJson(stdout))
    out.push(...events)
    // A short page is the last page. On 2026-11-01 the ramp pages were short of
    // TELEMETRY_PAGE because the index held that many rows: the series sum equalled
    // the page, sampleInterval was 1, and statistics.abr_level was 1.
    if (events.length < TELEMETRY_PAGE) {
      return { events: dedupeRows(out), pages, query: first }
    }
    const cursor = pageCursor(events)
    if (!cursor) throw new Error('a full telemetry page has no usable $metadata.id cursor')
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
 * parallel instead of serially into TELEMETRY_MAX_PAGES. Repeated rows are removed by `rowKey`.
 */
export async function queryCapturedSliced(
  view: 'events' | 'traces',
  from: number,
  to: number,
  filters: readonly Filter[],
  retry: QueryRetry,
): Promise<CapturedQuery> {
  const bounds: [number, number][] = []
  // The timeframe excludes both endpoints: on 2026-11-08 rows stamped exactly at a slice edge were in neither neighbouring
  // slice (17:19:44.000Z: 4 rows in [b-1000, b+1], 0 in [b-1000, b] and in [b, b+1000]). End each slice 1 ms past its edge.
  for (let start = from; start < to; start += SLICE_MS) bounds.push([start, Math.min(to, start + SLICE_MS) + 1])
  if (bounds.length === 0) bounds.push([from, to])
  const parts = await Promise.all(bounds.map(([start, end]) => queryCaptured(view, start, end, filters, retry)))
  const events = dedupeRows(parts.flatMap(part => part.events))
  const first = parts[0]
  if (!first) throw new Error('sliced query with no slice')
  return { events, pages: parts.flatMap(part => part.pages), query: telemetryQuery(view, from, to, filters, null) }
}

/** One count per group of a `calculations` aggregate. A group whose key is absent on an event drops that event. */
export type CountRow = { readonly groups: Readonly<Record<string, string>>; readonly count: number }

/**
 * `count` over [from, to], grouped by `groupBys` (string keys). Workers Observability omits an event from a grouped count
 * when it lacks one of the group keys, so callers group only by keys every matching event carries.
 */
export async function queryCounts(from: number, to: number, filters: readonly Filter[], groupBys: readonly string[], retry: QueryRetry): Promise<CountRow[]> {
  const body = {
    queryId: 'ply-cd-rate',
    timeframe: { from, to },
    view: 'calculations',
    chartType: 'aggregate',
    parameters: {
      calculations: [{ operator: 'count' }],
      groupBys: groupBys.map(value => ({ type: 'string', value })),
      limit: 1000,
      filters: [...filters],
    },
  }
  return countRows(extractJson(await queryPage(body, [], retry)))
}

/** The aggregate rows of a calculations response. No calculation block is zero rows, not an error. */
export function countRows(payload: unknown): CountRow[] {
  const calcs = dig(payload, ['calculations'])
  if (calcs.tag === 'none' || !Array.isArray(calcs.value)) throw new Error('calculations response has no calculations list')
  const found = dig(calcs.value, ['0', 'aggregates'])
  const aggregates: unknown[] = found.tag === 'some' && Array.isArray(found.value) ? found.value : []
  const rows: CountRow[] = []
  for (const item of aggregates) {
    const groups: Record<string, string> = {}
    const list = dig(item, ['groups'])
    if (list.tag === 'some' && Array.isArray(list.value)) {
      for (const g of list.value as unknown[]) {
        const key = dig(g, ['key'])
        const value = dig(g, ['value'])
        if (key.tag === 'some' && value.tag === 'some') groups[String(key.value)] = String(value.value)
      }
    }
    const count = dig(item, ['count'])
    rows.push({ groups, count: count.tag === 'some' && typeof count.value === 'number' ? count.value : 0 })
  }
  return rows
}
