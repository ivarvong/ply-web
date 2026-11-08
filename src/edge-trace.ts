// ply's spans in Workers tracing (Workers Observability), live, nested under the request span as ply nests them.
//
// ply records every span on its own Tracer (ply-web keeps the ended spans of a request, `spanList()`; src/rays.ts,
// ?trace=1 and the viewer's trace read them). Nothing there reaches
// the platform. Workers Observability shows a custom span only when the Worker opens it on `ctx.tracing`, the runtime's
// user-tracing API (.cloudflare/types/index.d.ts `interface Tracing`, workerd `workerd::api::Tracing`): a span opened
// there is a child of the span active in the current async context (the request span when none is), its start and end
// are the runtime's clock, and `end()` closes it.
//
// `plyTracer(ctx, options)` is the one Tracer the /v1 API (src/index.js) and the viewer (src/viewer/app.tsx) construct.
// With `ctx.tracing` it mirrors each ply span onto a platform span when ply opens it, and closes that span with ply's
// attributes, status, and ids when ply ends it: ply hands over the ended span as plain values (Tracer `onEnd`, an
// EndedSpan; no OTLP is built), and the platform span takes all of ply's attributes in one `setAttributes` call and the
// stamp, ids and duration in a second. (Until 2026-11-06 this rebuilt an OTLP document per span, flattened it back and
// made one setAttribute call per attribute: about 7% of the Worker's CPU on 59f39490.) Parentage is ply's, not whatever happens to be active: each platform span
// is opened with `startActiveSpan`, and the async context inside that callback (where it is the active span) is kept with
// `AsyncLocalStorage.snapshot()`. A ply child is opened inside its parent's snapshot, so the runtime makes it that span's
// child. A ply root (`git.edit`, a bare wire span) is opened in the caller's context: a child of the request span. A span
// that follows another (`git.read.blob` after `git.read`) nests under it while it is open.
// Without `ctx.tracing` (node tests, a runtime without user tracing) it is ply's plain Tracer.
import { AsyncLocalStorage } from 'node:async_hooks'
import { Tracer } from 'ply'
import type { EndedSpan, SpanSink } from 'ply'
import { chainGet } from './absent.ts'

type PlySpan = ReturnType<Tracer['start']>
type TracerOptions = ConstructorParameters<typeof Tracer>[0]
type StartOptions = Parameters<Tracer['start']>[1]

/** Attribute values the platform span takes. */
type EdgeValue = string | number | boolean
type EdgeAttrs = Readonly<Record<string, EdgeValue>>

/**
 * The platform span: what `ctx.tracing.startActiveSpan` hands its callback. The runtime's span also has
 * `setAttributes(record)` (one call for many attributes); closeEdge uses it when it is there.
 */
export type EdgeSpan = {
  setAttribute(key: string, value: EdgeValue): unknown
  setStatus(status: { code: 'ok' | 'error'; message: string }): unknown
  end(): void
}

/** `ctx.tracing`, the one method this module calls. */
export type EdgeTracing = {
  startActiveSpan<T>(name: string, fn: (span: EdgeSpan) => T): T
}

/** Attribute keys this module adds beside ply's own. */
export const EDGE_ATTR = {
  spanId: 'ply.span_id',
  traceId: 'ply.trace_id',
  parentSpanId: 'ply.parent_span_id',
  followsSpanId: 'ply.follows_span_id',
  durationMs: 'ply.duration_ms',
  /** The route the span ran under (`GET /v1/tree`, `viewer`): telemetry groups input distributions by it (#73). */
  route: 'ply.route',
  /** The Workers version id (`env.VERSION.id`), so a distribution is per version without a join to the request span. */
  version: 'ply.script_version',
} as const

/**
 * Attribute keys stamped on the request span (the runtime's root span for the invocation). With the route and version
 * these are the per-request inputs scripts/calibrate reads: outcome, error, and the shape of the ply work it did.
 */
export const REQUEST_ATTR = {
  route: EDGE_ATTR.route,
  version: EDGE_ATTR.version,
  surface: 'ply.surface',
  status: 'http.response.status_code',
  errorCode: 'ply.error.code',
  errorKind: 'ply.error.kind',
  spans: 'ply.spans',
  roundTrips: 'ply.round_trips',
  wide: 'ply.wide_fetches',
  cacheHits: 'ply.cache_hits',
  cacheMisses: 'ply.cache_misses',
} as const

/** Attributes every platform span of one request carries beside ply's own. */
export type EdgeStamp = Readonly<Record<string, string | number | boolean>>

const OTLP_ERROR = 2
const FOLLOWS_FROM = 'follows_from'

/** `ctx.tracing` when it can open a span, else null. A missing context is null. */
export function edgeTracingOf(ctx: unknown): EdgeTracing | null {
  const found = chainGet(ctx, 'tracing')
  if (found.tag === 'none') return null
  const start = chainGet(found.value, 'startActiveSpan')
  if (start.tag === 'none' || typeof start.value !== 'function') return null
  return found.value as EdgeTracing
}

