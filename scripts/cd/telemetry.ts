import { atIndex, chainGet, fromNullable, mapGet, recordGet } from '../../src/absent.ts'
import { orElse, unwrapOr } from '../../src/option.ts'
import { verdict, type CanaryVerdict } from '../canary-verdict.mjs'
import { CF_RAY_HEX_LENGTH, JOIN_MIN_LOGGED, JOIN_MIN_SHARE, QUERY_SLACK_MS, TELEMETRY_PAGE, type LatencyCeiling } from './baseline.ts'
import { asRecord } from './json.ts'
import { DEFAULT_MAX_LOSS_RATE, type RolloutGates } from './policy.ts'
import type { V1Request } from './slo.ts'

/** One property. A null receiver, a missing key, and a null property are null. */
function field(value: unknown, key: string): unknown {
  return unwrapOr(chainGet(value, key), null)
}

/** Preferred value, or the fallback when preferred is null. 0 and '' stay. */
function coalesce(preferred: ReturnType<typeof chainGet>, fallback: unknown): unknown {
  return unwrapOr(orElse(preferred, fromNullable(fallback)), null)
}

/** First record that is present. Both absent is an empty record. */
function recordOrEmpty(first: Record<string, unknown> | null, second: Record<string, unknown> | null): Record<string, unknown> {
  if (first !== null) return first
  if (second !== null) return second
  return {}
}

/** First non-empty string. Null and '' fall through. */
function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const text = stringField(value)
    if (text !== null) return text
  }
  return null
}

/** A stored outcome other than ok, including a present null. A missing outcome is not a fault. */
function outcomeFailed(workers: Record<string, unknown> | null): boolean {
  const outcome = recordGet(workers, 'outcome')
  return outcome.tag === 'some' && outcome.value !== 'ok'
}

/**
 * An observed bad value. This union has no missing-sample or shape variant:
 * a check the harness could not evaluate cannot be stored as a worker fault.
 */
export type ObservedFault =
  | { readonly kind: 'exception'; readonly detail: string }
  | { readonly kind: 'unexpected-status'; readonly id: string; readonly status: number }
  | { readonly kind: 'log-error'; readonly detail: string }
  | { readonly kind: 'fivexx'; readonly detail: string }
  | { readonly kind: 'non-ok'; readonly detail: string }
  | { readonly kind: 'latency'; readonly metric: string; readonly p: 'p50' | 'p99'; readonly value: number; readonly ceiling: number }
  | { readonly kind: 'other-version'; readonly detail: string }

/** Missing data, a query-shape mismatch, or zero samples where samples are required. Not a worker fault. */
export type UnevaluableCheck =
  | { readonly kind: 'missing'; readonly detail: string }
  | { readonly kind: 'shape'; readonly detail: string }
  | { readonly kind: 'telemetry-loss'; readonly detail: string }
  | { readonly kind: 'join'; readonly detail: string }

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
  offset: string | null,
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

/** Child spans. The traces view does not return them; this events filter does. */
export function spanTypeFilter(): Filter {
  return { key: '$metadata.type', operation: 'eq', type: 'string', value: 'span' }
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
  const last = asRecord(unwrapOr(atIndex(page, page.length - 1), null))
  const meta = asRecord(field(last, '$metadata'))
  const id = field(meta, 'id')
  return typeof id === 'string' && id !== '' ? id : null
}

/** Same percentile as scripts/canary-o11y.mjs: sorted[floor((n - 1) * p)], null when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return unwrapOr(atIndex(sorted, Math.floor((sorted.length - 1) * p)), null)
}

/** Percentile text. An empty series prints `-`; 0 prints `0`. */
function percentileLabel(values: readonly number[], p: number): string {
  const value = percentile(values, p)
  return value === null ? '-' : `${value}`
}

/** Duration in milliseconds. `durationMS` is already milliseconds. A bare `duration` above 1e6 is nanoseconds. */
export function spanDurationMs(span: Record<string, unknown>): number | null {
  const source = asRecord(span.source)
  const attrs = recordOrEmpty(asRecord(span.attributes), asRecord(span.attrs))
  const millis = [
    span.durationMs, span.durationMS, span.duration_ms,
    field(source, 'durationMs'), field(source, 'durationMS'), field(source, 'duration_ms'),
    attrs.duration_ms, attrs.durationMs, attrs.durationMS,
  ]
  for (const candidate of millis) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate
  }
  const raw = typeof span.duration === 'number' ? span.duration : coalesce(chainGet(source, 'duration'), attrs.duration)
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  return raw > 1_000_000 ? raw / 1_000_000 : raw
}

