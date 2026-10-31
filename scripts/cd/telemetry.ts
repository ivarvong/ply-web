import { lossAllowance, verdict, type CanaryVerdict } from '../canary-verdict.mjs'
import { CF_RAY_HEX_LENGTH, JOIN_MIN_LOGGED, JOIN_MIN_SHARE, QUERY_SLACK_MS, TELEMETRY_PAGE, type LatencyCeiling } from './baseline.ts'
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
  /** cf-ray of the smoke response. Span events join on this. Null when the response had none. */
  readonly ray: string | null
}

/** A telemetry query that threw. The type has no worker variant: a query failure is the harness. */
export type QueryFault = { readonly kind: 'harness_fault'; readonly reason: string }

export function queryFault(reason: string): QueryFault {
  return { kind: 'harness_fault', reason }
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

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function requestIdOf(event: Record<string, unknown>): string | null {
  const meta = asRecord(event.$metadata)
  return stringField(meta?.requestId) ?? stringField(event.requestId)
}

function traceIdOf(event: Record<string, unknown>): string | null {
  const meta = asRecord(event.$metadata)
  return stringField(event.traceId) ?? stringField(event.trace_id) ?? stringField(meta?.traceId) ?? stringField(meta?.trace_id)
}

function rayIdOf(event: Record<string, unknown>): string | null {
  const meta = asRecord(event.$metadata)
  return stringField(event.rayId) ?? stringField(event.ray_id) ?? stringField(meta?.rayId) ?? stringField(meta?.ray_id)
}

type JoinKey = {
  readonly requestId: string | null
  readonly traceId: string | null
  readonly rayId: string | null
}

function joinKeyOf(event: Record<string, unknown>): JoinKey {
  return { requestId: requestIdOf(event), traceId: traceIdOf(event), rayId: rayIdOf(event) }
}

/** The 16-hex body of a cf-ray, or null when `ray` is not that shape. */
function rayBody(ray: string): string | null {
  const dash = ray.indexOf('-')
  const body = dash === -1 ? ray : ray.slice(0, dash)
  if (body.length !== CF_RAY_HEX_LENGTH || !/^[0-9a-f]+$/i.test(body)) return null
  return body.toLowerCase()
}

function sameRay(left: string, right: string): boolean {
  if (left === right) return true
  const a = rayBody(left)
  const b = rayBody(right)
  return a !== null && a === b
}

type TraceMarks = {
  readonly rays: readonly string[]
  readonly traces: readonly string[]
  readonly strings: ReadonlySet<string>
}

function traceMarks(trace: unknown): TraceMarks {
  const rays: string[] = []
  const traces: string[] = []
  const strings = new Set<string>()
  walk(trace, rec => {
    const ray = rayIdOf(rec)
    const traceId = traceIdOf(rec)
    if (ray) rays.push(ray)
    if (traceId) traces.push(traceId)
    for (const value of Object.values(rec)) {
      if (typeof value === 'string' && value !== '') strings.add(value)
    }
  }, new Set())
  return { rays, traces, strings }
}

function rayHit(rays: readonly string[], want: string): boolean {
  for (const ray of rays) if (sameRay(ray, want)) return true
  return false
}

/**
 * Span events carry `rayId` and `traceId`. `$metadata.requestId` is null on those events,
 * so it is only a last resort for a span that still has one.
 */
function keysMatch(marks: TraceMarks, keys: readonly JoinKey[]): boolean {
  for (const key of keys) if (key.rayId && rayHit(marks.rays, key.rayId)) return true
  for (const key of keys) if (key.traceId && marks.traces.includes(key.traceId)) return true
  for (const key of keys) if (key.requestId && marks.strings.has(key.requestId)) return true
  return false
}

type SmokeKeys = {
  rays: string[]
  traces: string[]
  requestIds: string[]
}

function smokeKeys(): SmokeKeys {
  return { rays: [], traces: [], requestIds: [] }
}

function addKey(into: SmokeKeys, key: JoinKey): void {
  const rayId = key.rayId
  const traceId = key.traceId
  const requestId = key.requestId
  if (rayId && !into.rays.some(ray => sameRay(ray, rayId))) into.rays.push(rayId)
  if (traceId && !into.traces.includes(traceId)) into.traces.push(traceId)
  if (requestId && !into.requestIds.includes(requestId)) into.requestIds.push(requestId)
}

function smokeMatched(marks: TraceMarks, keysBySmoke: ReadonlyMap<string, SmokeKeys>, smokeIds: ReadonlySet<string>, platformToSmoke: ReadonlyMap<string, string>): Set<string> {
  const matched = new Set<string>()
  for (const [id, keys] of keysBySmoke) {
    if (keys.rays.some(ray => rayHit(marks.rays, ray))) matched.add(id)
  }
  if (matched.size > 0) return matched
  for (const [id, keys] of keysBySmoke) {
    if (keys.traces.some(traceId => marks.traces.includes(traceId))) matched.add(id)
  }
  if (matched.size > 0) return matched
  for (const value of marks.strings) {
    if (smokeIds.has(value)) matched.add(value)
    const smoke = platformToSmoke.get(value)
    if (smoke) matched.add(smoke)
  }
  return matched
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

/** Fetch spans have no script version. Join on rayId, then traceId, then a request id the span still carries. */
function fetchMsJoined(events: readonly unknown[], traces: readonly unknown[]): number[] {
  const keys: JoinKey[] = []
  for (const item of events) {
    const event = asRecord(item)
    if (!event) continue
    const key = joinKeyOf(event)
    if (key.requestId || key.traceId || key.rayId) keys.push(key)
  }
  const fetchMs: number[] = []
  for (const trace of traces) {
    if (!keysMatch(traceMarks(trace), keys)) continue
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
  /** Fetch invocations of this version in the window. The span join is compared with this. */
  readonly invocations: number
}

/** Reduce a version's events and traces to the smoke-id view the gate judges. */
export function summarizeTelemetry(version: string, requests: readonly SmokeRequest[], events: readonly unknown[], traces: readonly unknown[]): SmokeSummary {
  const want = new Set(requests.map(request => request.id))
  const loggedBy = new Map<string, Set<string>>()
  const platformToSmoke = new Map<string, string>()
  const keysBySmoke = new Map<string, SmokeKeys>()
  const keysFor = (id: string): SmokeKeys => {
    const existing = keysBySmoke.get(id)
    if (existing) return existing
    const created = smokeKeys()
    keysBySmoke.set(id, created)
    return created
  }
  for (const request of requests) {
    if (request.ray) keysFor(request.id).rays.push(request.ray)
  }
  let fivexx = 0
  let errorLogs = 0
  let nonOk = 0
  let exceptions = 0
  let invocations = 0
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
        addKey(keysFor(id), joinKeyOf(event))
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
    invocations += 1
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
  for (const item of events) {
    const event = asRecord(item)
    if (!event) continue
    const key = joinKeyOf(event)
    const requestId = key.requestId
    let smoke = requestId ? platformToSmoke.get(requestId) ?? null : null
    const rayId = key.rayId
    if (!smoke && rayId) {
      for (const [id, keys] of keysBySmoke) {
        if (keys.rays.some(ray => sameRay(ray, rayId))) {
          smoke = id
          break
        }
      }
    }
    if (smoke) addKey(keysFor(smoke), key)
  }
  const tracedIds = new Set<string>()
  const fetchMs: number[] = []
  for (const trace of traces) {
    const matched = smokeMatched(traceMarks(trace), keysBySmoke, want, platformToSmoke)
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
    invocations,
  }
}

/**
 * A join or query failure is `harness_fault` and has no worker label.
 * A version that answered badly is `worker`. Those two cannot be confused.
 */
export type SmokeJudge =
  | { readonly kind: 'pass'; readonly line: string; readonly failures: readonly []; readonly verdict: CanaryVerdict }
  | { readonly kind: 'worker'; readonly line: string; readonly failures: readonly TelemetryFailure[]; readonly verdict: CanaryVerdict }
  | { readonly kind: 'harness_fault'; readonly line: string; readonly reason: string; readonly verdict: CanaryVerdict }

/** Below half of the invocations the worker logged, the span join is the harness, not the version. */
export function implausibleJoin(input: { readonly smoke: number; readonly invocations: number; readonly joined: number }): boolean {
  const compared = Math.min(input.invocations, input.smoke)
  if (compared < JOIN_MIN_LOGGED) return false
  return input.joined / compared < JOIN_MIN_SHARE
}

function isVersionFault(failure: TelemetryFailure): boolean {
  switch (failure.kind) {
    case 'exception':
    case 'unexpected-status':
    case 'log-error':
    case 'other-version':
    case 'latency':
      return true
    case 'missing':
    case 'trace-count':
      return false
  }
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
  const line = failures.length === 0 && decided.pass
    ? decided.line
    : `${decided.line}${failures.length ? `; ${failures.map(failure => failure.kind).join(', ')}` : ''}`
  const versionFault = failures.some(isVersionFault) || summary.health.fivexx > 0 || summary.health.nonOk > 0
  let fromLogs = 0
  for (const request of requests) {
    if (summary.loggedBy.get(request.id)?.has(version)) fromLogs += 1
  }
  const joined = summary.tracedIds.size
  const join = { smoke: requests.length, invocations: Math.max(summary.invocations, fromLogs), joined }
  if (!versionFault && implausibleJoin(join)) {
    const compared = Math.min(join.invocations, join.smoke)
    const reason = `span join matched ${joined}/${compared} invocations the worker logged`
    return { kind: 'harness_fault', line: `telemetry: harness_fault: ${reason}`, reason, verdict: decided }
  }
  if (failures.length === 0 && decided.pass) return { kind: 'pass', failures: [], line, verdict: decided }
  return { kind: 'worker', failures, line, verdict: decided }
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
    `- traces for ${summary.tracedIds.size} smoke requests; ${summary.invocations} invocations logged by the worker`,
  ]
  if (judge.kind === 'harness_fault') {
    lines.push('', '## Harness fault', '', judge.reason)
  } else if (judge.failures.length) {
    lines.push('', '## Failures', '')
    for (const failure of judge.failures) lines.push(`- ${failure.kind}: ${'detail' in failure ? failure.detail : JSON.stringify(failure)}`)
  }
  return lines.join('\n') + '\n'
}
