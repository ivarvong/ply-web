// The /v1 write handlers. Parsing that can fail with bad_request happens before a transport is opened.
// An unborn HEAD is read only when a call needs the default branch or a not_found might be that empty ref.
import { fail, mergeBranch, operation, parseCommitId, readCommit, rebaseBranch } from 'ply'
import { type CallOpts } from './call.ts'
import { createBranch, deleteRef } from './branch.ts'
import { commitEdit } from './commit.ts'
import { noteUnbornAdvertised, readHead, type HeadState } from './head.ts'
import { nowSeconds, plyStamp, stamp } from './identity.ts'
import { pick } from './pick.ts'
import { asBody, branchRef, parseDeleteOid, parseEdit, refOrCommit, sameBranch } from './request.ts'
import { unifyPly, type WriteOutcome } from './result.ts'
import { createTag, removeTag } from './tag.ts'

async function readHeadState(remote: string, opts: CallOpts, op: string): Promise<HeadState> {
  return operation(op, remote, opts, async ({ t, outcome }) => outcome('ok', await readHead(t)))
}

async function bornRef(remote: string, opts: CallOpts, field: string): Promise<string> {
  const head = await readHeadState(remote, opts, 'head')
  if (head.kind === 'born') return head.ref
  if (head.kind === 'unborn') throw fail('bad_request', `${field} is required when the remote HEAD is unborn (${head.ref})`)
  if (head.kind === 'detached') throw fail('bad_request', `${field} is required when the remote HEAD is detached`)
  throw fail('bad_request', `${field} is required when the remote HEAD is absent`)
}

async function requireRef(remote: string, opts: CallOpts, given: unknown, field: string, parse: (value: unknown, name: string) => string = branchRef): Promise<string> {
  if (given !== undefined && given !== null && given !== '') return parse(given, field)
  return bornRef(remote, opts, field)
}

async function clarifyUnborn(remote: string, opts: CallOpts, err: unknown, verb: string): Promise<unknown> {
  if ((err as { code?: string })?.code !== 'not_found') return err
  const message = String((err as { message?: string })?.message ?? '')
  try {
    const head = await readHeadState(remote, opts, 'head')
    if (head.kind === 'unborn' && message.includes(head.ref)) return fail('not_found', `ref ${head.ref} is unborn; create a commit before ${verb}`, { miss: { kind: 'head_unborn', target: head.ref } })
  } catch { /* the original not_found names whatever the remote actually rejected */ }
  return err
}

function textOr(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw fail('bad_request', `${field} must be a string`)
  return value
}

export async function handleEdit(remote: string, body: unknown, opts: CallOpts): Promise<{ body: Record<string, unknown> }> {
  return { body: await commitEdit(remote, parseEdit(asBody(body), nowSeconds()), opts) }
}

export async function handleBranchCreate(remote: string, body: unknown, opts: CallOpts): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = asBody(body)
  return { status: 201, body: await createBranch(remote, raw.ref, raw.from, opts) }
}

export async function handleBranchDelete(remote: string, body: unknown, opts: CallOpts): Promise<{ body: Record<string, unknown> }> {
  const raw = asBody(body)
  return { body: await deleteRef(remote, branchRef(raw.ref, 'ref'), parseDeleteOid(raw.oid), opts, 'branch_delete') }
}

export async function handleMerge(remote: string, body: unknown, opts: CallOpts): Promise<{ body: Record<string, unknown> }> {
  const raw = asBody(body)
  const ref = await requireRef(remote, opts, raw.ref, 'ref')
  const from = refOrCommit(raw.from, 'from')
  const now = nowSeconds()
  const author = raw.author === undefined ? null : stamp(raw.author, 'author', now)
  const committer = raw.committer === undefined ? null : stamp(raw.committer, 'committer', now)
  const message = textOr(raw.message, 'message')
  try {
    const result = await mergeBranch(remote, {
      ref,
      from,
      author: author ? plyStamp(author) : undefined,
      committer: committer ? plyStamp(committer) : undefined,
      message,
      fastForwardOnly: !!raw.fastForwardOnly,
      noFastForward: !!raw.noFastForward,
    }, opts) as Record<string, unknown>
    const outcome = (typeof result.outcome === 'string' ? result.outcome : 'merge') as WriteOutcome
    return { body: unifyPly(result, outcome, ref) }
  } catch (e) {
    throw await clarifyUnborn(remote, opts, e, 'merging')
  }
}

