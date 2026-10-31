import { lossAllowance, verdict, type CanaryVerdict } from '../canary-verdict.mjs'
import { QUERY_SLACK_MS, TELEMETRY_PAGE, type LatencyCeiling } from './baseline.ts'
import { asRecord } from './json.ts'
import type { V1Request } from './slo.ts'

export type TelemetryFailure =
  | { readonly kind: 'exception'; readonly detail: string }
  | { readonly kind: 'unexpected-status'; readonly id: string; readonly status: number }
  | { readonly kind: 'log-error'; readonly detail: string }
  | { readonly kind: 'missing'; readonly detail: string }
  | { readonly kind: 'latency'; readonly metric: string; readonly p: 'p50' | 'p99'; readonly value: number; readonly ceiling: number }
  | { readonly kind: 'other-version'; readonly detail: string }
  | { readonly kind: 'trace-count'; readonly detail: string }

export type SmokeRequest = {
  readonly id: string
  readonly version: string | null
  readonly step: string
  readonly status: number
  readonly expected: readonly number[]
}

export type Filter = {
  readonly key: string
  readonly operation: string
  readonly type: string
  readonly value: string
}

export function telemetryQuery(
  view: 'events' | 'traces',
  from: number,
  to: number,
  filters: readonly Filter[],
  offset?: string,
) {
  return {
    queryId: 'ply-cd',
    timeframe: { from, to },
    view,
    limit: TELEMETRY_PAGE,
    ...(offset ? { offset } : {}),
    parameters: { filters: [...filters] },
  }
}

export function queryTo(now: number): number {
  return now + QUERY_SLACK_MS
}

export function serviceFilter(worker: string): Filter {
  return { key: '$metadata.service', operation: 'eq', type: 'string', value: worker }
}

export function versionFilter(version: string): Filter {
  return { key: '$workers.scriptVersion.id', operation: 'eq', type: 'string', value: version }
}

/** Workers Observability wraps the page as events.events or traces.traces. */
export function unwrapEvents(payload: unknown): unknown[] {
  const rec = asRecord(payload)
  if (!rec) return []
  const events = asRecord(rec.events)
  if (events && Array.isArray(events.events)) return events.events
  if (Array.isArray(rec.events)) return rec.events
  const traces = asRecord(rec.traces)
  if (traces && Array.isArray(traces.traces)) return traces.traces
  if (traces && Array.isArray(traces.events)) return traces.events
  if (Array.isArray(rec.traces)) return rec.traces
  return []
}

export function pageCursor(page: readonly unknown[]): string | null {
  const last = asRecord(page[page.length - 1])
  const meta = asRecord(last?.$metadata)
  return typeof meta?.id === 'string' && meta.id !== '' ? meta.id : null
}

/** Same percentile as scripts/canary-o11y.mjs: sorted[floor((n - 1) * p)], null when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.floor((sorted.length - 1) * p)] ?? null
}

/** Duration in milliseconds. The bare `duration` field is nanoseconds when it is above 1e6. */
export function spanDurationMs(span: Record<string, unknown>): number | null {
  const attrs = asRecord(span.attributes) ?? asRecord(span.attrs) ?? {}
  const millis = [span.durationMs, span.duration_ms, attrs.duration_ms, attrs.durationMs]
  for (const candidate of millis) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate
  }
  const raw = typeof span.duration === 'number' ? span.duration : attrs.duration
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  return raw > 1_000_000 ? raw / 1_000_000 : raw
}

function versionOf(event: Record<string, unknown>): string | null {
  const workers = asRecord(event.$workers)
  const script = asRecord(workers?.scriptVersion)
  return typeof script?.id === 'string' ? script.id : null
}

function requestIdOf(event: Record<string, unknown>): string | null {
  const meta = asRecord(event.$metadata)
  return typeof meta?.requestId === 'string' ? meta.requestId : null
}

function isLog(event: Record<string, unknown>): boolean {
  const source = asRecord(event.source)
  return source?.msg === 'ply.request' || event.msg === 'ply.request'
}

function smokeIdOf(event: Record<string, unknown>): string | null {
  const source = asRecord(event.source)
  if (typeof source?.id === 'string') return source.id
  return typeof event.id === 'string' ? event.id : null
}

function statusOf(event: Record<string, unknown>): number | null {
  const source = asRecord(event.source)
  const status = source?.status ?? event.status
  return typeof status === 'number' ? status : null
}

function isFetchInvocation(event: Record<string, unknown>): boolean {
  const meta = asRecord(event.$metadata)
  const workers = asRecord(event.$workers)
  return meta?.type === 'cf-worker-event' && workers?.eventType === 'fetch'
}

