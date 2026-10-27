import { LAYOUT } from './layout.ts'
import { VIEWER_CSP } from './script.ts'
import { traceHeader } from './traceview.ts'
import type { TraceModel } from './model.ts'

const STATUS: Record<string, number> = {
  bad_request: 400, unsupported: 501, network: 502, timeout: 504, aborted: 499, http: 502, auth: 401, not_found: 404,
  rate_limited: 429, upstream_5xx: 502, not_git: 502, ssh: 502, host_key_mismatch: 502, protocol: 502, pack_corrupt: 502,
  remote_error: 502, limit_exceeded: 413, match_count: 422, lfs_pointer: 422, cas_conflict: 409, push_rejected: 409,
  merge_conflict: 409, not_fast_forward: 409, not_linear: 422, unrelated_histories: 422, ambiguous: 502, internal: 500,
}

export const SECURITY: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'content-security-policy': VIEWER_CSP,
  'cross-origin-resource-policy': 'same-origin',
}

export function statusOf(err: { code?: string; status?: number }): number {
  if (err?.code === 'auth' && (err.status === 401 || err.status === 403)) return err.status
  return STATUS[err?.code ?? ''] ?? 500
}

export function htmlResponse(status: number, body: string, trace: TraceModel, requestId: string, extra: Record<string, string> = {}): Response {
  const timing = [`total;dur=${Math.max(0, trace.totalMs)}`, traceHeader(trace)].filter(Boolean).join(', ').slice(0, LAYOUT.serverTimingChars)
  const headers = new Headers({
    ...SECURITY,
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-ply-request-id': requestId,
    'server-timing': timing,
    'x-ply-trace': traceHeader(trace),
    ...extra,
  })
  return new Response(body, { status, headers })
}

export function textResponse(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...SECURITY, 'content-type': 'text/plain; charset=utf-8', ...extra },
  })
}
