// Create or delete a ref. `from: 000…0` is rejected before any transport is opened, so nothing is pushed.
// An existing ref is ref_exists (retry no). A delete whose expected oid is stale is stale_expected and carries
// the oid the ref actually points at.
import { fail, fetchObject, lsRefs, operation, push, resolveCommit, TYPE, ZERO_OID } from 'ply'
import { type CallOpts, type GitOutcome, type GitSpan, type GitTransport } from './call.ts'
import { refExists, staleExpected } from './errors.ts'
import { readHead } from './head.ts'
import { isOid, isZeroOid } from './oid.ts'
import { branchRef } from './request.ts'
import { writeResult } from './result.ts'

type Transport = GitTransport
type Root = GitSpan
type Outcome = GitOutcome

async function tipOf(t: Transport, from: string): Promise<string> {
  if (isOid(from)) {
    try {
      await fetchObject(t, { oid: from, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT })
    } catch (e) {
      const code = (e as { code?: string })?.code
      if (code === 'pack_corrupt' || code === 'remote_error' || code === 'not_found') throw fail('not_found', `commit ${from} not found`)
      throw e
    }
    return from
  }
  return (await resolveCommit(t, from) as { commit: string }).commit
}

async function bornTip(t: Transport): Promise<string> {
  const head = await readHead(t)
  if (head.kind === 'born') return head.oid
  if (head.kind === 'unborn') throw fail('bad_request', `from is required when the remote HEAD is unborn (${head.ref})`)
  if (head.kind === 'detached') throw fail('bad_request', 'from is required when the remote HEAD is detached')
  throw fail('bad_request', 'from is required when the remote HEAD is absent')
}

export async function createBranch(remote: string, refName: unknown, from: unknown, opts: CallOpts): Promise<Record<string, unknown>> {
  const ref = branchRef(refName, 'ref')
  // Zero is refused here, before operation() opens a transport, so receive-pack is never called.
  if (isZeroOid(from)) throw fail('bad_request', 'from must not be the zero oid')
  if (from !== undefined && from !== null && from !== '' && typeof from !== 'string') throw fail('bad_request', 'from must be a branch name or a commit id')
  const specified = typeof from === 'string' && from !== '' ? from : null
  return operation('branch_create', remote, { ...opts, attrs: { 'git.branch_create.ref': ref } }, async ({ t, root, outcome }: { t: Transport; root: Root; outcome: Outcome }) => {
    const existing = (await lsRefs(t, [ref])).refs.get(ref)?.oid as string | undefined
    if (existing) throw refExists(ref, existing)
    const commit = specified === null ? await bornTip(t) : await tipOf(t, specified)
    root.set({ 'git.branch_create.oid': commit })
    try {
      const pushed = await push(t, { ref, oldOid: ZERO_OID, newOid: commit, objects: [] }) as { packBytes: number }
      return outcome('created', writeResult('created', ref, commit, null, { pushBytes: pushed.packBytes }))
    } catch (e) {
      if ((e as { code?: string })?.code === 'cas_conflict') {
        const cur = (await lsRefs(t, [ref])).refs.get(ref)?.oid as string | undefined
        throw refExists(ref, cur ?? commit)
      }
      throw e
    }
  }) as Promise<Record<string, unknown>>
}

export async function deleteRef(remote: string, ref: string, expected: string | null, opts: CallOpts, op: 'branch_delete' | 'tag_delete'): Promise<Record<string, unknown>> {
  return operation(op, remote, { ...opts, attrs: { [`git.${op}.ref`]: ref } }, async ({ t, root, outcome }: { t: Transport; root: Root; outcome: Outcome }) => {
    const current = (await lsRefs(t, [ref])).refs.get(ref)?.oid as string | undefined
    if (!current) throw fail('not_found', `ref ${ref} not found`)
    if (expected && expected !== current) throw staleExpected(ref, expected, current)
    root.set({ [`git.${op}.oid`]: current, [`git.${op}.cas_from_caller`]: expected !== null })
    try {
      await push(t, { ref, oldOid: current, newOid: ZERO_OID, objects: [] })
    } catch (e) {
      if ((e as { code?: string })?.code !== 'cas_conflict') throw e
      const now = (await lsRefs(t, [ref])).refs.get(ref)?.oid as string | undefined
      throw staleExpected(ref, expected ?? current, now ?? current)
    }
    return outcome('deleted', writeResult('deleted', ref, null, current, { deleted: current }))
  }) as Promise<Record<string, unknown>>
}