/** One traces-view row: a span count and a root name, and no child spans. */
export function isTraceSummary(row: Record<string, unknown>): boolean {
  return typeof row.spans === 'number' && typeof row.rootSpanName === 'string' && typeof row.traceId === 'string'
}

const ARTIFACTS_FETCH_SUFFIXES = ['/git-upload-pack', '/git-receive-pack', '/info/refs'] as const

export function isArtifactsFetchPath(path: string): boolean {
  return ARTIFACTS_FETCH_SUFFIXES.some(suffix => path.endsWith(suffix))
}

export type FetchSample = {
  readonly durationMs: number
  readonly path: string
  readonly status: number | null
  readonly version: string | null
  readonly traceId: string | null
  readonly rayId: string | null
  readonly artifacts: boolean
}

function spanNameOf(event: Record<string, unknown>): string | null {
  const source = asRecord(event.source)
  const meta = asRecord(event.$metadata)
  return firstString(field(source, 'name'), field(meta, 'spanName'), event.name)
}

function urlPathOf(event: Record<string, unknown>): string | null {
  const source = asRecord(event.source)
  const url = coalesce(chainGet(source, 'url'), event.url)
  if (typeof url === 'string' && url !== '') return url
  const rec = asRecord(url)
  return firstString(field(rec, 'path'), field(rec, 'full'))
}

function httpStatusOf(event: Record<string, unknown>): number | null {
  const source = asRecord(event.source)
  const http = asRecord(field(source, 'http'))
  const response = asRecord(field(http, 'response'))
  const status = coalesce(chainGet(response, 'status_code'), field(response, 'statusCode'))
  return typeof status === 'number' ? status : null
}

function scriptVersionOf(event: Record<string, unknown>): string | null {
  const source = asRecord(event.source)
  const cloudflare = asRecord(field(source, 'cloudflare'))
  const script = asRecord(field(cloudflare, 'script_version'))
  const id = field(script, 'id')
  if (typeof id === 'string' && id !== '') return id
  const faas = asRecord(field(source, 'faas'))
  const version = field(faas, 'version')
  return typeof version === 'string' && version !== '' ? version : null
}

/** An outbound `fetch` span. Trace summaries and root spans (GET, POST, DELETE) are not samples. */
export function fetchSample(event: unknown): FetchSample | null {
  const rec = asRecord(event)
  if (!rec || isTraceSummary(rec)) return null
  if (spanNameOf(rec) !== 'fetch') return null
  const durationMs = spanDurationMs(rec)
  if (durationMs === null) return null
  const found = urlPathOf(rec)
  const path = found === null ? '' : found
  return {
    durationMs,
    path,
    status: httpStatusOf(rec),
    version: scriptVersionOf(rec),
    traceId: traceIdOf(rec),
    rayId: rayIdOf(rec),
    artifacts: isArtifactsFetchPath(path),
  }
}

function versionOf(event: Record<string, unknown>): string | null {
  const workers = asRecord(event.$workers)
  const script = asRecord(field(workers, 'scriptVersion'))
  const id = field(script, 'id')
  return typeof id === 'string' ? id : null
}

