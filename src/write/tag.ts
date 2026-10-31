// Lightweight tags point the ref at a commit. Annotated tags add a tag object and point the ref at that.
// Delete uses the same compare-and-swap as a branch delete.
import { encodeTag, fail, fetchObject, hashObject, ident, lsRefs, operation, push, resolveCommit, TYPE, ZERO_OID } from 'ply'
import { type CallOpts, type GitOutcome, type GitSpan, type GitTransport } from './call.ts'
import { refExists } from './errors.ts'
import { nowSeconds, stamp, type Stamp } from './identity.ts'
import { isOid, parseCommitOid } from './oid.ts'
import { asBody, parseDeleteOid, tagRef } from './request.ts'
import { writeResult } from './result.ts'
import { deleteRef } from './branch.ts'

type Transport = GitTransport
type Root = GitSpan
type Outcome = GitOutcome

function messageBody(message: string): string {
  return message.endsWith('\n') ? message : `${message}\n`
}

async function commitOf(t: Transport, target: string): Promise<string> {
  if (isOid(target)) {
    parseCommitOid(target, 'target')
    try {
      await fetchObject(t, { oid: target, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT })
    } catch (e) {
      const code = (e as { code?: string })?.code
      if (code === 'pack_corrupt' || code === 'remote_error' || code === 'not_found') throw fail('not_found', `commit ${target} not found`)
      throw e
    }
    return target
  }
  return (await resolveCommit(t, target) as { commit: string }).commit
}

export async function createTag(remote: string, body: unknown, opts: CallOpts): Promise<Record<string, unknown>> {
  const raw = asBody(body)
  const ref = tagRef(raw.name)
  const target = raw.target
  if (typeof target !== 'string' || target === '') throw fail('bad_request', 'target is required')
  if (isOid(target)) parseCommitOid(target, 'target')
  const annotated = raw.annotated === true || raw.message !== undefined || raw.tagger !== undefined
  const tagger: Stamp | null = annotated ? stamp(raw.tagger, 'tagger', nowSeconds()) : null
  const message = typeof raw.message === 'string' ? raw.message : null
  if (raw.message !== undefined && typeof raw.message !== 'string') throw fail('bad_request', 'message must be a string')
  if (raw.annotated !== undefined && typeof raw.annotated !== 'boolean') throw fail('bad_request', 'annotated must be true or false')
  const short = ref.replace(/^refs\/tags\//, '')
  return operation('tag_create', remote, { ...opts, attrs: { 'git.tag.ref': ref, 'git.tag.annotated': annotated } }, async ({ t, root, outcome }: { t: Transport; root: Root; outcome: Outcome }) => {
    const existing = (await lsRefs(t, [ref])).refs.get(ref)?.oid as string | undefined
    if (existing) throw refExists(ref, existing)
    const commit = await commitOf(t, target)
    let newOid = commit
    const objects: { type: number; data: Uint8Array<ArrayBuffer> }[] = []
    if (annotated && tagger) {
      const data = encodeTag({
        object: commit,
        type: 'commit',
        tag: short,
        tagger: ident(tagger.person),
        message: messageBody(message ?? short),
      })
      newOid = hashObject('tag', data) as string
      objects.push({ type: TYPE.TAG, data })
    }
    root.set({ 'git.tag.commit': commit, 'git.tag.oid': newOid })
    try {
      const pushed = await push(t, { ref, oldOid: ZERO_OID, newOid, objects }) as { packBytes: number }
      return outcome('tag', writeResult('tag', ref, newOid, null, { commit, annotated, pushBytes: pushed.packBytes }))
    } catch (e) {
      if ((e as { code?: string })?.code === 'cas_conflict') {
        const cur = (await lsRefs(t, [ref])).refs.get(ref)?.oid as string | undefined
        throw refExists(ref, cur ?? newOid)
      }
      throw e
    }
  }) as Promise<Record<string, unknown>>
}

export async function removeTag(remote: string, body: unknown, opts: CallOpts): Promise<Record<string, unknown>> {
  const raw = asBody(body)
  return deleteRef(remote, tagRef(raw.name), parseDeleteOid(raw.oid), opts, 'tag_delete')
}
