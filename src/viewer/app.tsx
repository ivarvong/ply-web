import { Hono } from 'hono'
import { createBudget } from './budget.ts'
import { viewerCalls, type ViewerCall } from './call.ts'
import { safeFilename } from './escape.ts'
import { createViewerFetch, type FetchLike } from './fetchguard.ts'
import { htmlResponse, SECURITY, statusOf, textResponse } from './http.ts'
import { VIEWER_CAPS, rateLimitFor, type RateBucket } from './limits.ts'
import type { RateDecision, TraceModel, ViewerEnv } from './model.ts'
import { cachedFetch, makeTracer, plyCode, spanCollector } from './ply.ts'
import { parseViewerRequest, routeOptsFromEnv, type ViewerRoute } from './route.ts'
import { renderError, renderHome, renderLoaded } from './render.tsx'
import { VIEWER_CSS } from './styles.ts'
import { loadRepo } from './session.ts'
import { buildTrace, traceHeader } from './traceview.ts'
import { LAYOUT } from './layout.ts'

function callOf(req: Request): ViewerCall {
  const call = viewerCalls.get(req)
  if (!call) throw new Error('viewer call missing')
  return call
}

async function clientKey(req: Request): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ply-viewer-rate/1\n${ip}`))
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

async function admit(req: Request, env: ViewerEnv, bucket: RateBucket, now: number): Promise<RateDecision | 'unconfigured' | 'unavailable'> {
  const ns = env.VIEWER_RATE
  if (!ns) return 'unconfigured'
  try {
    const stub = ns.get(ns.idFromName(await clientKey(req)))
    return await stub.admit(bucket, now, rateLimitFor(bucket, bucket === 'pack' ? env.VIEWER_PACK_RATE_PER_MIN : env.VIEWER_RATE_PER_MIN), VIEWER_CAPS.rateWindowMs)
  } catch {
    return 'unavailable'
  }
}

function defaultCache(): ViewerCall['opts']['cache'] {
  const g = globalThis as { caches?: { default?: ViewerCall['opts']['cache'] } }
  return g.caches?.default ?? null
}

function isText(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true }
  catch { return false }
}

function headless(req: Request, res: Response): Response {
  if (req.method !== 'HEAD') return res
  return new Response(null, { status: res.status, headers: res.headers })
}

function traceOf(call: ViewerCall, bars: TraceModel['bars'] = []): TraceModel {
  return { bars, totalMs: 0, cfRay: call.cfRay, requestId: call.requestId }
}

function routeError(call: ViewerCall, err: unknown): Response {
  const code = plyCode((err as { code?: string })?.code) ? (err as { code: string }).code : 'bad_request'
  const message = code === 'internal' ? 'The viewer hit an internal error.' : String((err as { message?: string })?.message ?? err).slice(0, 500)
  const status = statusOf({ code })
  call.opts.note?.({ code, status })
  call.fields['http.status_code'] = status
  call.fields['error.type'] = code
  const trace = traceOf(call)
  return htmlResponse(status, renderError(status, code, message, trace), trace, call.requestId)
}

async function rateGate(req: Request, env: ViewerEnv, call: ViewerCall, route: Extract<ViewerRoute, { kind: 'repo' }> | { kind: 'home' } | { kind: 'redirect' }): Promise<Response | null> {
  const bucket: RateBucket = route.kind === 'repo' && route.pack ? 'pack' : 'page'
  const decision = await admit(req, env, bucket, call.now)
  if (decision === 'unconfigured' || decision === 'unavailable') {
    const trace = traceOf(call)
    const message = decision === 'unconfigured' ? 'The viewer rate limiter is not configured.' : 'The viewer rate limiter is unavailable.'
    call.opts.note?.({ code: 'rate_unavailable', status: 503 })
    call.fields['http.status_code'] = 503
    return htmlResponse(503, renderError(503, 'unavailable', message, trace), trace, call.requestId)
  }
  if (!decision.ok) {
    const retry = String(Math.max(1, Math.ceil(decision.retryAfterMs / LAYOUT.msPerSecond)))
    const trace = traceOf(call)
    call.opts.note?.({ code: 'rate_limited', status: 429 })
    call.fields['http.status_code'] = 429
    return htmlResponse(429, renderError(429, 'rate_limited', `Too many viewer requests. Retry after ${retry}s.`, trace), trace, call.requestId, { 'retry-after': retry })
  }
  return null
}

function cssResponse(call: ViewerCall, method: string): Response {
  call.fields['http.status_code'] = 200
  call.fields['ply.viewer.route'] = 'css'
  return new Response(method === 'HEAD' ? null : VIEWER_CSS, {
    status: 200,
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': `public, max-age=${LAYOUT.cssCacheSeconds}`,
      ...SECURITY,
      'x-ply-request-id': call.requestId,
    },
  })
}

async function serveRepo(req: Request, env: ViewerEnv, call: ViewerCall, route: Extract<ViewerRoute, { kind: 'repo' }>): Promise<Response> {
  const limited = await rateGate(req, env, call, route)
  if (limited) return headless(req, limited)
  const collected = spanCollector()
  const tracer = makeTracer(collected.exporter, { maxEvents: 48, resource: { 'service.name': 'ply-viewer' } })
  const budget = createBudget()
  const pageSignal = AbortSignal.timeout(VIEWER_CAPS.pageTimeoutMs)
  const guard = createViewerFetch(call.opts.fetchImpl ?? globalThis.fetch, route.loc.url, route.loc.allowedHosts, budget, pageSignal)
  const cache = call.opts.cache === undefined ? (env.PACK_CACHE === 'off' ? null : defaultCache()) : call.opts.cache
  const fetchImpl: FetchLike = cache ? cachedFetch(guard, cache, promise => { try { call.ctx.waitUntil?.(promise) } catch { /* already settled */ } }) : guard
  try {
    const loaded = await loadRepo(route, { tracer, fetchImpl, signal: pageSignal, budget })
    const trace = buildTrace(collected.lines, call.cfRay, call.requestId)
    call.opts.note?.({ host: route.loc.host, rtt: trace.bars.length, bytes: budget.bytes, code: 'ok' })
    if (loaded.kind === 'raw') {
      const text = isText(loaded.bytes)
      const headers = new Headers({
        ...SECURITY,
        'content-type': text ? 'text/plain; charset=utf-8' : 'application/octet-stream',
        'content-disposition': `${text ? 'inline' : 'attachment'}; filename="${safeFilename(loaded.filename)}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-ply-request-id': call.requestId,
        'x-ply-trace': traceHeader(trace),
      })
      const copy = new ArrayBuffer(loaded.bytes.byteLength)
      new Uint8Array(copy).set(loaded.bytes)
      call.fields['http.status_code'] = 200
      call.fields['ply.viewer.route'] = 'raw'
      call.fields['server.address'] = route.loc.host
      return new Response(req.method === 'HEAD' ? null : new Blob([copy]), { status: 200, headers })
    }
    call.fields['http.status_code'] = 200
    call.fields['ply.viewer.route'] = loaded.kind
    call.fields['server.address'] = route.loc.host
    call.fields['ply.viewer.ref'] = loaded.header.ref
    call.fields['ply.viewer.upstream_spans'] = trace.bars.length
    return headless(req, htmlResponse(200, renderLoaded(loaded, trace, call.now), trace, call.requestId))
  } catch (err) {
    const code = plyCode((err as { code?: string })?.code) ? (err as { code: string }).code : 'internal'
    const status = code === 'internal' ? 500 : statusOf(err as { code?: string; status?: number })
    const message = code === 'internal' ? 'The viewer hit an internal error.' : String((err as { message?: string })?.message ?? err).slice(0, 500)
    const trace = buildTrace(collected.lines, call.cfRay, call.requestId)
    call.opts.note?.({ host: route.loc.host, code, status, rtt: trace.bars.length })
    call.fields['http.status_code'] = status
    call.fields['error.type'] = code
    call.fields['server.address'] = route.loc.host
    return headless(req, htmlResponse(status, renderError(status, code, message, trace, route.loc.host, route.loc.repoPath, route.ref, call.now), trace, call.requestId))
  }
}

