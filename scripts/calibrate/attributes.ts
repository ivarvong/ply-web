// The input distributions calibration reads (issue #73), per /v1 route. Each name is a numeric attribute ply records on
// a span of that route (ply's own span contract), which src/edge-trace.ts mirrors onto Workers tracing with the route
// (`ply.route`) and Workers version (`ply.script_version`) stamped beside it. test/worker-spans.test.js drives every
// route under workerd and asserts each listed attribute reaches Workers tracing as a number, so this table is a floor
// the telemetry is known to carry, not a wish list. scripts/calibrate reports every numeric attribute it sees; these
// are the ones a threshold in scripts/calibrate/thresholds.json may name.
import type { ApiRoute } from '../../src/api-routes.ts'

/** Wire spans of every route that talks to the remote: how many bytes came back. */
const WIRE = ['git.response.bytes'] as const
/** Routes that list refs first. */
const REFS = ['git.ls_refs.count'] as const
/** Routes that fetch a pack. */
const PACK = ['git.pack.bytes', 'git.pack.objects', 'git.pack.inflated.bytes'] as const
/** Routes that push. */
const PUSH = ['git.push.pack.bytes', 'git.push.pack.objects'] as const

export const ROUTE_INPUTS: Readonly<Record<ApiRoute, readonly string[]>> = {
  'GET /v1/refs': [...WIRE, ...REFS],
  'GET /v1/discover': [...WIRE],
  'GET /v1/tree': [...WIRE, ...REFS, ...PACK, 'git.ls_tree.entries', 'git.ls_tree.path.depth'],
  'GET /v1/commit': [...WIRE, ...REFS, ...PACK, 'git.read_commit.parents'],
  'GET /v1/read': [...WIRE, ...REFS, ...PACK, 'git.read.blob.bytes', 'git.read.blob.size', 'git.read.path.depth', 'git.read.tree.entries', 'git.read.tree.depth'],
  'POST /v1/edit': [...WIRE, ...REFS, ...PACK, ...PUSH, 'git.edit.tree.entries', 'git.edit.tree.depth', 'git.edit.path.depth', 'git.edit.blob.delta.bytes', 'git.edit.blob.new_len'],
  'POST /v1/branch': [...WIRE, ...REFS, ...PUSH],
  'DELETE /v1/branch': [...WIRE, ...REFS, ...PUSH],
  'POST /v1/tag': [...WIRE, ...REFS, ...PUSH],
  'DELETE /v1/tag': [...WIRE, ...REFS, ...PUSH],
  'POST /v1/merge': [...WIRE, ...REFS, ...PACK, ...PUSH, 'git.pack.chain.max', 'git.merge.base.depth', 'git.merge.conflicts.count'],
  'POST /v1/rebase': [...WIRE, ...REFS, ...PACK, ...PUSH, 'git.pack.chain.max', 'git.rebase.commits'],
  'POST /v1/cherry-pick': [...WIRE, ...REFS, ...PACK, ...PUSH],
  'POST /v1/revert': [...WIRE, ...REFS, ...PACK, ...PUSH],
}

/** Numeric attributes on the request span of every /v1 request (src/edge-trace.ts REQUEST_ATTR). */
export const REQUEST_INPUTS = ['ply.spans', 'ply.round_trips', 'ply.wide_fetches', 'ply.cache_hits'] as const

/**
 * String-valued attributes counted per value rather than as a distribution: the error taxonomy and cache status.
 * `error.type`/`error.kind` are ply's (otel.ts); the `ply.error.*` pair is the request span's.
 */
export const CATEGORICAL = [
  'error.type',
  'error.kind',
  'ply.error.code',
  'ply.error.kind',
  'git.response.cache',
  'git.pack.cache',
  'http.response.status_code',
] as const

/** Numeric attributes that are identifiers, protocol constants, or echoed configuration, not an input distribution. */
export const NOT_INPUTS: readonly string[] = ['git.protocol.version', 'git.limits.request_timeout_ms', 'git.pack.version', 'ply.duration_ms', 'http.response.status_code']
