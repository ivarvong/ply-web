// Create or delete a ref. `from: 000…0` is rejected before any transport is opened, so nothing is pushed.
// An existing ref is ref_exists (retry no). A delete whose expected oid is stale is stale_expected and carries
// the oid the ref actually points at.
import { plyError, fetchCommit, operation, parseOid, parseRefname, push, resolveCommit, ZERO_OID } from 'ply'
import { fromNullable } from '../absent.ts'
import { err, ok, type Result } from '../http/machine.ts'
import { type PlyError } from '../ply-result.ts'
import { advertisedOid } from './advertised.ts'
import { type CallOpts, type GitOutcome, type GitSpan, type GitTransport } from './call.ts'
import { assertNever, refExists, staleExpected } from './errors.ts'
import { readHead } from './head.ts'
import { branchRef } from './request.ts'
import { writeResult } from './result.ts'

type Transport = GitTransport
type Root = GitSpan
type Outcome = GitOutcome

async function tipOf(t: Transport, from: string): Promise<Result<string, PlyError>> {
  if (parseOid(from).ok) {
    const fetched = await fetchCommit(t, from)
    if (!fetched.ok) {
      const error = fetched.error
      if (error.code === 'not_found' && error.miss) {
        // fetchCommit's not_found is a commit miss. Every kind stays that error: not_found is 404, message unchanged.
        switch (error.miss.kind) {
          case 'commit':
          case 'head_absent':
          case 'head_unborn':
          case 'is_directory':
          case 'not_directory':
          case 'path':
          case 'ref':
          case 'repository':
          case 'submodule':
            return err(error)
          default:
            return assertNever(error.miss)
        }
      }
      return err(error)
    }
    return ok(from)
  }
  const resolved = await resolveCommit(t, from)
  return resolved.ok ? ok(resolved.value.commit) : resolved
}

// readHead runs in its own span (tracer.span records a throw), so its failure is thrown and operation() returns it.
async function bornTip(t: Transport): Promise<string> {
  const head = await readHead(t)
  if (head.kind === 'born') return head.oid
  if (head.kind === 'unborn') throw plyError('bad_request', `from is required when the remote HEAD is unborn (${head.ref})`)
  if (head.kind === 'detached') throw plyError('bad_request', 'from is required when the remote HEAD is detached')
  throw plyError('bad_request', 'from is required when the remote HEAD is absent')
}

// The Worker's own errors (ref_exists, stale_expected) are not PlyErrors, so an operation() body cannot return them
// in its Err: they are thrown, and operation() records them on the root span and rethrows them to index.js.
export async function createBranch(remote: string, refName: unknown, from: unknown, opts: CallOpts): Promise<Result<Record<string, unknown>, PlyError>> {
  const ref = branchRef(refName, 'ref')
  // Zero is refused here, before operation() opens a transport, so receive-pack is never called.
  if (from === ZERO_OID) throw plyError('bad_request', 'from must not be the zero oid')
  const present = fromNullable(from)
  if (present.tag === 'some' && present.value !== '' && typeof present.value !== 'string') throw plyError('bad_request', 'from must be a branch name or a commit id')
  const specified = typeof from === 'string' && from !== '' ? from : null
  return operation<Record<string, unknown>>('branch_create', remote, { ...opts, attrs: { 'git.branch_create.ref': ref } }, async ({ t, root, outcome }: { t: Transport; root: Root; outcome: Outcome }) => {
    const existing = await advertisedOid(t, ref)
    if (!existing.ok) return existing
    if (existing.value) throw refExists(ref, existing.value)
    const tip = specified === null ? ok(await bornTip(t)) : await tipOf(t, specified)
    if (!tip.ok) return tip
    const commit = tip.value
    root.set({ 'git.branch_create.oid': commit })
    const name = parseRefname(ref)
    if (!name.ok) return name
    const pushed = await push(t, { ref: name.value, oldOid: ZERO_OID, newOid: commit, objects: [] })
    if (!pushed.ok) {
      if (pushed.error.code !== 'cas_conflict') return pushed
      const cur = await advertisedOid(t, ref)
      if (!cur.ok) return cur
      throw refExists(ref, cur.value === null ? commit : cur.value)
    }
    return outcome('created', writeResult('created', ref, commit, null, { pushBytes: pushed.value.packBytes }))
  })
}

export async function deleteRef(remote: string, ref: string, expected: string | null, opts: CallOpts, op: 'branch_delete' | 'tag_delete'): Promise<Result<Record<string, unknown>, PlyError>> {
  return operation<Record<string, unknown>>(op, remote, { ...opts, attrs: { [`git.${op}.ref`]: ref } }, async ({ t, root, outcome }: { t: Transport; root: Root; outcome: Outcome }) => {
    const advertised = await advertisedOid(t, ref)
    if (!advertised.ok) return advertised
    const current = advertised.value
    if (!current) return err(plyError('not_found', `ref ${ref} not found`, { miss: { kind: 'ref', ref, candidates: [ref] } }))
    if (expected && expected !== current) throw staleExpected(ref, expected, current)
    root.set({ [`git.${op}.oid`]: current, [`git.${op}.cas_from_caller`]: expected !== null })
    const name = parseRefname(ref)
    if (!name.ok) return name
    const pushed = await push(t, { ref: name.value, oldOid: current, newOid: ZERO_OID, objects: [] })
    if (!pushed.ok) {
      if (pushed.error.code !== 'cas_conflict') return pushed
      const now = await advertisedOid(t, ref)
      if (!now.ok) return now
      throw staleExpected(ref, expected === null ? current : expected, now.value === null ? current : now.value)
    }
    return outcome('deleted', writeResult('deleted', ref, null, current, { deleted: current }))
  })
}
