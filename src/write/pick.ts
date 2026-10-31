// Cherry-pick and revert.
//
// ply returns `{outcome:'empty'}` when the transplanted tree equals the target tree and the rename guard stands
// down: both sides added and deleted exactly the same paths (#103). A target that also has its own adds or deletes
// is `merge_conflict` (HTTP 409). ply-web used to report that wider case as empty, because it compared post-images
// and ignored the extra paths. `allowEmpty` still writes the empty commit (same tree, new commit). That is git's
// `--keep-redundant-commits`, which ply does not take yet (#117), so the commit is built here.
import { cherryPick, encodeCommit, fail, fetchObject, hashObject, lsRefs, operation, parseCommit, push, revertCommit, TYPE } from 'ply'
import { type CallOpts, type GitOutcome, type GitTransport } from './call.ts'
import { type Stamp } from './identity.ts'
import { writeResult } from './result.ts'

type Transport = GitTransport
type Outcome = GitOutcome

const OUTCOME_EMPTY = 'empty'
const OUTCOME_OK = 'ok'

export type PlyPickResult = {
  readonly outcome: string
  readonly ref: string
  readonly oid: string
  readonly tree?: string
  readonly onto?: string
  readonly pushBytes?: number
}

export type MappedPick =
  | { readonly kind: 'empty'; readonly ref: string; readonly oid: string }
  | { readonly kind: 'applied'; readonly name: 'cherry_pick' | 'revert'; readonly ref: string; readonly oid: string; readonly oldOid: string | null; readonly tree: string | null; readonly pushBytes: number }

/**
 * ply's pick result, and nothing else. `empty` and `ok` are the whole `PickOutcome` union. Any other string is an
 * internal error (HTTP 500), not a guessed success. `merge_conflict` is not a result: ply throws it, and the status
 * table maps that code to 409.
 */
export function mapPickOutcome(result: PlyPickResult, revert: boolean): MappedPick {
  if (result.outcome === OUTCOME_EMPTY) return { kind: 'empty', ref: result.ref, oid: result.oid }
  if (result.outcome === OUTCOME_OK) {
    return {
      kind: 'applied',
      name: revert ? 'revert' : 'cherry_pick',
      ref: result.ref,
      oid: result.oid,
      oldOid: result.onto ?? null,
      tree: result.tree ?? null,
      pushBytes: result.pushBytes ?? 0,
    }
  }
  throw fail('internal', `unexpected ${revert ? 'revert' : 'cherry-pick'} outcome ${result.outcome}`)
}

function messageBody(message: string): string {
  return message.endsWith('\n') ? message : `${message}\n`
}

async function load(t: Transport, oid: string): Promise<{ tree: string; parents: string[]; author: string; message: string | null }> {
  const obj = await fetchObject(t, { oid, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT })
  return parseCommit(obj.data, t.limits) as { tree: string; parents: string[]; author: string; message: string | null }
}

function emptyResult(ref: string, oid: string): Record<string, unknown> {
  return writeResult('empty', ref, oid, oid, {})
}

async function writeEmpty(remote: string, opts: CallOpts, ref: string, commit: string, who: Stamp, message: string | null, revert: boolean): Promise<Record<string, unknown>> {
  const op = revert ? 'revert' : 'cherry_pick'
  return operation(op, remote, { ...opts, attrs: { [`git.${op}.ref`]: ref, [`git.${op}.commit`]: commit, [`git.${op}.allow_empty`]: true } }, async ({ t, outcome }: { t: Transport; outcome: Outcome }) => {
    const tip = (await lsRefs(t, [ref])).refs.get(ref)?.oid as string | undefined
    if (!tip) throw fail('not_found', `ref ${ref} not found`)
    const [target, picked] = await Promise.all([load(t, tip), load(t, commit)])
    const subject = (picked.message ?? '').split('\n')[0] ?? ''
    const fallback = revert ? `Revert "${subject}"\n\nThis reverts commit ${commit}.\n` : (picked.message ?? '')
    const author = revert ? who.line : picked.author
    const data = encodeCommit({
      tree: target.tree,
      parents: [tip],
      author,
      committer: who.line,
      message: messageBody(message ?? fallback),
    })
    const oid = hashObject('commit', data)
    const pushed = await push(t, { ref, oldOid: tip, newOid: oid, objects: [{ type: TYPE.COMMIT, data }] })
    return outcome(op, writeResult(revert ? 'revert' : 'cherry_pick', ref, oid, tip, { tree: target.tree, pushBytes: pushed.packBytes }))
  }) as Promise<Record<string, unknown>>
}

export async function pick(remote: string, opts: CallOpts, spec: { ref: string; commit: string; committer: Stamp; message: string | null; allowEmpty: boolean; revert: boolean }): Promise<Record<string, unknown>> {
  const run = spec.revert ? revertCommit : cherryPick
  const result = await run(remote, {
    ref: spec.ref,
    commit: spec.commit,
    committer: { name: spec.committer.name, email: spec.committer.email, tz: spec.committer.tz, time: spec.committer.time },
    message: spec.message,
  }, opts) as PlyPickResult
  const mapped = mapPickOutcome(result, spec.revert)
  if (mapped.kind === 'empty') {
    if (spec.allowEmpty) return writeEmpty(remote, opts, spec.ref, spec.commit, spec.committer, spec.message, spec.revert)
    return emptyResult(mapped.ref, mapped.oid)
  }
  return writeResult(mapped.name, mapped.ref, mapped.oid, mapped.oldOid, { tree: mapped.tree, pushBytes: mapped.pushBytes })
}