export async function handleRebase(remote: string, body: unknown, opts: CallOpts): Promise<{ body: Record<string, unknown> }> {
  const raw = asBody(body)
  const ref = branchRef(raw.ref, 'ref')
  const onto = await requireRef(remote, opts, raw.onto, 'onto', refOrCommit)
  const now = nowSeconds()
  const committer = stamp(raw.committer, 'committer', now)
  const author = raw.author === undefined ? null : stamp(raw.author, 'author', now)
  const message = raw.message === undefined ? null : textOr(raw.message, 'message') ?? null
  try {
    const result = await rebaseBranch(remote, {
      ref,
      onto,
      committer: plyStamp(committer),
      author: author ? plyStamp(author) : undefined,
      squash: !!raw.squash,
      message,
    }, opts) as Record<string, unknown>
    const outcome = (typeof result.outcome === 'string' ? result.outcome : 'rebase') as WriteOutcome
    return { body: unifyPly(result, outcome, ref) }
  } catch (e) {
    throw await clarifyUnborn(remote, opts, e, 'rebasing')
  }
}

async function handlePick(remote: string, body: unknown, opts: CallOpts, revert: boolean): Promise<{ body: Record<string, unknown> }> {
  const raw = asBody(body)
  const ref = await requireRef(remote, opts, raw.ref, 'ref')
  const parsed = parseCommitId(raw.commit)
  if (!parsed.ok) throw parsed.error
  const commit = parsed.value
  const committer = stamp(raw.committer, 'committer', nowSeconds())
  if (raw.allowEmpty !== undefined && typeof raw.allowEmpty !== 'boolean') throw fail('bad_request', 'allowEmpty must be true or false')
  const message = raw.message === undefined || raw.message === null ? null : textOr(raw.message, 'message') ?? null
  try {
    return { body: await pick(remote, opts, { ref, commit, committer, message, allowEmpty: raw.allowEmpty === true, revert }) }
  } catch (e) {
    throw await clarifyUnborn(remote, opts, e, revert ? 'reverting' : 'cherry-picking')
  }
}

export const handleCherryPick = (remote: string, body: unknown, opts: CallOpts) => handlePick(remote, body, opts, false)
export const handleRevert = (remote: string, body: unknown, opts: CallOpts) => handlePick(remote, body, opts, true)

export const handleTagCreate = async (remote: string, body: unknown, opts: CallOpts) => ({ status: 201, body: await createTag(remote, body, opts) })
export const handleTagDelete = async (remote: string, body: unknown, opts: CallOpts) => ({ body: await removeTag(remote, body, opts) })

const EMPTY_COMMIT = { empty: true, oid: null, tree: null, parents: [], author: null, committer: null, message: null, signed: false }

/** A born commit is ply's readCommit body, unchanged. An unborn HEAD (or that same branch by name) is the empty-repo body. */
export async function readCommitOrEmpty(remote: string, ref: string | null, opts: CallOpts): Promise<Record<string, unknown>> {
  try {
    // The declaration types `ref` as null, which is only the default. A branch name or oid is what readCommit resolves.
    // ply returns `{ empty: true, ref }` for an unborn HEAD. The documented body also carries the null commit fields.
    const read = await readCommit(remote, { ref } as { ref?: null }, opts)
    if ('empty' in read) {
      noteUnbornAdvertised(remote)
      return { ...EMPTY_COMMIT, ref: read.ref }
    }
    return read
  } catch (e) {
    if ((e as { code?: string })?.code !== 'not_found') throw e
    try {
      const head = await readHeadState(remote, opts, 'read_commit')
      const wanted = ref ?? ''
      if (head.kind === 'unborn' && (wanted === '' || wanted === 'HEAD' || sameBranch(wanted, head.ref))) return { ...EMPTY_COMMIT, ref: head.ref }
    } catch { /* a missing repository stays the original not_found */ }
    throw e
  }
}

/** Extra fields for GET /v1/refs when ply's ls-refs could not see an unborn HEAD. Born repositories are unchanged. */
export async function unbornFields(remote: string, opts: CallOpts, head: string | null): Promise<Record<string, unknown>> {
  if (head) return {}
  try {
    const state = await readHeadState(remote, opts, 'head')
    if (state.kind === 'unborn') return { empty: true, unborn: state.ref }
  } catch { /* the ref list itself succeeded; head stays null */ }
  return {}
}
