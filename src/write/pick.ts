// Cherry-pick and revert.
//
// ply returns `{outcome:'empty'}` when the transplanted tree equals the target tree and the rename guard stands
// down: both sides added and deleted exactly the same paths (#103). A target that also has its own adds or deletes
// is `merge_conflict` (HTTP 409). ply-web used to report that wider case as empty, because it compared post-images
// and ignored the extra paths. `allowEmpty` is ply's `empty: 'keep'` (`kept_empty`, an applied commit on the same
// tree). `empty: 'stop'` reports empty and writes nothing.
import { cherryPick, fail, revertCommit } from 'ply'
import { type CallOpts } from './call.ts'
import { type Stamp } from './identity.ts'
import { firstPresent, writeResult } from './result.ts'

const OUTCOME_EMPTY = 'empty'
const OUTCOME_OK = 'ok'
const OUTCOME_KEPT = 'kept_empty'

export type PlyPickResult = {
  readonly outcome: string
  readonly ref: string
  readonly oid: string
  readonly [field: string]: unknown
}

export type MappedPick =
  | { readonly kind: 'empty'; readonly ref: string; readonly oid: string }
  | { readonly kind: 'applied'; readonly name: 'cherry_pick' | 'revert'; readonly ref: string; readonly oid: string; readonly oldOid: string | null; readonly tree: string | null; readonly pushBytes: number }

/**
 * ply's pick result. `empty`, `ok`, and `kept_empty` are the whole `PickOutcome` union. Any other string is an
 * internal error (HTTP 500), not a guessed success. `merge_conflict` is not a result: ply throws it, and the status
 * table maps that code to 409.
 */
export function mapPickOutcome(result: PlyPickResult, revert: boolean): MappedPick {
  if (result.outcome === OUTCOME_EMPTY) return { kind: 'empty', ref: result.ref, oid: result.oid }
  if (result.outcome === OUTCOME_OK || result.outcome === OUTCOME_KEPT) {
    return {
      kind: 'applied',
      name: revert ? 'revert' : 'cherry_pick',
      ref: result.ref,
      oid: result.oid,
      oldOid: firstPresent(result, ['onto'], null) as string | null,
      tree: firstPresent(result, ['tree'], null) as string | null,
      pushBytes: firstPresent(result, ['pushBytes'], 0) as number,
    }
  }
  throw fail('internal', `unexpected ${revert ? 'revert' : 'cherry-pick'} outcome ${result.outcome}`)
}

function emptyResult(ref: string, oid: string): Record<string, unknown> {
  return writeResult('empty', ref, oid, oid, {})
}

export async function pick(remote: string, opts: CallOpts, spec: { ref: string; commit: string; committer: Stamp; message: string | null; allowEmpty: boolean; revert: boolean }): Promise<Record<string, unknown>> {
  const run = spec.revert ? revertCommit : cherryPick
  const result = await run(remote, {
    ref: spec.ref,
    commit: spec.commit,
    committer: { name: spec.committer.name, email: spec.committer.email, tz: spec.committer.tz, time: spec.committer.time },
    message: spec.message,
    empty: spec.allowEmpty ? 'keep' : 'stop',
  }, opts) as PlyPickResult
  const mapped = mapPickOutcome(result, spec.revert)
  if (mapped.kind === 'empty') return emptyResult(mapped.ref, mapped.oid)
  return writeResult(mapped.name, mapped.ref, mapped.oid, mapped.oldOid, { tree: mapped.tree, pushBytes: mapped.pushBytes })
}
