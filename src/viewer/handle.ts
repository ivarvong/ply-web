// Public viewer entry. No PLY_TOKEN, no git credential, no /v1 handler. Rate limit runs before any git fetch.
// This module does not import rate.ts: node tests must not load cloudflare:workers. The Worker re-exports the class.
import { chainGet } from '../absent.ts'
import { openSpan, type TracingLike } from '../flags/telemetry.ts'
import { plyBuildValue, BUILD_HEADER } from '../version.ts'
import { ok, runRequest, type Result, type UnexpectedFailure } from '../http/machine.ts'
import { viewerApp } from './app.tsx'
import { viewerCalls, type HandleOpts, type ViewerCall, type ViewerCtx } from './call.ts'
import { htmlResponse } from './http.ts'
import type { TraceModel, ViewerEnv } from './model.ts'
import { renderError } from './render.tsx'

export type { HandleOpts, ViewerCtx }

const EMPTY: TraceModel = { bars: [], totalMs: 0, cfRay: '', requestId: '' }

type EdgeSpan = { setAttribute?(key: string, value: string | number | boolean): void; end?(): void }

/** A null receiver or a null method skips. A present method keeps its receiver and may throw. */
function callMethod(receiver: unknown, key: string, args: readonly unknown[]): void {
  const method = chainGet(receiver, key)
  if (method.tag === 'none') return
  const fn = method.value as (...params: unknown[]) => unknown
  fn.apply(receiver, [...args])
}

type ViewerReady = { readonly requestId: string }

function viewerFailure(failure: UnexpectedFailure, call: ViewerCall): Response {
  console.log(JSON.stringify({
    msg: 'ply.viewer',
    error_kind: failure.kind,
    stage: failure.stage,
    error_name: failure.name,
  }))
  const trace = { ...EMPTY, cfRay: call.cfRay, requestId: call.requestId }
  const res = htmlResponse(500, renderError(500, 'internal', 'The viewer hit an internal error.', trace), trace, call.requestId)
  res.headers.set('x-ply-error-kind', failure.kind)
  call.fields['http.status_code'] = 500
  call.fields['error.type'] = failure.kind
  return res
}

export async function handleViewer(req: Request, env: ViewerEnv, ctx: unknown = null, opts: unknown = null): Promise<Response> {
  const requestIdField = chainGet(opts, 'requestId')
  const nowField = chainGet(opts, 'now')
  const ray = req.headers.get('cf-ray')
  const requestId = requestIdField.tag === 'none' ? crypto.randomUUID() : requestIdField.value as string
  const call: ViewerCall = {
    requestId,
    now: nowField.tag === 'none' ? Date.now() : nowField.value as number,
    cfRay: ray === null ? '' : ray,
    opts,
    ctx,
    fields: {},
    route: null,
  }
  viewerCalls.set(req, call)
  let span: EdgeSpan | null = null
  let spanClosed = false
  const closeSpan = (): void => {
    if (spanClosed) return
    spanClosed = true
    if (!span) return
    for (const [key, value] of Object.entries(call.fields)) callMethod(span, 'setAttribute', [key, value])
    callMethod(span, 'end', [])
  }
  return runRequest(
    {
      parse: () => {
        const tracing = chainGet(ctx, 'tracing')
        span = openSpan(tracing.tag === 'some' ? tracing.value as TracingLike : null, 'ply.viewer')
        return ok({ requestId } satisfies ViewerReady)
      },
      authorize: (parsed: ViewerReady) => ok(parsed),
      execute: async () => ok(await viewerApp.fetch(req, env)),
    },
    (result: Result<Response, UnexpectedFailure>) => {
      const res = result.ok ? result.value : viewerFailure(result.error, call)
      closeSpan()
      res.headers.set(BUILD_HEADER, plyBuildValue())
      return res
    },
  )
}
