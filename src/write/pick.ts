// Cherry-pick and revert. ply reports a merge_conflict for an already-applied rename (deleted on both sides
// while paths were added) where git says the pick is empty. When every path the commit changed already has the
// commit's post-image in the target tree, this returns outcome `empty` instead. `allowEmpty` writes that empty
// commit (same tree, new commit). A real conflict, where the post-image does not match, stays a merge_conflict.
import { cherryPick, encodeCommit, fail, fetchObject, hashObject, lsRefs, operation, parseCommit, parseTree, push, revertCommit, TYPE } from 'ply'
import { arrayBufferBytes } from './bytes.ts'
import { type CallOpts, type GitOutcome, type GitTransport } from './call.ts'
import { MODE_TREE } from './constants.ts'
import { type Stamp } from './identity.ts'
import { writeResult } from './result.ts'

type Transport = GitTransport
type Entry = { readonly mode: string; readonly oid: string }
type Outcome = GitOutcome

function messageBody(message: string): string {
  return message.endsWith('\n') ? message : `${message}\n`
}

async function load(t: Transport, oid: string): Promise<{ tree: string; parents: string[]; author: string; message: string | null }> {
  const obj = await fetchObject(t, { oid, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT })
  return parseCommit(obj.data, t.limits) as { tree: string; parents: string[]; author: string; message: string | null }
}

async function treeMap(t: Transport, oid: string, cache: Map<string, Map<string, Entry>>): Promise<Map<string, Entry>> {
  const held = cache.get(oid)
  if (held) return held
  const obj = await fetchObject(t, { oid, filter: 'tree:0', expectType: TYPE.TREE })
  const entries = parseTree(obj.data, t.limits) as { name: string; mode: string; oid: string }[]
  const map = new Map<string, Entry>()
  for (const entry of entries) map.set(entry.name, { mode: entry.mode, oid: entry.oid })
  cache.set(oid, map)
  return map
}

const keyOf = (entry: Entry | null) => (entry ? `${entry.mode} ${entry.oid}` : '')

/** Paths that differ between `base` and `post` must already equal `post` in `target`. Unchanged paths are free. */
async function imagesMatch(t: Transport, base: string | null, post: string | null, target: string | null, cache: Map<string, Map<string, Entry>>): Promise<boolean> {
  if (base === post || post === target) return true
  const [b, p, g] = await Promise.all([
    base ? treeMap(t, base, cache) : new Map<string, Entry>(),
    post ? treeMap(t, post, cache) : new Map<string, Entry>(),
    target ? treeMap(t, target, cache) : new Map<string, Entry>(),
  ])
  const names = new Set<string>([...b.keys(), ...p.keys()])
  for (const name of names) {
    const before = b.get(name) ?? null
    const after = p.get(name) ?? null
    const got = g.get(name) ?? null
    if (keyOf(before) === keyOf(after)) continue
    if (before?.mode === MODE_TREE && after?.mode === MODE_TREE) {
      const next = got?.mode === MODE_TREE ? got.oid : null
      if (!(await imagesMatch(t, before.oid, after.oid, next, cache))) return false
      continue
    }
    if (keyOf(after) !== keyOf(got)) return false
  }
  return true
}

export type Applied = { readonly applied: false } | { readonly applied: true; readonly oid: string }

/** True when the pick would change nothing because the target tree already has the commit's post-image. */
export async function patchApplied(t: Transport, ref: string, commit: string, revert: boolean): Promise<Applied> {
  const tip = (await lsRefs(t, [ref])).refs.get(ref)?.oid as string | undefined
  if (!tip) return { applied: false }
  const target = await load(t, tip)
  const picked = await load(t, commit)
  if (picked.parents.length !== 1) return { applied: false }
  const parentOid = picked.parents[0]
  if (!parentOid) return { applied: false }
  const parent = await load(t, parentOid)
  const base = revert ? picked.tree : parent.tree
  const post = revert ? parent.tree : picked.tree
  const applied = await imagesMatch(t, base, post, target.tree, new Map())
  return applied ? { applied: true, oid: tip } : { applied: false }
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
    const pushed = await push(t, { ref, oldOid: tip, newOid: oid, objects: [{ type: TYPE.COMMIT, data: arrayBufferBytes(data) }] })
    return outcome(op, writeResult(revert ? 'revert' : 'cherry_pick', ref, oid, tip, { tree: target.tree, pushBytes: pushed.packBytes }))
  }) as Promise<Record<string, unknown>>
}

export async function pick(remote: string, opts: CallOpts, spec: { ref: string; commit: string; committer: Stamp; message: string | null; allowEmpty: boolean; revert: boolean }): Promise<Record<string, unknown>> {
  const run = spec.revert ? revertCommit : cherryPick
  try {
    const result = await run(remote, {
      ref: spec.ref,
      commit: spec.commit,
      committer: { name: spec.committer.name, email: spec.committer.email, tz: spec.committer.tz },
      time: spec.committer.time,
      message: spec.message,
    }, opts) as { outcome: string; ref: string; oid: string; tree?: string; onto?: string; pushBytes?: number }
    if (result.outcome === 'empty') {
      if (spec.allowEmpty) return writeEmpty(remote, opts, spec.ref, spec.commit, spec.committer, spec.message, spec.revert)
      return emptyResult(result.ref, result.oid)
    }
    const outcome = spec.revert ? 'revert' : 'cherry_pick'
    return writeResult(outcome, result.ref, result.oid, result.onto ?? null, { tree: result.tree ?? null, pushBytes: result.pushBytes ?? 0 })
  } catch (e) {
    if ((e as { code?: string })?.code !== 'merge_conflict') throw e
    const applied = await operation(spec.revert ? 'revert' : 'cherry_pick', remote, opts, async ({ t, outcome }: { t: Transport; outcome: Outcome }) => outcome('empty', await patchApplied(t, spec.ref, spec.commit, spec.revert))) as Applied
    if (!applied.applied) throw e
    if (spec.allowEmpty) return writeEmpty(remote, opts, spec.ref, spec.commit, spec.committer, spec.message, spec.revert)
    return emptyResult(spec.ref, applied.oid)
  }
}