/** `ctx.tracing.getActiveSpan()` when the runtime has it (the request span outside any user span), else null. */
function activeSpanOf(ctx: unknown): EdgeSpan | null {
  const found = chainGet(ctx, 'tracing')
  if (found.tag === 'none' || found.value === null || typeof found.value !== 'object') return null
  const get = chainGet(found.value, 'getActiveSpan')
  if (get.tag === 'none' || typeof get.value !== 'function') return null
  try {
    const span: unknown = (get.value as () => unknown).call(found.value)
    const set = chainGet(span, 'setAttribute')
    return set.tag === 'some' && typeof set.value === 'function' ? span as EdgeSpan : null
  } catch {
    return null
  }
}

/**
 * Stamp attributes on the span active in the caller's context: the request span when called from the fetch handler.
 * Without `ctx.tracing` (node tests) or with a runtime that refuses, nothing happens and the request goes on.
 * Returns whether a span took the attributes.
 */
export function stampRequestSpan(ctx: unknown, attrs: EdgeStamp): boolean {
  const span = activeSpanOf(ctx)
  if (span === null) return false
  let stamped = true
  for (const [key, value] of Object.entries(attrs)) {
    try { span.setAttribute(key, value) } catch { stamped = false }
  }
  return stamped
}

/** Platform calls never fail a request: a span the runtime refuses is a span not recorded. */
function quietly(fn: () => void): void {
  try { fn() } catch { /* the runtime refused the span call; the request goes on */ }
}

/**
 * What the platform span takes beside ply's attributes: each array attribute as JSON (the runtime would join an array
 * with commas; this record is set second, so its JSON replaces that), the stamp, ply's ids, the span it follows, and
 * the duration.
 */
function extraAttrs(ended: EndedSpan, stamp: EdgeStamp): EdgeAttrs {
  const out: Record<string, EdgeValue> = { ...stamp }
  const attrs = ended.attrs
  for (const key in attrs) {
    const value = attrs[key]
    if (typeof value === 'object') out[key] = JSON.stringify(value)
  }
  out[EDGE_ATTR.spanId] = ended.spanId
  out[EDGE_ATTR.traceId] = ended.traceId
  if (ended.parentSpanId !== null) out[EDGE_ATTR.parentSpanId] = ended.parentSpanId
  const follows = ended.links.find(link => link.attrs['ply.link'] === FOLLOWS_FROM)
  if (follows) out[EDGE_ATTR.followsSpanId] = follows.spanId
  out[EDGE_ATTR.durationMs] = Math.round(ended.durationMs * 1000) / 1000
  return out
}

/** A runtime without `setAttributes`: one call per attribute, arrays as JSON. */
function setEach(edge: EdgeSpan, attrs: Readonly<Record<string, unknown>>): void {
  for (const key in attrs) {
    const value = attrs[key]
    edge.setAttribute(key, typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : JSON.stringify(value))
  }
}

/** ply's ended span onto the platform span: every attribute, ply's ids and duration, and an error status. */
function closeEdge(edge: EdgeSpan, ended: EndedSpan, stamp: EdgeStamp): void {
  quietly(() => {
    const extra = extraAttrs(ended, stamp)
    const bulk = chainGet(edge, 'setAttributes')
    if (bulk.tag === 'some' && typeof bulk.value === 'function') {
      const setAll = bulk.value as (attrs: Readonly<Record<string, unknown>>) => unknown
      setAll.call(edge, ended.attrs)
      setAll.call(edge, extra)
    } else {
      setEach(edge, ended.attrs)
      setEach(edge, extra)
    }
    if (ended.status.code === OTLP_ERROR) edge.setStatus({ code: 'error', message: ended.status.message })
  })
  quietly(() => edge.end())
}

/** A platform span, and a runner for code that must see it as the active span. */
type Opened = {
  readonly edge: EdgeSpan
  readonly within: <R>(fn: () => R) => R
}

/** The ply span this one nests under: its parent, else the span it follows. Null for a root. */
function hostId(span: PlySpan): string | null {
  if (span.parentSpanId !== null) return span.parentSpanId
  const follows = span.links.find(link => link.attributes.some(kv => kv.key === 'ply.link' && 'stringValue' in kv.value && kv.value.stringValue === FOLLOWS_FROM))
  return follows ? follows.spanId : null
}

class EdgeTracer extends Tracer {
  readonly #tracing: EdgeTracing
  /** Platform spans of ply spans still open, by ply span id. */
  readonly #open = new Map<string, Opened>()

  constructor(options: TracerOptions, tracing: EdgeTracing, stamp: EdgeStamp) {
    super(options)
    this.#tracing = tracing
    // ply calls onEnd as each span ends: close its platform span, then hand the span to the caller's onEnd.
    const given = this.onEnd
    const close: SpanSink = ended => {
      const opened = this.#open.get(ended.spanId)
      if (opened) {
        this.#open.delete(ended.spanId)
        closeEdge(opened.edge, ended, stamp)
      }
      if (given !== null) given(ended)
    }
    this.onEnd = close
  }