function exceptionCount(event: Record<string, unknown>): number {
  const workers = asRecord(event.$workers)
  if (Array.isArray(workers?.exceptions) && workers.exceptions.length > 0) return workers.exceptions.length
  if (workers?.outcome === 'exception') return 1
  return 0
}

function walk(node: unknown, visit: (rec: Record<string, unknown>) => void, seen: Set<object>): void {
  if (node === null || typeof node !== 'object') return
  if (seen.has(node)) return
  seen.add(node)
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, seen)
    return
  }
  const rec = node as Record<string, unknown>
  visit(rec)
  for (const value of Object.values(rec)) walk(value, visit, seen)
}

function collectStrings(node: unknown, into: Set<string>, seen: Set<object>): void {
  walk(node, rec => {
    for (const value of Object.values(rec)) {
      if (typeof value === 'string') into.add(value)
    }
  }, seen)
}

export type VersionStats = {
  readonly requests: number
  readonly exceptions: number
  readonly errors: number
  readonly fivexx: number
  readonly wallMs: readonly number[]
  readonly cpuMs: readonly number[]
  readonly fetchMs: readonly number[]
  readonly v1: readonly V1Request[]
}

function methodOf(event: Record<string, unknown>): V1Request['method'] {
  const source = asRecord(event.source)
  const method = source?.method ?? event.method
  if (method === 'GET' || method === 'POST') return method
  return 'OTHER'
}

function pathOf(event: Record<string, unknown>): string | null {
  const source = asRecord(event.source)
  const path = source?.path ?? event.path
  if (typeof path !== 'string' || path === '') return null
  const bare = path.split('?')[0]
  return bare || null
}

function v1From(events: readonly unknown[]): V1Request[] {
  const invocations = new Map<string, { wall: number | null; exception: boolean }>()
  for (const item of events) {
    const event = asRecord(item)
    if (!event || !isFetchInvocation(event)) continue
    const id = requestIdOf(event)
    if (!id) continue
    const workers = asRecord(event.$workers)
    invocations.set(id, {
      wall: typeof workers?.wallTimeMs === 'number' ? workers.wallTimeMs : null,
      exception: exceptionCount(event) > 0,
    })
  }
  const out: V1Request[] = []
  for (const item of events) {
    const event = asRecord(item)
    if (!event || !isLog(event)) continue
    const path = pathOf(event)
    if (!path || (path !== '/v1' && !path.startsWith('/v1/'))) continue
    const status = statusOf(event) ?? 0
    const id = requestIdOf(event)
    const linked = id ? invocations.get(id) : undefined
    const source = asRecord(event.source)
    const loggedMs = typeof source?.ms === 'number' ? source.ms : null
    out.push({
      method: methodOf(event),
      path,
      status,
      exception: linked?.exception ?? false,
      wallMs: linked?.wall ?? loggedMs,
      expected4xx: status >= 400 && status < 500,
    })
  }
  return out
}

/** Fetch spans have no script version. Attribute a span when its trace names a request id from `events`. */
function fetchMsJoined(events: readonly unknown[], traces: readonly unknown[]): number[] {
  const ids = new Set<string>()
  for (const item of events) {
    const event = asRecord(item)
    if (!event) continue
    const id = requestIdOf(event)
    if (id) ids.add(id)
  }
  const fetchMs: number[] = []
  for (const trace of traces) {
    const strings = new Set<string>()
    collectStrings(trace, strings, new Set())
    let hit = false
    for (const id of ids) {
      if (strings.has(id)) {
        hit = true
        break
      }
    }
    if (!hit) continue
    const seen = new Set<object>()
    walk(trace, rec => {
      if (rec.name !== 'fetch') return
      const duration = spanDurationMs(rec)
      if (duration !== null) fetchMs.push(duration)
    }, seen)
  }
  return fetchMs
}

/** All traffic on one version during a ramp step, not just the smoke ids. */
export function statsFromEvents(events: readonly unknown[], traces: readonly unknown[]): VersionStats {
  let requests = 0
  let exceptions = 0
  let errors = 0
  let fivexx = 0
  let logs = 0
  const wallMs: number[] = []
  const cpuMs: number[] = []
  for (const item of events) {
    const event = asRecord(item)
    if (!event) continue
    if (isLog(event)) {
      logs += 1
      const status = statusOf(event)
      if (status !== null && status >= 500) fivexx += 1
    }
    if (!isFetchInvocation(event)) continue
    requests += 1
    exceptions += exceptionCount(event)
    const workers = asRecord(event.$workers)
    if (workers?.outcome !== undefined && workers.outcome !== 'ok') errors += 1
    if (typeof workers?.wallTimeMs === 'number') wallMs.push(workers.wallTimeMs)
    if (typeof workers?.cpuTimeMs === 'number') cpuMs.push(workers.cpuTimeMs)
  }
  return {
    requests: requests > 0 ? requests : logs,
    exceptions,
    errors,
    fivexx,
    wallMs,
    cpuMs,
    fetchMs: fetchMsJoined(events, traces),
    v1: v1From(events),
  }
}

