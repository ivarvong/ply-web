// The /v1 write handlers. Parsing that can fail with bad_request happens before a transport is opened, and throws
// (index.js answers it). Every ply call's failure is its Err, returned to index.js as this handler's Result.
// An unborn HEAD is read only when a call needs the default branch or a not_found might be that empty ref.
import { plyError, mergeBranch, operation, parseCommitId, readCommit, rebaseBranch } from 'ply'
import { type PlyError } from '../ply-result.ts'
import { fromNullable, recordGet } from '../absent.ts'
import { err, ok, type Result } from '../http/machine.ts'
import { type CallOpts } from './call.ts'
import { createBranch, deleteRef } from './branch.ts'
import { commitEdit } from './commit.ts'
import { noteUnbornAdvertised, readHead, type HeadState } from './head.ts'
import { nowSeconds, plyStamp, stamp } from './identity.ts'
import { pick } from './pick.ts'
import { asBody, branchRef, parseDeleteOid, parseEdit, refOrCommit, sameBranch } from './request.ts'
import { unifyPly, type WriteOutcome } from './result.ts'
import { createTag, removeTag } from './tag.ts'

async function readHeadState(remote: string, opts: CallOpts, op: string): Promise<Result<HeadState, PlyError>> {
  return operation(op, remote, opts, async ({ t, outcome }) => outcome('ok', await readHead(t)))
}

async function bornRef(remote: string, opts: CallOpts, field: string): Promise<Result<string, PlyError>> {
  const read = await readHeadState(remote, opts, 'head')
  if (!read.ok) return read
  const head = read.value
  if (head.kind === 'born') return ok(head.ref)
  if (head.kind === 'unborn') return err(plyError('bad_request', `${field} is required when the remote HEAD is unborn (${head.ref})`))
  if (head.kind === 'detached') return err(plyError('bad_request', `${field} is required when the remote HEAD is detached`))
  return err(plyError('bad_request', `${field} is required when the remote HEAD is absent`))
}

async function requireRef(remote: string, opts: CallOpts, given: unknown, field: string, parse: (value: unknown, name: string) => string = branchRef): Promise<Result<string, PlyError>> {
  const present = fromNullable(given)
  if (present.tag === 'some' && present.value !== '') return ok(parse(present.value, field))
  return bornRef(remote, opts, field)
}

/** A not_found on an unborn HEAD's own ref says so. A failed HEAD read keeps the original not_found. */
async function clarifyUnborn(remote: string, opts: CallOpts, error: PlyError, verb: string): Promise<PlyError> {
  if (error.code !== 'not_found') return error
  const read = await readHeadState(remote, opts, 'head')
  if (read.ok && read.value.kind === 'unborn' && error.message.includes(read.value.ref)) {
    return plyError('not_found', `ref ${read.value.ref} is unborn; create a commit before ${verb}`, { miss: { kind: 'head_unborn', target: read.value.ref } })
  }
  return error
}

function textOr(value: unknown, field: string): string | null {
  const found = fromNullable(value)
  if (found.tag === 'none') return null
  if (typeof found.value !== 'string') throw plyError('bad_request', `${field} must be a string`)
  return found.value
}

function optionalStamp(raw: Record<string, unknown>, key: string, field: string, now: ReturnType<typeof nowSeconds>) {
  const found = recordGet(raw, key)
  if (found.tag === 'none') return null
  return stamp(found.value, field, now)
}

type Reply = { readonly body: Record<string, unknown> } | { readonly status: number; readonly body: Record<string, unknown> }
type Handled = Promise<Result<Reply, PlyError>>

const replied = (r: Result<Record<string, unknown>, PlyError>, status: number | null = null): Result<Reply, PlyError> =>
  r.ok ? ok(status === null ? { body: r.value } : { status, body: r.value }) : r

export async function handleEdit(remote: string, body: unknown, opts: CallOpts): Handled {
  return replied(await commitEdit(remote, parseEdit(asBody(body), nowSeconds()), opts))
}

export async function handleBranchCreate(remote: string, body: unknown, opts: CallOpts): Handled {
  const raw = asBody(body)
  return replied(await createBranch(remote, raw.ref, raw.from, opts), 201)
}

export async function handleBranchDelete(remote: string, body: unknown, opts: CallOpts): Handled {
  const raw = asBody(body)
  return replied(await deleteRef(remote, branchRef(raw.ref, 'ref'), parseDeleteOid(raw.oid), opts, 'branch_delete'))
}

export async function handleMerge(remote: string, body: unknown, opts: CallOpts): Handled {
  const raw = asBody(body)
  const required = await requireRef(remote, opts, raw.ref, 'ref')
  if (!required.ok) return required
  const ref = required.value
  const from = refOrCommit(raw.from, 'from')
  const now = nowSeconds()
  const author = optionalStamp(raw, 'author', 'author', now)
  const committer = optionalStamp(raw, 'committer', 'committer', now)
  const message = textOr(raw.message, 'message')
  const merged = await mergeBranch(remote, {
    ref,
    from,
    ...(author === null ? {} : { author: plyStamp(author) }),
    ...(committer === null ? {} : { committer: plyStamp(committer) }),
    message,
    fastForwardOnly: !!raw.fastForwardOnly,
    noFastForward: !!raw.noFastForward,
  }, opts)
  if (!merged.ok) return err(await clarifyUnborn(remote, opts, merged.error, 'merging'))
  const result = merged.value as Record<string, unknown>
  const outcome = (typeof result.outcome === 'string' ? result.outcome : 'merge') as WriteOutcome
  return ok({ body: unifyPly(result, outcome, ref) })
}

