import type { FetchLike } from './fetchguard.ts'
import type { ViewerRoute } from './route.ts'
import type { ViewerEnv } from './model.ts'

export type ViewerCtx = {
  waitUntil?: (promise: Promise<unknown>) => void
  tracing?: { enterSpan?: (name: string) => EdgeSpan }
}

type EdgeSpan = { setAttribute?: (key: string, value: string | number | boolean) => void; end?: () => void }

export type HandleOpts = {
  requestId?: string
  fetchImpl?: FetchLike
  now?: number
  note?: (extra: Record<string, string | number>) => void
  cache?: { match: (key: string) => Promise<Response | undefined>; put: (key: string, res: Response) => Promise<void>; delete: (key: string) => Promise<boolean> } | null
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