/** `$workers.scriptVersion.id` on a telemetry event, or null. The ramp partitions one query with this. */
export function scriptVersionId(event: unknown): string | null {
  const rec = asRecord(event)
  return rec ? versionOf(rec) : null
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function requestIdOf(event: Record<string, unknown>): string | null {
  const meta = asRecord(event.$metadata)
  return firstString(field(meta, 'requestId'), event.requestId)
}

function traceIdOf(event: Record<string, unknown>): string | null {
  const meta = asRecord(event.$metadata)
  return firstString(event.traceId, event.trace_id, field(meta, 'traceId'), field(meta, 'trace_id'))
}

function rayIdOf(event: Record<string, unknown>): string | null {
  const meta = asRecord(event.$metadata)
  return firstString(event.rayId, event.ray_id, field(meta, 'rayId'), field(meta, 'ray_id'))
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
  return field(source, 'msg') === 'ply.request' || event.msg === 'ply.request'
}

function smokeIdOf(event: Record<string, unknown>): string | null {
  const source = asRecord(event.source)
  const id = field(source, 'id')
  if (typeof id === 'string') return id
  return typeof event.id === 'string' ? event.id : null
}

function statusOf(event: Record<string, unknown>): number | null {
  const source = asRecord(event.source)
  const status = coalesce(chainGet(source, 'status'), event.status)
  return typeof status === 'number' ? status : null
}

/** Workers names the internet-facing fetch handler this. A missing entrypoint is that handler. */
export const DEFAULT_ENTRYPOINT = 'default'

const FETCH_EVENT = 'cf-worker-event'
const FETCH_TYPE = 'fetch'
const fetchBrand = Symbol('FetchInvocation')

/**
 * A fetch handler invocation. `external` is the default entrypoint, the traffic
 * the ramp routes. `internal` is a named entrypoint (`FlagsCache`, `GitCache`):
 * `ctx.exports` calls it, and it carries its own ray and request id.
 */
export type FetchInvocation =
  | { readonly [fetchBrand]: 'FetchInvocation'; readonly kind: 'external' }
  | { readonly [fetchBrand]: 'FetchInvocation'; readonly kind: 'internal'; readonly entrypoint: string }

/** Null when the event is not a fetch invocation. */
export function fetchInvocation(event: Record<string, unknown>): FetchInvocation | null {
  const meta = asRecord(event.$metadata)
  const workers = asRecord(event.$workers)
  if (workers === null || field(meta, 'type') !== FETCH_EVENT || field(workers, 'eventType') !== FETCH_TYPE) return null
  const entrypoint = workers.entrypoint
  if (typeof entrypoint !== 'string' || entrypoint === '' || entrypoint === DEFAULT_ENTRYPOINT) {
    return { [fetchBrand]: 'FetchInvocation', kind: 'external' }
  }
  return { [fetchBrand]: 'FetchInvocation', kind: 'internal', entrypoint }
}

function isExternalFetch(event: Record<string, unknown>): boolean {
  const invocation = fetchInvocation(event)
  return invocation !== null && invocation.kind === 'external'
}

function exceptionCount(event: Record<string, unknown>): number {
  const workers = asRecord(event.$workers)
  const exceptions = field(workers, 'exceptions')
  if (Array.isArray(exceptions) && exceptions.length > 0) return exceptions.length
  if (field(workers, 'outcome') === 'exception') return 1
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

/** Named-entrypoint fetches on one version. Recorded, never gated. */
export type InternalEntrypoint = {
  readonly entrypoint: string
  readonly count: number
}

export type VersionStats = {
  readonly requests: number
  /** External fetch invocations. `requests` falls back to log rows when this is 0. Named entrypoints are `internal`. */
  readonly invocations: number
  readonly exceptions: number
  readonly errors: number
  readonly fivexx: number
  readonly errorLogs: number
  readonly wallMs: readonly number[]
  readonly cpuMs: readonly number[]
  readonly fetchMs: readonly number[]
  readonly v1: readonly V1Request[]
  readonly internal: readonly InternalEntrypoint[]
}

function internalCounts(counts: ReadonlyMap<string, number>): InternalEntrypoint[] {
  return [...counts.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([entrypoint, count]) => ({ entrypoint, count }))
}

function methodOf(event: Record<string, unknown>): V1Request['method'] {
  const source = asRecord(event.source)
  const method = coalesce(chainGet(source, 'method'), event.method)
  if (method === 'GET' || method === 'POST') return method
  return 'OTHER'
}

function pathOf(event: Record<string, unknown>): string | null {
  const source = asRecord(event.source)
  const path = coalesce(chainGet(source, 'path'), event.path)
  if (typeof path !== 'string' || path === '') return null
  const bare = path.split('?')[0]
  return bare || null
}

function v1From(events: readonly unknown[]): V1Request[] {
  const invocations = new Map<string, { wall: number | null; exception: boolean }>()
  for (const item of events) {
    const event = asRecord(item)
    if (!event || !isExternalFetch(event)) continue
    const id = requestIdOf(event)
    if (!id) continue
    const workers = asRecord(event.$workers)
    const wallTime = field(workers, 'wallTimeMs')
    invocations.set(id, {
      wall: typeof wallTime === 'number' ? wallTime : null,
      exception: exceptionCount(event) > 0,
    })
  }
  const out: V1Request[] = []
  for (const item of events) {
    const event = asRecord(item)
    if (!event || !isLog(event)) continue
    const path = pathOf(event)
    if (!path || (path !== '/v1' && !path.startsWith('/v1/'))) continue
    const loggedStatus = statusOf(event)
    const status = loggedStatus === null ? 0 : loggedStatus
    const id = requestIdOf(event)
    const linked = id ? unwrapOr(mapGet(invocations, id), null) : null
    const source = asRecord(event.source)
    const logged = field(source, 'ms')
    const loggedMs = typeof logged === 'number' ? logged : null
    out.push({
      method: methodOf(event),
      path,
      status,
      exception: linked === null ? false : linked.exception,
      wallMs: linked !== null && linked.wall !== null ? linked.wall : loggedMs,
      expected4xx: status >= 400 && status < 500,
    })
  }
  return out
}

/** Fetch spans have no `$workers.scriptVersion.id`. Join on rayId, then traceId, then a request id the span still carries. */
function fetchMsJoined(events: readonly unknown[], spans: readonly unknown[]): number[] {
  const keys: JoinKey[] = []
  for (const item of events) {
    const event = asRecord(item)
    if (!event) continue
    const invocation = fetchInvocation(event)
    if (invocation !== null && invocation.kind === 'internal') continue
    const key = joinKeyOf(event)
    if (key.requestId || key.traceId || key.rayId) keys.push(key)
  }
  const fetchMs: number[] = []
  for (const span of spans) {
    if (!keysMatch(traceMarks(span), keys)) continue
    const sample = fetchSample(span)
    if (sample) fetchMs.push(sample.durationMs)
  }
  return fetchMs
}

/** All traffic on one version during a ramp step, not just the smoke ids. `spans` are child span events, not traces-view rows. */
export function statsFromEvents(events: readonly unknown[], spans: readonly unknown[]): VersionStats {
  let requests = 0
  let exceptions = 0
  let errors = 0
  let fivexx = 0
  let errorLogs = 0
  let logs = 0
  const wallMs: number[] = []
  const cpuMs: number[] = []
  const internal = new Map<string, number>()
  for (const item of events) {
    const event = asRecord(item)
    if (!event) continue
    if (isLog(event)) {
      logs += 1
      const status = statusOf(event)
      if (status !== null && status >= 500) fivexx += 1
      const meta = asRecord(event.$metadata)
      if (field(meta, 'level') === 'error') errorLogs += 1
    }
    const fetch = fetchInvocation(event)
    if (!fetch) continue
    if (fetch.kind === 'internal') {
      internal.set(fetch.entrypoint, unwrapOr(mapGet(internal, fetch.entrypoint), 0) + 1)
      continue
    }
    requests += 1
    exceptions += exceptionCount(event)
    const workers = asRecord(event.$workers)
    if (outcomeFailed(workers)) errors += 1
    const wall = field(workers, 'wallTimeMs')
    if (typeof wall === 'number') wallMs.push(wall)
    const cpu = field(workers, 'cpuTimeMs')
    if (typeof cpu === 'number') cpuMs.push(cpu)
  }
  return {
    requests: requests > 0 ? requests : logs,
    invocations: requests,
    exceptions,
    errors,
    fivexx,
    errorLogs,
    wallMs,
    cpuMs,
    fetchMs: fetchMsJoined(events, spans),
    v1: v1From(events),
    internal: internalCounts(internal),
  }
}

export type SmokeSummary = {
  readonly loggedBy: ReadonlyMap<string, ReadonlySet<string>>
  readonly health: { readonly nonOk: number; readonly fivexx: number; readonly errorLogs: number; readonly exceptions: number }
  readonly wallMs: readonly number[]
  readonly cpuMs: readonly number[]
  readonly fetchMs: readonly number[]
  readonly tracedIds: ReadonlySet<string>
  /** External fetch invocations of this version in the window. The span join is compared with this. */
  readonly invocations: number
  /**
   * `events` is a child-span query. `summaries` is the traces view (a count and a root name).
   * `empty` means the span query returned nothing.
   */
  readonly spanShape: 'events' | 'summaries' | 'empty'
}

/**
 * Reduce a version's logs, traces-view rows, and child span events to the smoke-id view the gate judges.
 * `spans` defaults to `traces` so a caller that already holds span events can pass them once.
 * A traces-view row is not a child span: it cannot supply a fetch duration.
 */
export function summarizeTelemetry(
  version: string,
  requests: readonly SmokeRequest[],
  events: readonly unknown[],
  traces: readonly unknown[],
  spans: readonly unknown[] = traces,
): SmokeSummary {
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
        const versions = unwrapOr(mapGet(loggedBy, id), new Set<string>())
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
        if (field(meta, 'level') === 'error') errorLogs += 1
      }
    }
    if (saw !== version || !isExternalFetch(event)) continue
    invocations += 1
    if (exceptionCount(event) > 0) exceptions += 1
    const workers = asRecord(event.$workers)
    if (outcomeFailed(workers)) nonOk += 1
  }
  const wallMs: number[] = []
  const cpuMs: number[] = []
  for (const item of events) {
    const event = asRecord(item)
    if (!event || versionOf(event) !== version || !isExternalFetch(event)) continue
    const platform = requestIdOf(event)
    if (!platform || !smokePlatform.has(platform)) continue
    const workers = asRecord(event.$workers)
    const wall = field(workers, 'wallTimeMs')
    if (typeof wall === 'number') wallMs.push(wall)
    const cpu = field(workers, 'cpuTimeMs')
    if (typeof cpu === 'number') cpuMs.push(cpu)
  }
  for (const item of events) {
    const event = asRecord(item)
    if (!event) continue
    const key = joinKeyOf(event)
    const requestId = key.requestId
    let smoke = requestId ? unwrapOr(mapGet(platformToSmoke, requestId), null) : null
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
  for (const trace of traces) {
    const matched = smokeMatched(traceMarks(trace), keysBySmoke, want, platformToSmoke)
    for (const id of matched) tracedIds.add(id)
  }
  let summaries = 0
  let spanEvents = 0
  const fetchMs: number[] = []
  for (const span of spans) {
    const rec = asRecord(span)
    if (!rec) continue
    if (isTraceSummary(rec)) {
      summaries += 1
      const matched = smokeMatched(traceMarks(rec), keysBySmoke, want, platformToSmoke)
      for (const id of matched) tracedIds.add(id)
      continue
    }
    spanEvents += 1
    const matched = smokeMatched(traceMarks(rec), keysBySmoke, want, platformToSmoke)
    if (matched.size === 0) continue
    for (const id of matched) tracedIds.add(id)
    const sample = fetchSample(rec)
    if (sample) fetchMs.push(sample.durationMs)
  }
  const spanShape = spanEvents > 0 ? 'events' as const : summaries > 0 ? 'summaries' as const : 'empty' as const
  return {
    loggedBy,
    health: { nonOk, fivexx, errorLogs, exceptions },
    wallMs,
    cpuMs,
    fetchMs,
    tracedIds,
    invocations,
    spanShape,
  }
}

