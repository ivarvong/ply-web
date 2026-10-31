import { LAYOUT } from './layout.ts'
import { VIEWER_CSP } from './script.ts'
import type { SafeHtml } from './safehtml.ts'
import { traceHeader } from './traceview.ts'
import type { TraceModel } from './model.ts'

export const SECURITY: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'content-security-policy': VIEWER_CSP,
  'cross-origin-resource-policy': 'same-origin',
}

export { statusOf } from '../status.ts'

export function htmlResponse(status: number, body: SafeHtml, trace: TraceModel, requestId: string, extra: Record<string, string> = {}): Response {
  const summary = traceHeader(trace)
  const timing = [`total;dur=${Math.max(0, trace.totalMs)}`, summary].filter(Boolean).join(', ').slice(0, LAYOUT.serverTimingChars)
  const headers = new Headers({
    ...SECURITY,
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-ply-request-id': requestId,
    'server-timing': timing,
    ...extra,
  })
  if (summary) headers.set('x-ply-trace', summary)
  return new Response(body, { status, headers })
}

export function textResponse(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...SECURITY, 'content-type': 'text/plain; charset=utf-8', ...extra },
  })
}
