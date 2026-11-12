// Lightweight tags point the ref at a commit. Annotated tags add a tag object and point the ref at that.
// Delete uses the same compare-and-swap as a branch delete.
import { encodeTag, plyError, fetchCommit, hashObject, ident, operation, parseCommitId, parseOid, parseRefname, push, resolveCommit, TYPE, ZERO_OID } from 'ply'
import { recordGet } from '../absent.ts'
import { err, ok, type Result } from '../http/machine.ts'
import { type PlyError } from '../ply-result.ts'
import { advertisedOid } from './advertised.ts'
import { type CallOpts, type GitOutcome, type GitSpan, type GitTransport } from './call.ts'
import { assertNever, done, refExistsAt, settle, type WorkerError, type Written } from './errors.ts'
import { nowSeconds, stamp, type Stamp } from './identity.ts'
import { asBody, parseDeleteOid, tagRef } from './request.ts'
import { writeResult } from './result.ts'
import { deleteRef } from './branch.ts'

type Transport = GitTransport
type Root = GitSpan
type Outcome = GitOutcome

function messageBody(message: string): string {
  return message.endsWith('\n') ? message : `${message}\n`
}

async function commitOf(t: Transport, target: string): Promise<Result<string, PlyError>> {
  if (parseOid(target).ok) {
    const parsed = parseCommitId(target)
    if (!parsed.ok) return parsed
    const fetched = await fetchCommit(t, parsed.value)
    if (!fetched.ok) {
      const error = fetched.error
      if (error.code === 'not_found' && error.miss) {
        // Tag targets are commits. A not_found from fetchCommit stays 404 with ply's message.
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
    return ok(parsed.value)
  }
  const resolved = await resolveCommit(t, target)
  return resolved.ok ? ok(resolved.value.commit) : resolved
}

// ref_exists is the Worker's own conflict, not a PlyError: the body returns it as a value (see branch.ts).
export async function createTag(remote: string, body: unknown, opts: CallOpts): Promise<Result<Record<string, unknown>, PlyError | WorkerError>> {
  const raw = asBody(body)
  const ref = tagRef(raw.name)
  const target = raw.target
  if (typeof target !== 'string' || target === '') throw plyError('bad_request', 'target is required')
  if (parseOid(target).ok) {
    const parsed = parseCommitId(target)
    if (!parsed.ok) throw parsed.error
  }
  const messageField = recordGet(raw, 'message')
  const taggerField = recordGet(raw, 'tagger')
  const annotatedField = recordGet(raw, 'annotated')
  const annotated = (annotatedField.tag === 'some' && annotatedField.value === true) || messageField.tag === 'some' || taggerField.tag === 'some'
  const tagger: Stamp | null = annotated ? stamp(raw.tagger, 'tagger', nowSeconds()) : null
  const message = messageField.tag === 'some' && typeof messageField.value === 'string' ? messageField.value : null
  if (messageField.tag === 'some' && typeof messageField.value !== 'string') throw plyError('bad_request', 'message must be a string')
  if (annotatedField.tag === 'some' && typeof annotatedField.value !== 'boolean') throw plyError('bad_request', 'annotated must be true or false')
  const short = ref.replace(/^refs\/tags\//, '')
  return settle(await operation<Written<Record<string, unknown>>>('tag_create', remote, { ...opts, attrs: { 'git.tag.ref': ref, 'git.tag.annotated': annotated } }, async ({ t, root, outcome }: { t: Transport; root: Root; outcome: Outcome }) => {
    const existing = await advertisedOid(t, ref)
    if (!existing.ok) return existing
    if (existing.value) return outcome('ref_exists', refExistsAt(ref, existing.value))
    const tip = await commitOf(t, target)
    if (!tip.ok) return tip
    const commit = tip.value
    let newOid = commit
    const objects: { type: number; data: Uint8Array<ArrayBuffer> }[] = []
    if (annotated && tagger) {
      const who = ident(tagger.person)
      if (!who.ok) return who
      const data = encodeTag({
        object: commit,
        type: 'commit',
        tag: short,
        tagger: who.value,
        message: messageBody(message === null ? short : message),
      })
      if (!data.ok) return data
      newOid = hashObject('tag', data.value)
      objects.push({ type: TYPE.TAG, data: data.value })
    }
    root.set({ 'git.tag.commit': commit, 'git.tag.oid': newOid })
    const name = parseRefname(ref)
    if (!name.ok) return name
    const pushed = await push(t, { ref: name.value, oldOid: ZERO_OID, newOid, objects })
    if (!pushed.ok) {
      if (pushed.error.code !== 'cas_conflict') return pushed
      const cur = await advertisedOid(t, ref)
      if (!cur.ok) return cur
      return outcome('ref_exists', refExistsAt(ref, cur.value === null ? newOid : cur.value))
    }
    return outcome('tag', done(writeResult('tag', ref, newOid, null, { commit, annotated, pushBytes: pushed.value.packBytes })))
  }))
}

export async function removeTag(remote: string, body: unknown, opts: CallOpts): Promise<Result<Record<string, unknown>, PlyError | WorkerError>> {
  const raw = asBody(body)
  return deleteRef(remote, tagRef(raw.name), parseDeleteOid(raw.oid), opts, 'tag_delete')
}