/**
 * A join or query failure is `harness_fault` and has no worker label.
 * A version that answered badly is `worker`. Those two cannot be confused.
 */
export type SmokeJudge =
  | { readonly kind: 'pass'; readonly line: string; readonly failures: readonly []; readonly verdict: CanaryVerdict }
  | { readonly kind: 'worker'; readonly line: string; readonly failures: readonly ObservedFault[]; readonly verdict: CanaryVerdict }
  | { readonly kind: 'harness_fault'; readonly line: string; readonly reason: string; readonly checks: readonly UnevaluableCheck[]; readonly verdict: CanaryVerdict }

function faultIsHard(fault: ObservedFault, gates: RolloutGates): boolean {
  switch (fault.kind) {
    case 'exception':
      return gates.exceptions === 'hard'
    case 'fivexx':
      return gates.fivexx === 'hard'
    case 'log-error':
      return gates.errorLogs === 'hard'
    case 'non-ok':
      return gates.nonOk === 'hard'
    case 'latency':
      return gates.latency.mode === 'gate'
    case 'unexpected-status':
    case 'other-version':
      return gates.smoke === 'hard'
  }
}

function latencyGap(check: UnevaluableCheck): boolean {
  return check.kind === 'missing' && /^(wall|cpu|fetch) has no samples$/.test(check.detail)
}