export async function handleRebase(remote: string, body: unknown, opts: CallOpts): Handled {
  const raw = asBody(body)
  const ref = branchRef(raw.ref, 'ref')
  const required = await requireRef(remote, opts, raw.onto, 'onto', refOrCommit)
  if (!required.ok) return required
  const onto = required.value
  const now = nowSeconds()
  const committer = stamp(raw.committer, 'committer', now)
  const author = optionalStamp(raw, 'author', 'author', now)
  const message = textOr(raw.message, 'message')
  const rebased = await rebaseBranch(remote, {
    ref,
    onto,
    committer: plyStamp(committer),
    ...(author === null ? {} : { author: plyStamp(author) }),
    squash: !!raw.squash,
    message,
  }, opts)
  if (!rebased.ok) return err(await clarifyUnborn(remote, opts, rebased.error, 'rebasing'))
  const result = rebased.value as Record<string, unknown>
  const outcome = (typeof result.outcome === 'string' ? result.outcome : 'rebase') as WriteOutcome
  return ok({ body: unifyPly(result, outcome, ref) })
}

async function handlePick(remote: string, body: unknown, opts: CallOpts, revert: boolean): Handled {
  const raw = asBody(body)
  const required = await requireRef(remote, opts, raw.ref, 'ref')
  if (!required.ok) return required
  const ref = required.value
  const parsed = parseCommitId(raw.commit)
  if (!parsed.ok) throw parsed.error
  const commit = parsed.value
  const committer = stamp(raw.committer, 'committer', nowSeconds())
  const allowEmpty = recordGet(raw, 'allowEmpty')
  if (allowEmpty.tag === 'some' && typeof allowEmpty.value !== 'boolean') throw plyError('bad_request', 'allowEmpty must be true or false')
  const message = textOr(raw.message, 'message')
  const picked = await pick(remote, opts, { ref, commit, committer, message, allowEmpty: allowEmpty.tag === 'some' && allowEmpty.value === true, revert })
  if (!picked.ok) return err(await clarifyUnborn(remote, opts, picked.error, revert ? 'reverting' : 'cherry-picking'))
  return ok({ body: picked.value })
}

export const handleCherryPick = (remote: string, body: unknown, opts: CallOpts) => handlePick(remote, body, opts, false)
export const handleRevert = (remote: string, body: unknown, opts: CallOpts) => handlePick(remote, body, opts, true)

export const handleTagCreate = async (remote: string, body: unknown, opts: CallOpts): Handled => replied(await createTag(remote, body, opts), 201)
export const handleTagDelete = async (remote: string, body: unknown, opts: CallOpts): Handled => replied(await removeTag(remote, body, opts))

const EMPTY_COMMIT = { empty: true, oid: null, tree: null, parents: [], author: null, committer: null, message: null, signed: false }

/** A born commit is ply's readCommit body, unchanged. An unborn HEAD (or that same branch by name) is the empty-repo body. */
export async function readCommitOrEmpty(remote: string, ref: string | null, opts: CallOpts): Promise<Result<Record<string, unknown>, PlyError>> {
  // A branch name or oid is what readCommit resolves. Omitting ref is ply's default.
  // ply returns `{ empty: true, ref }` for an unborn HEAD. The documented body also carries the null commit fields.
  const read = await readCommit(remote, { ref }, opts as Parameters<typeof readCommit>[2])
  if (read.ok) {
    if ('empty' in read.value) {
      noteUnbornAdvertised(remote)
      return ok({ ...EMPTY_COMMIT, ref: read.value.ref })
    }
    return ok(read.value)
  }
  if (read.error.code !== 'not_found') return read
  // A failed HEAD read (a missing repository) keeps the original not_found.
  const head = await readHeadState(remote, opts, 'read_commit')
  const wanted = ref === null ? '' : ref
  if (head.ok && head.value.kind === 'unborn' && (wanted === '' || wanted === 'HEAD' || sameBranch(wanted, head.value.ref))) return ok({ ...EMPTY_COMMIT, ref: head.value.ref })
  return read
}

/** Extra fields for GET /v1/refs when ply's ls-refs could not see an unborn HEAD. Born repositories are unchanged. */
export async function unbornFields(remote: string, opts: CallOpts, head: string | null): Promise<Record<string, unknown>> {
  if (head) return {}
  // A failed HEAD read changes nothing: the ref list itself succeeded, and head stays null.
  const state = await readHeadState(remote, opts, 'head')
  if (state.ok && state.value.kind === 'unborn') return { empty: true, unborn: state.value.ref }
  return {}
}
