// The /v1 write handlers. Parsing that can fail with bad_request happens before a transport is opened.
// An unborn HEAD is read only when a call needs the default branch or a not_found might be that empty ref.
import { fail, mergeBranch, operation, readCommit, rebaseBranch } from 'ply'
import { createBranch, deleteRef } from './branch.ts'
import { commitEdit } from './commit.ts'
import { readHead, type HeadState, type HeadTransport } from './head.ts'
import { nowSeconds, plyPerson, stamp, type Stamp } from './identity.ts'
import { parseCommitOid } from './oid.ts'
import { pick } from './pick.ts'
import { asBody, branchRef, parseDeleteOid, parseEdit, sameBranch } from './request.ts'
import { unifyPly, type WriteOutcome } from './result.ts'
import { createTag, removeTag } from './tag.ts'

type OutcomeFn = (kind: string, value: HeadState) => HeadState

function sameStamp(a: Stamp, b: Stamp): boolean {
  return a.name === b.name && a.email === b.email && a.tz === b.tz && a.time === b.time
}

async function readHeadState(remote: string, opts: object, op: string): Promise<HeadState> {
  return operation(op, remote, opts, async ({ t, outcome }: { t: HeadTransport; outcome: OutcomeFn }) => outcome('ok', await readHead(t))) as Promise<HeadState>
}

async function bornRef(remote: string, opts: object, field: string): Promise<string> {
  const head = await readHeadState(remote, opts, 'head')
  if (head.kind === 'born') return head.ref
  if (head.kind === 'unborn') throw fail('bad_request', `${field} is required when the remote HEAD is unborn (${head.ref})`)
  if (head.kind === 'detached') throw fail('bad_request', `${field} is required when the remote HEAD is detached`)
  throw fail('bad_request', `${field} is required when the remote HEAD is absent`)
}

async function requireRef(remote: string, opts: object, given: unknown, field: string): Promise<string> {
  if (given !== undefined && given !== null && given !== '') return branchRef(given, field)
  return bornRef(remote, opts, field)
}

async function clarifyUnborn(remote: string, opts: object, err: unknown, verb: string): Promise<unknown> {
  if ((err as { code?: string })?.code !== 'not_found') return err
  const message = String((err as { message?: string })?.message ?? '')
  try {
    const head = await readHeadState(remote, opts, 'head')
    if (head.kind === 'unborn' && message.includes(head.ref)) return fail('not_found', `ref ${head.ref} is unborn; create a commit before ${verb}`)
  } catch { /* the original not_found names whatever the remote actually rejected */ }
  return err
}

function textOr(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw fail('bad_request', `${field} must be a string`)
  return value
}

export async function handleEdit(remote: string, body: unknown, opts: object): Promise<{ body: Record<string, unknown> }> {
  return { body: await commitEdit(remote, parseEdit(asBody(body), nowSeconds()), opts) }
}

export async function handleBranchCreate(remote: string, body: unknown, opts: object): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = asBody(body)
  return { status: 201, body: await createBranch(remote, raw.ref, raw.from, opts) }
}

export async function handleBranchDelete(remote: string, body: unknown, opts: object): Promise<{ body: Record<string, unknown> }> {
  const raw = asBody(body)
  return { body: await deleteRef(remote, branchRef(raw.ref, 'ref'), parseDeleteOid(raw.oid), opts, 'branch_delete') }
}

export async function handleMerge(remote: string, body: unknown, opts: object): Promise<{ body: Record<string, unknown> }> {
  const raw = asBody(body)
  const ref = await requireRef(remote, opts, raw.ref, 'ref')
  const from = branchRef(raw.from, 'from')
  const now = nowSeconds()
  const author = raw.author === undefined ? null : stamp(raw.author, 'author', now)
  if (raw.committer !== undefined) {
    const committer = stamp(raw.committer, 'committer', now)
    if (!author || !sameStamp(author, committer)) throw fail('bad_request', 'merge has one identity; committer must match author (ply stamps both with the author)')
  }
  const message = textOr(raw.message, 'message')
  try {
    const result = await mergeBranch(remote, {
      ref,
      from,
      author: author ? plyPerson(author) : undefined,
      message,
      time: author ? author.time : undefined,
      fastForwardOnly: !!raw.fastForwardOnly,
      noFastForward: !!raw.noFastForward,
    }, opts) as Record<string, unknown>
    const outcome = (typeof result.outcome === 'string' ? result.outcome : 'merge') as WriteOutcome
    return { body: unifyPly(result, outcome, ref) }
  } catch (e) {
    throw await clarifyUnborn(remote, opts, e, 'merging')
  }
}