function faultText(fault: ObservedFault): string {
  if (fault.kind === 'unexpected-status') return `unexpected-status ${fault.id} ${fault.status}`
  if (fault.kind === 'latency') return `latency ${fault.metric} ${fault.p} ${fault.value} > ${fault.ceiling}`
  return `${fault.kind}: ${fault.detail}`
}

/**
 * Drop signals the policy does not treat as hard. A latency series with no samples
 * is a harness fault only when latency mode is `gate`.
 */
export function applyGates(judge: SmokeJudge, gates: RolloutGates): SmokeJudge {
  if (judge.kind === 'harness_fault') {
    if (gates.latency.mode === 'gate') return judge
    const checks = judge.checks.filter(check => !latencyGap(check))
    if (checks.length === judge.checks.length) return judge
    if (checks.length > 0) {
      const reason = checks.map(check => `${check.kind}: ${check.detail}`).join('; ')
      return { kind: 'harness_fault', line: `telemetry: harness_fault: ${reason}`, reason, checks, verdict: judge.verdict }
    }
    return { kind: 'pass', failures: [], line: `${judge.verdict.line} latency=${gates.latency.mode}`, verdict: judge.verdict }
  }
  if (judge.kind !== 'worker') return judge
  const kept = judge.failures.filter(fault => faultIsHard(fault, gates))
  const dropped = judge.failures.filter(fault => !faultIsHard(fault, gates))
  if (dropped.length === 0) return judge
  if (kept.length > 0) return { kind: 'worker', failures: kept, line: judge.line, verdict: judge.verdict }
  return {
    kind: 'pass',
    failures: [],
    line: `${judge.verdict.line} informational: ${dropped.map(faultText).join('; ')}`,
    verdict: judge.verdict,
  }
}