export const viewerApp = new Hono<{ Bindings: ViewerEnv }>()

viewerApp.use('*', async (c, next) => {
  const call = callOf(c.req.raw)
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    call.fields['http.status_code'] = 405
    return textResponse(405, 'method not allowed', { allow: 'GET, HEAD' })
  }
  try {
    call.route = parseViewerRequest(c.req.url, routeOptsFromEnv(c.env))
  } catch (err) {
    return headless(c.req.raw, routeError(call, err))
  }
  await next()
})

viewerApp.on(['GET', 'HEAD'], '/view.css', c => {
  const call = callOf(c.req.raw)
  if (call.route?.kind !== 'css') return headless(c.req.raw, routeError(call, { code: 'bad_request', message: 'not a viewer route' }))
  return cssResponse(call, c.req.method)
})

viewerApp.on(['GET', 'HEAD'], '/view', c => serveEntry(c.req.raw, c.env))
viewerApp.on(['GET', 'HEAD'], '/view/', c => serveEntry(c.req.raw, c.env))

viewerApp.on(['GET', 'HEAD'], '/view/*', c => {
  const call = callOf(c.req.raw)
  const route = call.route
  if (!route || route.kind !== 'repo') return headless(c.req.raw, routeError(call, { code: 'bad_request', message: 'not a viewer route' }))
  return serveRepo(c.req.raw, c.env, call, route)
})

viewerApp.notFound(c => {
  const call = viewerCalls.get(c.req.raw)
  if (!call) return textResponse(404, 'not found')
  call.fields['http.status_code'] = 404
  const trace = traceOf(call)
  return headless(c.req.raw, htmlResponse(404, renderError(404, 'not_found', 'not a viewer route', trace), trace, call.requestId))
})

async function serveEntry(req: Request, env: ViewerEnv): Promise<Response> {
  const call = callOf(req)
  const route = call.route
  if (!route || (route.kind !== 'home' && route.kind !== 'redirect')) {
    return headless(req, routeError(call, { code: 'bad_request', message: 'not a viewer route' }))
  }
  const limited = await rateGate(req, env, call, route)
  if (limited) return headless(req, limited)
  if (route.kind === 'redirect') {
    call.fields['http.status_code'] = 302
    return new Response(null, { status: 302, headers: { location: route.location, 'cache-control': 'no-store', ...SECURITY, 'x-ply-request-id': call.requestId } })
  }
  const trace = traceOf(call)
  call.fields['http.status_code'] = 200
  call.fields['ply.viewer.route'] = 'home'
  return headless(req, htmlResponse(200, renderHome(null, call.now), trace, call.requestId))
}