export async function handleRebase(remote: string, body: unknown, opts: object): Promise<{ body: Record<string, unknown> }> {
  const raw = asBody(body)
  const ref = branchRef(raw.ref, 'ref')
  const onto = await requireRef(remote, opts, raw.onto, 'onto')
  const now = nowSeconds()
  const committer = stamp(raw.committer, 'committer', now)
  const author = raw.author === undefined ? null : stamp(raw.author, 'author', now)
  if (author && author.time !== committer.time) throw fail('bad_request', 'rebase author.time must equal committer.time; ply stamps one time for both')
  const message = raw.message === undefined ? null : textOr(raw.message, 'message') ?? null
  try {
    const result = await rebaseBranch(remote, {
      ref,
      onto,
      committer: plyPerson(committer),
      author: author ? plyPerson(author) : undefined,
      time: committer.time,
      squash: !!raw.squash,
      message,
    }, opts) as Record<string, unknown>
    const outcome = (typeof result.outcome === 'string' ? result.outcome : 'rebase') as WriteOutcome
    return { body: unifyPly(result, outcome, ref) }
  } catch (e) {
    throw await clarifyUnborn(remote, opts, e, 'rebasing')
  }
}

async function handlePick(remote: string, body: unknown, opts: object, revert: boolean): Promise<{ body: Record<string, unknown> }> {
  const raw = asBody(body)
  const ref = await requireRef(remote, opts, raw.ref, 'ref')
  const commit = parseCommitOid(raw.commit, 'commit')
  const committer = stamp(raw.committer, 'committer', nowSeconds())
  if (raw.allowEmpty !== undefined && typeof raw.allowEmpty !== 'boolean') throw fail('bad_request', 'allowEmpty must be true or false')
  const message = raw.message === undefined || raw.message === null ? null : textOr(raw.message, 'message') ?? null
  try {
    return { body: await pick(remote, opts, { ref, commit, committer, message, allowEmpty: raw.allowEmpty === true, revert }) }
  } catch (e) {
    throw await clarifyUnborn(remote, opts, e, revert ? 'reverting' : 'cherry-picking')
  }
}

export const handleCherryPick = (remote: string, body: unknown, opts: object) => handlePick(remote, body, opts, false)
export const handleRevert = (remote: string, body: unknown, opts: object) => handlePick(remote, body, opts, true)

export const handleTagCreate = async (remote: string, body: unknown, opts: object) => ({ status: 201, body: await createTag(remote, body, opts) })
export const handleTagDelete = async (remote: string, body: unknown, opts: object) => ({ body: await removeTag(remote, body, opts) })

const EMPTY_COMMIT = { empty: true, oid: null, tree: null, parents: [], author: null, committer: null, message: null, signed: false }

/** A born commit is ply's readCommit body, unchanged. An unborn HEAD (or that same branch by name) is the empty-repo body. */
export async function readCommitOrEmpty(remote: string, ref: string | null, opts: object): Promise<Record<string, unknown>> {
  try {
    return await readCommit(remote, { ref }, opts) as Record<string, unknown>
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
export async function unbornFields(remote: string, opts: object, head: string | null): Promise<Record<string, unknown>> {
  if (head) return {}
  try {
    const state = await readHeadState(remote, opts, 'head')
    if (state.kind === 'unborn') return { empty: true, unborn: state.ref }
  } catch { /* the ref list itself succeeded; head stays null */ }
  return {}
}
