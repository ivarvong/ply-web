import type { FetchLike } from './fetchguard.ts'
import type { LoopbackBinding } from '../gitcache.ts'
import type { ViewerRoute } from './route.ts'
import type { ViewerEnv } from './model.ts'

export type ViewerCtx = {
  waitUntil?: (promise: Promise<unknown>) => void
  exports?: { GitCache?: LoopbackBinding }
  tracing?: { enterSpan?: (name: string) => EdgeSpan }
}

type EdgeSpan = { setAttribute?: (key: string, value: string | number | boolean) => void; end?: () => void }

export type HandleOpts = {
  requestId?: string
  fetchImpl?: FetchLike
  now?: number
  note?: (extra: Record<string, string | number>) => void
  /** Pinned's internal fill (src/pinned.ts): the front door already rate-limited this request. */
  skipRate?: boolean
  /** Tests: the GitCache loopback to use (null: none). Default: ctx.exports.GitCache unless PACK_CACHE=off. */
  loopback?: (() => LoopbackBinding | null | undefined) | null
}

export type SpanFields = Record<string, string | number | boolean>

export type ViewerCall = {
  requestId: string
  now: number
  cfRay: string
  opts: HandleOpts
  ctx: ViewerCtx
  fields: SpanFields
  route?: ViewerRoute
}

export const viewerCalls = new WeakMap<Request, ViewerCall>()

export type { ViewerEnv }