/** Below half of the invocations the worker logged, the span join is the harness, not the version. */
export function implausibleJoin(input: { readonly smoke: number; readonly invocations: number; readonly joined: number }): boolean {
  const compared = Math.min(input.invocations, input.smoke)
  if (compared < JOIN_MIN_LOGGED) return false
  return input.joined / compared < JOIN_MIN_SHARE
}

function latencyChecks(
  metric: string,
  values: readonly number[],
  ceiling: LatencyCeiling,
): readonly (ObservedFault | UnevaluableCheck)[] {
  const p50 = percentile(values, 0.5)
  const p99 = percentile(values, 0.99)
  if (p50 === null || p99 === null) return [{ kind: 'missing', detail: `${metric} has no samples` }]
  const failures: ObservedFault[] = []
  if (p50 > ceiling.p50Ms) failures.push({ kind: 'latency', metric, p: 'p50', value: p50, ceiling: ceiling.p50Ms })
  if (p99 > ceiling.p99Ms) failures.push({ kind: 'latency', metric, p: 'p99', value: p99, ceiling: ceiling.p99Ms })
  return failures
}

function isObserved(check: ObservedFault | UnevaluableCheck): check is ObservedFault {
  switch (check.kind) {
    case 'exception':
    case 'unexpected-status':
    case 'log-error':
    case 'fivexx':
    case 'non-ok':
    case 'latency':
    case 'other-version':
      return true
    case 'missing':
    case 'shape':
    case 'telemetry-loss':
    case 'join':
      return false
  }
}

/** One smoke id telemetry did not return: no ply.request log from any version, no trace, or both. */
export type LostId = { readonly id: string; readonly step: string; readonly log: boolean; readonly trace: boolean }

/** Informational loss metric. `rate` is `ids.length / total`; zero when there were no smoke requests. */
export type TelemetryLoss = {
  readonly total: number
  readonly count: number
  readonly rate: number
  readonly maxLossRate: number
  readonly exceeded: boolean
  readonly ids: readonly LostId[]
}

