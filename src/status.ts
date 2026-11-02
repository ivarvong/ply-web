// HTTP status for every error code a response can carry: each of ply's codes, and the Worker's own (src/write/errors.ts).
// `statusOfCode` is a switch over that closed union with no default: a code ply adds fails typecheck here until it is
// mapped, and assertNever makes a code ply drops (a dead case) a type error too. test/status.test.ts checks the table.
import { CODES } from 'ply'
import { chainGet } from './absent.ts'
import { assertNever } from './never.ts'
import type { PlyCode } from './ply-result.ts'
import { CODE_REF_EXISTS, CODE_STALE_EXPECTED, isWorkerCode, type WorkerCode } from './write/errors.ts'

export type ErrorCode = PlyCode | WorkerCode

export function statusOfCode(code: ErrorCode): number {
  switch (code) {
    case 'bad_request': return 400
    case 'unsupported': return 501
    case 'network': return 502
    case 'timeout': return 504
    case 'aborted': return 499
    case 'http': return 502
    case 'auth': return 401
    case 'not_found': return 404
    case 'rate_limited': return 429
    case 'upstream_5xx': return 502
    case 'not_git': return 502
    case 'protocol': return 502
    case 'pack_corrupt': return 502
    case 'remote_error': return 502
    case 'limit_exceeded': return 413
    case 'match_count': return 422
    case 'lfs_pointer': return 422
    case 'cas_conflict': return 409
    case 'push_rejected': return 409
    case 'push_partial': return 409
    case 'merge_conflict': return 409
    case 'not_fast_forward': return 409
    case 'not_linear': return 422
    case 'unrelated_histories': return 422
    case 'ambiguous': return 502
    case 'internal': return 500
    case CODE_REF_EXISTS: return 409
    case CODE_STALE_EXPECTED: return 409
  }
  return assertNever(code)
}

/** An own member of the code union. ply's isPlyCode is an `in` test, so an inherited name such as 'toString' passes it. */
export function isErrorCode(code: unknown): code is ErrorCode {
  return isWorkerCode(code) || CODES.some(known => known === code)
}

const ALL_CODES: readonly ErrorCode[] = [...CODES, CODE_REF_EXISTS, CODE_STALE_EXPECTED]

export const STATUS: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries(ALL_CODES.map(code => [code, statusOfCode(code)])))

/** `auth` keeps the upstream's own 401 or 403; anything unmapped is 500. */
export function statusOf(err: unknown): number {
  const code = chainGet(err, 'code')
  if (code.tag !== 'some' || !isErrorCode(code.value)) return 500
  const status = chainGet(err, 'status')
  if (code.value === 'auth' && status.tag === 'some' && (status.value === 401 || status.value === 403)) return status.value
  return statusOfCode(code.value)
}
