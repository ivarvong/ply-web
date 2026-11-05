// Issue #67: every ply span of a /v1 request is a Workers span under the request span (src/edge-trace.ts).
// The pinned smoke sends one single-file find/replace edit, `edit-traced` (scripts/cd/lifecycle.ts), with the version
// override. This check finds that request's span events in Workers Observability (`$metadata.type = span`, joined on
// the smoke's cf-ray, then on the traceId those events carry) and requires ply's span names among them.
//
//   pass           every expected name is in the edit's trace
//   worker         the edit's trace was ingested (its spans are there) and a ply span is not: the regression in #67
//   harness_fault  no span event joins to the edit after polling, or the smoke has no edit-traced request: unevaluable
import { asRecord } from './json.ts'
import { TRACED_EDIT_STEP } from './lifecycle.ts'
import { rayIdOf, sameRay, spanNameOf, traceIdOf, type SmokeRequest } from './telemetry.ts'

export { TRACED_EDIT_STEP }

/** Span names ply records for that edit (ply's span contract; test/worker-spans.test.js sees the same under workerd). */
export const TRACED_EDIT_SPANS = ['git.edit', 'git.edit.tree', 'git.edit.blob', 'git.upload-pack fetch', 'git.receive-pack'] as const

export type SpanCheck =
  | { readonly kind: 'pass'; readonly line: string; readonly traceIds: readonly string[]; readonly names: readonly string[] }
  | { readonly kind: 'worker'; readonly line: string; readonly traceIds: readonly string[]; readonly names: readonly string[]; readonly missing: readonly string[] }
  | { readonly kind: 'harness_fault'; readonly line: string }

const PREFIX = 'spans:'

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

/** Judge the span events of one window for the smoke's edit-traced request. Pure: the caller queries and polls. */
export function checkEditSpans(requests: readonly SmokeRequest[], spanEvents: readonly unknown[]): SpanCheck {
  const request = requests.find(row => row.step === TRACED_EDIT_STEP)
  if (!request) return { kind: 'harness_fault', line: `${PREFIX} the smoke report has no ${TRACED_EDIT_STEP} request; cannot check ply spans (#67)` }
  const ray = request.ray
  if (!ray) return { kind: 'harness_fault', line: `${PREFIX} ${TRACED_EDIT_STEP} ${request.id} has no cf-ray to join span events on; cannot check ply spans (#67)` }
  const records = spanEvents.map(asRecord).filter((rec): rec is Record<string, unknown> => rec !== null)
  const traceIds = new Set<string>()
  for (const rec of records) {
    const eventRay = rayIdOf(rec)
    const traceId = traceIdOf(rec)
    if (eventRay && traceId && sameRay(eventRay, ray)) traceIds.add(traceId)
  }
  const joined = records.filter(rec => {
    const eventRay = rayIdOf(rec)
    if (eventRay && sameRay(eventRay, ray)) return true
    const traceId = traceIdOf(rec)
    return traceId !== null && traceIds.has(traceId)
  })
  if (joined.length === 0) {
    return { kind: 'harness_fault', line: `${PREFIX} no span event joined to ${TRACED_EDIT_STEP} ${request.id} (cf-ray ${ray}); Workers Observability has not ingested its trace, so ply spans cannot be checked (#67)` }
  }
  const names = sorted(joined.map(spanNameOf).filter((name): name is string => name !== null))
  const missing = TRACED_EDIT_SPANS.filter(name => !names.includes(name))
  const traces = sorted(traceIds)
  const where = `${TRACED_EDIT_STEP} ${request.id} trace ${traces.join(',') || '-'}`
  if (missing.length > 0) {
    return {
      kind: 'worker',
      line: `${PREFIX} ${where} is missing ply spans ${missing.join(', ')}; saw ${names.join(', ') || 'none'} (#67: ply spans are not reaching Workers tracing)`,
      traceIds: traces,
      names,
      missing,
    }
  }
  return { kind: 'pass', line: `${PREFIX} ${where} has ${TRACED_EDIT_SPANS.join(', ')} (${joined.length} span events)`, traceIds: traces, names }
}

export type SpanPoll = {
  /** One span-events query over the window. Throws when telemetry is unavailable. */
  readonly query: () => Promise<readonly unknown[]>
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  /** Waits between queries; the last repeats. */
  readonly pollsMs: readonly number[]
  /** Stop polling once this much time has passed since the first query. */
  readonly waitMs: number
}

/**
 * Query, judge, and query again while the edit's spans are not all there yet: span events of one trace are ingested
 * independently, so an early page can hold the fetch spans and not ply's. The verdict is the last query's.
 */
export async function pollEditSpans(requests: readonly SmokeRequest[], poll: SpanPoll): Promise<SpanCheck> {
  const started = poll.now()
  for (let attempt = 0; ; attempt++) {
    const check = checkEditSpans(requests, await poll.query())
    const waited = poll.now() - started
    if (check.kind === 'pass' || waited >= poll.waitMs || !requests.some(row => row.step === TRACED_EDIT_STEP && row.ray)) return check
    const pause = poll.pollsMs[Math.min(attempt, poll.pollsMs.length - 1)]
    await poll.sleep(Math.min(typeof pause === 'number' ? pause : poll.waitMs, poll.waitMs - waited))
  }
}
