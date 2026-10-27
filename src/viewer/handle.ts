// Public viewer entry. No PLY_TOKEN, no git credential, no /v1 handler. Rate limit runs before any git fetch.
// This module does not import rate.ts: node tests must not load cloudflare:workers. The Worker re-exports the class.
import { viewerApp } from './app.tsx'
import { viewerCalls, type HandleOpts, type ViewerCall, type ViewerCtx } from './call.ts'
import { htmlResponse } from './http.ts'
import type { TraceModel, ViewerEnv } from './model.ts'
import { renderError } from './render.tsx'

export type { HandleOpts, ViewerCtx }

const EMPTY: TraceModel = { bars: [], totalMs: 0, cfRay: '', requestId: '' }

type EdgeSpan = { setAttribute?: (key: string, value: string | number | boolean) => void; end?: () => void }

function edgeSpan(ctx: ViewerCtx): EdgeSpan | null {
  try { return ctx.tracing?.enterSpan?.('ply.viewer') ?? null }
  catch { return null }
}

export async function handleViewer(req: Request, env: ViewerEnv, ctx: ViewerCtx = {}, opts: HandleOpts = {}): Promise<Response> {
  const requestId = opts.requestId ?? crypto.randomUUID()
  const call: ViewerCall = {
    requestId,
    now: opts.now ?? Date.now(),
    cfRay: req.headers.get('cf-ray') ?? '',
    opts,
    ctx,
    fields: {},
  }
  viewerCalls.set(req, call)
  const span = edgeSpan(ctx)
  let res: Response
  try {
    res = await viewerApp.fetch(req, env)
  } catch {
    const trace = { ...EMPTY, cfRay: call.cfRay, requestId }
    res = htmlResponse(500, renderError(500, 'internal', 'The viewer hit an internal error.', trace), trace, requestId)
    call.fields['http.status_code'] = 500
  }
  try {
    for (const [key, value] of Object.entries(call.fields)) span?.setAttribute?.(key, value)
    span?.end?.()
  } catch { /* tracing is optional */ }
  return res
}
