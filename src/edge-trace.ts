// ply's spans in Workers tracing (Workers Observability), live, nested under the request span as ply nests them.
//
// ply records every span on its own Tracer (OTLP/JSON lines; src/rays.ts and ?trace=1 read them). Nothing there reaches
// the platform. Workers Observability shows a custom span only when the Worker opens it on `ctx.tracing`, the runtime's
// user-tracing API (.cloudflare/types/index.d.ts `interface Tracing`, workerd `workerd::api::Tracing`): a span opened
// there is a child of the span active in the current async context (the request span when none is), its start and end
// are the runtime's clock, and `end()` closes it.
//
// `plyTracer(ctx, options)` is the one Tracer the /v1 API (src/index.js) and the viewer (src/viewer/app.tsx) construct.
// With `ctx.tracing` it mirrors each ply span onto a platform span when ply opens it, and closes that span with ply's
// attributes, status, and ids when ply ends it. Parentage is ply's, not whatever happens to be active: each platform span
// is opened with `startActiveSpan`, and the async context inside that callback (where it is the active span) is kept with
// `AsyncLocalStorage.snapshot()`. A ply child is opened inside its parent's snapshot, so the runtime makes it that span's
// child. A ply root (`git.edit`, a bare wire span) is opened in the caller's context: a child of the request span. A span
// that follows another (`git.read.blob` after `git.read`) nests under it while it is open.
// Without `ctx.tracing` (node tests, a runtime without user tracing) it is ply's plain Tracer.
import { AsyncLocalStorage } from 'node:async_hooks'
import { Tracer, flattenLine } from 'ply'
import { chainGet } from './absent.ts'

type PlySpan = ReturnType<Tracer['start']>
type TracerOptions = ConstructorParameters<typeof Tracer>[0]
type StartOptions = Parameters<Tracer['start']>[1]
type OtlpSpan = Parameters<Tracer['export']>[0]

/** The platform span: what `ctx.tracing.startActiveSpan` hands its callback. */
export type EdgeSpan = {
  setAttribute(key: string, value: string | number | boolean): unknown
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

function attributeValue(value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return JSON.stringify(value)
}

/** ply's ended span onto the platform span: every attribute, ply's ids and duration, and an error status. */
function closeEdge(edge: EdgeSpan, otlp: OtlpSpan, tracer: Tracer, stamp: EdgeStamp): void {
  const [flat] = flattenLine({ resourceSpans: [{ resource: tracer.resource, scopeSpans: [{ scope: tracer.scope, spans: [otlp] }] }] })
  if (flat) {
    quietly(() => {
      for (const [key, value] of Object.entries(stamp)) edge.setAttribute(key, value)
      for (const [key, value] of Object.entries(flat.attrs)) edge.setAttribute(key, attributeValue(value))
      edge.setAttribute(EDGE_ATTR.spanId, flat.spanId)
      edge.setAttribute(EDGE_ATTR.traceId, flat.traceId)
      if (flat.parentSpanId !== null) edge.setAttribute(EDGE_ATTR.parentSpanId, flat.parentSpanId)
      const follows = flat.links.find(link => link.attrs['ply.link'] === FOLLOWS_FROM)
      if (follows) edge.setAttribute(EDGE_ATTR.followsSpanId, follows.spanId)
      edge.setAttribute(EDGE_ATTR.durationMs, Math.round(flat.durationMs * 1000) / 1000)
      if (flat.status.code === OTLP_ERROR) edge.setStatus({ code: 'error', message: flat.status.message })
    })
  }
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
  readonly #stamp: EdgeStamp

  constructor(options: TracerOptions, tracing: EdgeTracing, stamp: EdgeStamp) {
    super(options)
    this.#tracing = tracing
    this.#stamp = stamp
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

  override export(otlp: OtlpSpan): void {
    super.export(otlp)
    const opened = this.#open.get(otlp.spanId)
    if (!opened) return
    this.#open.delete(otlp.spanId)
    closeEdge(opened.edge, otlp, this, this.#stamp)
  }
}

/**
 * The Tracer for one Worker request. Every span it records still goes to `options.exporter`; with `ctx.tracing` each
 * one is also a platform span under the request span (see the top of this file), carrying `stamp` (the route and
 * version, EDGE_ATTR) beside ply's attributes. ply's own export (rays, ?trace=1) is not stamped.
 */
export function plyTracer(ctx: unknown, options: TracerOptions, stamp: EdgeStamp = {}): Tracer {
  const tracing = edgeTracingOf(ctx)
  return tracing === null ? new Tracer(options) : new EdgeTracer(options, tracing, stamp)
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