export type SmokeSummary = {
  readonly loggedBy: ReadonlyMap<string, ReadonlySet<string>>
  readonly health: { readonly nonOk: number; readonly fivexx: number; readonly errorLogs: number; readonly exceptions: number }
  readonly wallMs: readonly number[]
  readonly cpuMs: readonly number[]
  readonly fetchMs: readonly number[]
  readonly tracedIds: ReadonlySet<string>
}

/** Reduce a version's events and traces to the smoke-id view the gate judges. */
export function summarizeTelemetry(version: string, requests: readonly SmokeRequest[], events: readonly unknown[], traces: readonly unknown[]): SmokeSummary {
  const want = new Set(requests.map(request => request.id))
  const loggedBy = new Map<string, Set<string>>()
  const platformToSmoke = new Map<string, string>()
  let fivexx = 0
  let errorLogs = 0
  let nonOk = 0
  let exceptions = 0
  const smokePlatform = new Set<string>()
  for (const item of events) {
    const event = asRecord(item)
    if (!event) continue
    const saw = versionOf(event)
    if (isLog(event)) {
      const id = smokeIdOf(event)
      if (id && want.has(id)) {
        const versions = loggedBy.get(id) ?? new Set<string>()
        if (saw) versions.add(saw)
        loggedBy.set(id, versions)
        const platform = requestIdOf(event)
        if (platform && saw === version) {
          platformToSmoke.set(platform, id)
          smokePlatform.add(platform)
        }
      }
      if (saw === version) {
        const status = statusOf(event)
        if (status !== null && status >= 500) fivexx += 1
        const meta = asRecord(event.$metadata)
        if (meta?.level === 'error') errorLogs += 1
      }
    }
    if (saw !== version || !isFetchInvocation(event)) continue
    if (exceptionCount(event) > 0) exceptions += 1
    const workers = asRecord(event.$workers)
    if (workers?.outcome !== undefined && workers.outcome !== 'ok') nonOk += 1
  }
  const wallMs: number[] = []
  const cpuMs: number[] = []
  for (const item of events) {
    const event = asRecord(item)
    if (!event || versionOf(event) !== version || !isFetchInvocation(event)) continue
    const platform = requestIdOf(event)
    if (!platform || !smokePlatform.has(platform)) continue
    const workers = asRecord(event.$workers)
    if (typeof workers?.wallTimeMs === 'number') wallMs.push(workers.wallTimeMs)
    if (typeof workers?.cpuTimeMs === 'number') cpuMs.push(workers.cpuTimeMs)
  }
  const tracedIds = new Set<string>()
  const fetchMs: number[] = []
  for (const trace of traces) {
    const strings = new Set<string>()
    collectStrings(trace, strings, new Set())
    const matched = new Set<string>()
    for (const value of strings) {
      if (want.has(value)) matched.add(value)
      const smoke = platformToSmoke.get(value)
      if (smoke) matched.add(smoke)
    }
    if (matched.size === 0) continue
    for (const id of matched) tracedIds.add(id)
    const seen = new Set<object>()
    walk(trace, rec => {
      if (rec.name !== 'fetch') return
      const duration = spanDurationMs(rec)
      if (duration !== null) fetchMs.push(duration)
    }, seen)
  }
  return {
    loggedBy,
    health: { nonOk, fivexx, errorLogs, exceptions },
    wallMs,
    cpuMs,
    fetchMs,
    tracedIds,
  }
}

export type SmokeJudge = {
  readonly pass: boolean
  readonly failures: readonly TelemetryFailure[]
  readonly line: string
  readonly verdict: CanaryVerdict
}

function latencyFailures(
  metric: string,
  values: readonly number[],
  ceiling: LatencyCeiling,
): TelemetryFailure[] {
  const failures: TelemetryFailure[] = []
  const p50 = percentile(values, 0.5)
  const p99 = percentile(values, 0.99)
  if (p50 === null || p99 === null) {
    failures.push({ kind: 'missing', detail: `${metric} has no samples` })
    return failures
  }
  if (p50 > ceiling.p50Ms) failures.push({ kind: 'latency', metric, p: 'p50', value: p50, ceiling: ceiling.p50Ms })
  if (p99 > ceiling.p99Ms) failures.push({ kind: 'latency', metric, p: 'p99', value: p99, ceiling: ceiling.p99Ms })
  return failures
}