  override start(name: string, options: StartOptions): PlySpan {
    const span = super.start(name, options)
    const id = hostId(span)
    const host = id === null ? null : this.#open.get(id)
    const open = (): Opened | null => {
      try {
        return this.#tracing.startActiveSpan(name, edge => ({ edge, within: AsyncLocalStorage.snapshot() }))
      } catch {
        return null
      }
    }
    const opened = host ? host.within(open) : open()
    if (opened !== null) this.#open.set(span.spanId, opened)
    return span
  }
}

/**
 * The Tracer for one Worker request. Every span it records goes to `options.onEnd` (and to `options.exporter`, when
 * one is given); with `ctx.tracing` each one is also a platform span under the request span (see the top of this
 * file), carrying `stamp` (the route and version, EDGE_ATTR) beside ply's attributes. The spans ply-web keeps for
 * itself (rays, ?trace=1, the viewer's trace) are not stamped.
 */
export function plyTracer(ctx: unknown, options: TracerOptions, stamp: EdgeStamp = {}): Tracer {
  const tracing = edgeTracingOf(ctx)
  return tracing === null ? new Tracer(options) : new EdgeTracer(options, tracing, stamp)
}

/** The spans one request keeps (its stats, ?trace=1, the rays join, the viewer's trace), as ply ended them. */
export type SpanList = { readonly spans: EndedSpan[]; readonly onEnd: SpanSink }

/** A fresh SpanList: pass `onEnd` to the request's Tracer. Each span is ply's plain-value form; no OTLP is built. */
export function spanList(): SpanList {
  const spans: EndedSpan[] = []
  return { spans, onEnd: ended => { spans.push(ended) } }
}

/** Pack-cache outcome on a ply span: `git.response.cache` / `git.pack.cache` (x-ply-pack-cache), or the from_cache flag. */
export type CacheStats = {
  readonly spans: number
  readonly rtt: number
  readonly wide: number
  readonly cache_hits: number
  readonly cache_misses: number
}

function packCacheStatus(attrs: Readonly<Record<string, unknown>>): string {
  // Prefer a non-empty stamp: '' / missing falls through (same as the prior || chain in index.js).
  for (const key of ['git.response.cache', 'git.pack.cache'] as const) {
    const raw = attrs[key]
    if (typeof raw === 'string' && raw !== '') return raw
  }
  return ''
}

/**
 * Aggregate ply span outcomes into the request-span counters. Hits/misses come from child pack-cache
 * spans (`git.pack.cache` / `git.response.cache`), not from an empty CF cache status on the parent.
 * `NONE` and `''` are unstamped and ignored; `http.response.headers.from_cache` counts as a hit.
 */
export function cacheStatsOf(spans: readonly EndedSpan[]): CacheStats {
  let hits = 0
  let misses = 0
  for (const span of spans) {
    const attrs = span.attrs
    const status = packCacheStatus(attrs)
    if (status === 'HIT' || attrs['http.response.headers.from_cache'] === true) hits += 1
    else if (status === 'MISS' || status === 'EXPIRED' || status === 'BYPASS' || status === 'BUST') misses += 1
  }
  return {
    spans: spans.length,
    rtt: spans.filter(x => /^git\.(upload-pack|receive-pack)/.test(x.name)).length,
    wide: spans.filter(x => Boolean(x.attrs['git.fetch.filter.fallback'])).length,
    cache_hits: hits,
    cache_misses: misses,
  }
}

/** The route and version stamp for one request. A missing version id (local dev, tests) is left out, not faked. */
export function routeStamp(route: string, version: string | null): EdgeStamp {
  return version === null || version === '' ? { [EDGE_ATTR.route]: route } : { [EDGE_ATTR.route]: route, [EDGE_ATTR.version]: version }
}

/** What the request log line already carries (src/index.js `done`): the code on a failure, and ply's span counts. */
type RequestLog = Readonly<Record<string, unknown>>

const LOGGED_COUNTS = [
  ['spans', REQUEST_ATTR.spans],
  ['rtt', REQUEST_ATTR.roundTrips],
  ['wide', REQUEST_ATTR.wide],
  ['cache_hits', REQUEST_ATTR.cacheHits],
  ['cache_misses', REQUEST_ATTR.cacheMisses],
] as const

/**
 * The request span's attributes: route, version, surface, status, and from the log line the error code and kind and
 * ply's counts. Only finite numbers and non-empty strings are copied; a field the log does not have is left out.
 */
export function requestStamp(input: { readonly route: string; readonly version: string | null; readonly surface: string; readonly status: number; readonly log: RequestLog }): EdgeStamp {
  const out: Record<string, string | number | boolean> = { ...routeStamp(input.route, input.version), [REQUEST_ATTR.surface]: input.surface, [REQUEST_ATTR.status]: input.status }
  const code = input.log.code
  if (typeof code === 'string' && code !== '') out[REQUEST_ATTR.errorCode] = code
  const kind = input.log.error_kind
  if (typeof kind === 'string' && kind !== '') out[REQUEST_ATTR.errorKind] = kind
  for (const [from, to] of LOGGED_COUNTS) {
    const value = input.log[from]
    if (typeof value === 'number' && Number.isFinite(value)) out[to] = value
  }
  return out
}
