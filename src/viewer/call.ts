import type { FetchLike } from './fetchguard.ts'
import type { LoopbackBinding } from '../gitcache.ts'
import type { ViewerRoute } from './route.ts'
import type { ViewerEnv } from './model.ts'

type EdgeSpan = {
  setAttribute?(key: string, value: string | number | boolean): void
  end?(): void
}

export type ViewerCtx = {
  waitUntil: ((promise: Promise<unknown>) => void) | null
  exports: { GitCache: LoopbackBinding | null } | null
  tracing: { enterSpan(name: string): EdgeSpan } | null
}

export type HandleOpts = {
  requestId: string | null
  fetchImpl: FetchLike | null
  now: number | null
  note: ((extra: Record<string, string | number>) => void) | null
  /** Pinned's internal fill (src/pinned.ts): the front door already rate-limited this request. */
  skipRate: boolean | null
  /**
   * Tests pass a GitCache loopback. Null means no cache. A missing field keeps the default:
   * ctx.exports.GitCache unless PACK_CACHE=off. The stored call keeps the raw opts so those stay distinct.
   */
  loopback: (() => LoopbackBinding | null) | null
}

export type SpanFields = Record<string, string | number | boolean>

export type ViewerCall = {
  requestId: string
  now: number
  cfRay: string
  opts: unknown
  ctx: unknown
  fields: SpanFields
  route: ViewerRoute | null
}

export const viewerCalls = new WeakMap<Request, ViewerCall>()

export type { ViewerEnv }