/**
 * Smoke ids missing from telemetry. A request logged by another version is a routing fault, not loss,
 * and is not counted here.
 */
export function telemetryLoss(
  requests: readonly SmokeRequest[],
  summary: Pick<SmokeSummary, 'loggedBy' | 'tracedIds'>,
  maxLossRate: number,
): TelemetryLoss {
  const ids: LostId[] = []
  const counted = new Set<string>()
  for (const request of requests) {
    if (counted.has(request.id)) continue
    counted.add(request.id)
    const logged = mapGet(summary.loggedBy, request.id)
    const log = (logged.tag === 'some' ? logged.value.size : 0) === 0
    const trace = !summary.tracedIds.has(request.id)
    if (log || trace) ids.push({ id: request.id, step: request.step, log, trace })
  }
  const total = counted.size
  const rate = total === 0 ? 0 : ids.length / total
  return { total, count: ids.length, rate, maxLossRate, exceeded: rate > maxLossRate, ids }
}

export function lossLine(loss: TelemetryLoss): string {
  return `telemetry loss ${loss.count}/${loss.total} (${(loss.rate * 100).toFixed(1)}%, max ${(loss.maxLossRate * 100).toFixed(1)}%)`
}

export function judgeSmokeTelemetry(input: {
  readonly version: string
  readonly requests: readonly SmokeRequest[]
  readonly summary: SmokeSummary
  readonly ceilings: { readonly cpuMs: LatencyCeiling; readonly wallMs: LatencyCeiling; readonly fetchMs: LatencyCeiling }
  /** Policy `telemetry.maxLossRate`. Null uses the default. Loss at or below it is informational. */
  readonly maxLossRate: number | null
}): SmokeJudge {
  const { version, requests, summary, ceilings } = input
  const maxLossRate = input.maxLossRate === null ? DEFAULT_MAX_LOSS_RATE : input.maxLossRate
  const loss = telemetryLoss(requests, summary, maxLossRate)
  const decided = verdict({
    version,
    requests: requests.map(request => ({ id: request.id, version: request.version, step: request.step })),
    loggedBy: summary.loggedBy,
    health: { nonOk: summary.health.nonOk, fivexx: summary.health.fivexx, errorLogs: summary.health.errorLogs },
  })
  const checks: (ObservedFault | UnevaluableCheck)[] = []
  for (const request of requests) {
    if (!request.expected.includes(request.status)) {
      checks.push({ kind: 'unexpected-status', id: request.id, status: request.status })
    }
  }
  if (summary.health.exceptions > 0) checks.push({ kind: 'exception', detail: `${summary.health.exceptions} exceptions` })
  if (summary.health.fivexx > 0) checks.push({ kind: 'fivexx', detail: `${summary.health.fivexx} 5xx logs` })
  if (summary.health.nonOk > 0) checks.push({ kind: 'non-ok', detail: `${summary.health.nonOk} non-ok outcomes` })
  if (summary.health.errorLogs > 0) checks.push({ kind: 'log-error', detail: `${summary.health.errorLogs} error logs` })
  if (decided.otherVersion.length > 0) {
    checks.push({ kind: 'other-version', detail: `${decided.otherVersion.length} logged by another version` })
  }
  if (requests.length === 0 || decided.matched === 0) {
    checks.push({ kind: 'missing', detail: requests.length === 0 ? 'smoke recorded no requests' : 'zero invocations matched the smoke' })
  } else {
    if (loss.exceeded) checks.push({ kind: 'telemetry-loss', detail: lossLine(loss) })
    checks.push(...latencyChecks('wall', summary.wallMs, ceilings.wallMs))
    checks.push(...latencyChecks('cpu', summary.cpuMs, ceilings.cpuMs))
    if (summary.spanShape === 'summaries') {
      checks.push({ kind: 'shape', detail: 'span query returned trace summaries with no child spans' })
    } else {
      checks.push(...latencyChecks('fetch', summary.fetchMs, ceilings.fetchMs))
    }
  }
  // Lost ids are counted by `loss`. An id no response proved the version for still cannot be judged.
  if (decided.unconfirmed.length > 0) {
    checks.push({ kind: 'missing', detail: `${decided.unconfirmed.length} lost without x-ply-version ${version} recorded by the smoke` })
  }
  const observed = checks.filter(isObserved)
  const unevaluable = checks.filter((check): check is UnevaluableCheck => !isObserved(check))
  const line = checks.length === 0 && decided.pass
    ? decided.line
    : `${decided.line}${checks.length ? `; ${checks.map(check => check.kind).join(', ')}` : ''}`
  let fromLogs = 0
  for (const request of requests) {
    const logged = mapGet(summary.loggedBy, request.id)
    if (logged.tag === 'some' && logged.value.has(version)) fromLogs += 1
  }
  const joined = summary.tracedIds.size
  const join = { smoke: requests.length, invocations: Math.max(summary.invocations, fromLogs), joined }
  if (observed.length > 0) return { kind: 'worker', failures: observed, line, verdict: decided }
  if (implausibleJoin(join)) {
    const compared = Math.min(join.invocations, join.smoke)
    const reason = `span join matched ${joined}/${compared} invocations the worker logged`
    return {
      kind: 'harness_fault',
      line: `telemetry: harness_fault: ${reason}`,
      reason,
      checks: [{ kind: 'join', detail: reason }, ...unevaluable],
      verdict: decided,
    }
  }
  // `decided.pass` also fails on lost > allowance. That is loss, judged above against maxLossRate.
  const decidedFault = decided.otherVersion.length > 0 || decided.unconfirmed.length > 0
  if (unevaluable.length > 0 || decidedFault) {
    const reason = unevaluable.map(check => `${check.kind}: ${check.detail}`).join('; ') || decided.line
    return { kind: 'harness_fault', line: `telemetry: harness_fault: ${reason}`, reason, checks: unevaluable, verdict: decided }
  }
  return { kind: 'pass', failures: [], line: loss.count > 0 ? `${line}; ${lossLine(loss)} informational` : line, verdict: decided }
}

