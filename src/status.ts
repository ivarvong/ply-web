// HTTP status for every error code a response can carry: each of ply's codes, and the Worker's own (src/write/errors.ts).
// `satisfies Record<PlyCode, number>` makes the table exhaustive both ways: a code ply adds fails typecheck until it
// is mapped here, and a code ply drops fails until it is removed. test/status.test.ts checks the same at runtime.
import { CODES } from 'ply'
import { chainGet } from './absent.ts'
import { CODE_REF_EXISTS, CODE_STALE_EXPECTED } from './write/errors.ts'

type PlyCode = (typeof CODES)[number]

const PLY_STATUS = {
  bad_request: 400, unsupported: 501, network: 502, timeout: 504, aborted: 499, http: 502, auth: 401, not_found: 404,
  rate_limited: 429, upstream_5xx: 502, not_git: 502, protocol: 502, pack_corrupt: 502, remote_error: 502,
  limit_exceeded: 413, match_count: 422, lfs_pointer: 422, cas_conflict: 409, push_rejected: 409, push_partial: 409,
  merge_conflict: 409, not_fast_forward: 409, not_linear: 422, unrelated_histories: 422, ambiguous: 502, internal: 500,
} as const satisfies Record<PlyCode, number>

const WORKER_STATUS = { [CODE_REF_EXISTS]: 409, [CODE_STALE_EXPECTED]: 409 } as const

export const STATUS: Readonly<Record<string, number>> = Object.freeze({ ...PLY_STATUS, ...WORKER_STATUS })

/** `auth` keeps the upstream's own 401 or 403; anything unmapped is 500. */
export function statusOf(err: unknown): number {
  const code = chainGet(err, 'code')
  const status = chainGet(err, 'status')
  if (code.tag === 'some' && code.value === 'auth' && status.tag === 'some' && (status.value === 401 || status.value === 403)) return status.value
  const name = code.tag === 'some' && typeof code.value === 'string' ? code.value : ''
  return name !== '' && Object.prototype.hasOwnProperty.call(STATUS, name) ? STATUS[name]! : 500
}