export function judgeSmokeTelemetry(input: {
  readonly version: string
  readonly requests: readonly SmokeRequest[]
  readonly summary: SmokeSummary
  readonly ceilings: { readonly cpuMs: LatencyCeiling; readonly wallMs: LatencyCeiling; readonly fetchMs: LatencyCeiling }
}): SmokeJudge {
  const { version, requests, summary, ceilings } = input
  const decided = verdict({
    version,
    requests: requests.map(request => ({ id: request.id, version: request.version, step: request.step })),
    loggedBy: summary.loggedBy,
    health: { nonOk: summary.health.nonOk, fivexx: summary.health.fivexx, errorLogs: summary.health.errorLogs },
  })
  const failures: TelemetryFailure[] = []
  for (const request of requests) {
    if (!request.expected.includes(request.status)) {
      failures.push({ kind: 'unexpected-status', id: request.id, status: request.status })
    }
  }
  if (summary.health.exceptions > 0) {
    failures.push({ kind: 'exception', detail: `${summary.health.exceptions} exceptions` })
  }
  if (summary.health.errorLogs > 0) failures.push({ kind: 'log-error', detail: `${summary.health.errorLogs} error logs` })
  if (decided.otherVersion.length > 0) {
    failures.push({ kind: 'other-version', detail: `${decided.otherVersion.length} logged by another version` })
  }
  if (requests.length === 0 || decided.matched === 0) {
    failures.push({ kind: 'missing', detail: requests.length === 0 ? 'smoke recorded no requests' : 'zero invocations matched the smoke' })
  } else {
    const missingTraces = requests.filter(request => !summary.tracedIds.has(request.id)).length
    const allowance = lossAllowance(requests.length)
    if (missingTraces > allowance) {
      failures.push({ kind: 'trace-count', detail: `${missingTraces} smoke requests have no trace, allowance ${allowance}` })
    }
    failures.push(...latencyFailures('wall', summary.wallMs, ceilings.wallMs))
    failures.push(...latencyFailures('cpu', summary.cpuMs, ceilings.cpuMs))
    failures.push(...latencyFailures('fetch', summary.fetchMs, ceilings.fetchMs))
  }
  if (decided.unconfirmed.length > 0 || decided.lost.length > decided.allowance) {
    failures.push({ kind: 'missing', detail: decided.reasons.join('; ') || 'smoke ids missing from telemetry' })
  }
  const pass = failures.length === 0 && decided.pass
  const line = pass ? decided.line : `${decided.line}${failures.length ? `; ${failures.map(failure => failure.kind).join(', ')}` : ''}`
  return { pass, failures, line, verdict: decided }
}

export function telemetryMarkdown(input: {
  readonly version: string
  readonly from: number
  readonly to: number
  readonly judge: SmokeJudge
  readonly summary: SmokeSummary
}): string {
  const { version, from, to, judge, summary } = input
  const lines = [
    `# Telemetry ${version}`,
    '',
    `Window ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}`,
    '',
    judge.line,
    '',
    `- invocations matched: ${judge.verdict.matched}/${judge.verdict.total} (loss allowance ${judge.verdict.allowance})`,
    `- non-ok ${summary.health.nonOk}, 5xx ${summary.health.fivexx}, error logs ${summary.health.errorLogs}, exceptions ${summary.health.exceptions}`,
    `- wall p50/p99 ${percentile(summary.wallMs, 0.5) ?? '-'} / ${percentile(summary.wallMs, 0.99) ?? '-'} ms`,
    `- cpu p50/p99 ${percentile(summary.cpuMs, 0.5) ?? '-'} / ${percentile(summary.cpuMs, 0.99) ?? '-'} ms`,
    `- fetch p50/p99 ${percentile(summary.fetchMs, 0.5) ?? '-'} / ${percentile(summary.fetchMs, 0.99) ?? '-'} ms`,
    `- traces for ${summary.tracedIds.size} smoke requests`,
  ]
  if (judge.failures.length) {
    lines.push('', '## Failures', '')
    for (const failure of judge.failures) lines.push(`- ${failure.kind}: ${'detail' in failure ? failure.detail : JSON.stringify(failure)}`)
  }
  return lines.join('\n') + '\n'
}