export function telemetryMarkdown(input: {
  readonly version: string
  readonly from: number
  readonly to: number
  readonly judge: SmokeJudge
  readonly summary: SmokeSummary
  readonly loss: TelemetryLoss
}): string {
  const { version, from, to, judge, summary, loss } = input
  const lines = [
    `# Telemetry ${version}`,
    '',
    `Window ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}`,
    '',
    judge.line,
    '',
    `- invocations matched: ${judge.verdict.matched}/${judge.verdict.total}`,
    `- ${lossLine(loss)}${loss.exceeded ? ' EXCEEDED' : ' informational'}`,
    `- non-ok ${summary.health.nonOk}, 5xx ${summary.health.fivexx}, error logs ${summary.health.errorLogs}, exceptions ${summary.health.exceptions}`,
    `- wall p50/p99 ${percentileLabel(summary.wallMs, 0.5)} / ${percentileLabel(summary.wallMs, 0.99)} ms`,
    `- cpu p50/p99 ${percentileLabel(summary.cpuMs, 0.5)} / ${percentileLabel(summary.cpuMs, 0.99)} ms`,
    `- fetch p50/p99 ${percentileLabel(summary.fetchMs, 0.5)} / ${percentileLabel(summary.fetchMs, 0.99)} ms`,
    `- traces for ${summary.tracedIds.size} smoke requests; ${summary.invocations} invocations logged by the worker`,
  ]
  if (loss.count > 0) {
    lines.push('', '## Telemetry loss', '', '| id | step | log | trace |', '| --- | --- | --- | --- |')
    for (const lost of loss.ids) lines.push(`| ${lost.id} | ${lost.step} | ${lost.log ? 'missing' : 'ok'} | ${lost.trace ? 'missing' : 'ok'} |`)
  }
  if (judge.kind === 'harness_fault') {
    lines.push('', '## Harness fault', '', judge.reason)
  } else if (judge.failures.length) {
    lines.push('', '## Failures', '')
    for (const failure of judge.failures) lines.push(`- ${failure.kind}: ${'detail' in failure ? failure.detail : JSON.stringify(failure)}`)
  }
  return lines.join('\n') + '\n'
}
