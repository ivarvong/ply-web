// Build a commit from create/write/edit/delete/rename and push it. A missing ref is created (old oid = zero):
// that is the root commit on an empty repository, and a new branch when `base` names another ref or a commit.
// One find/replace on an existing file still goes through ply's editFile, which streams the blob.
import { fail, editFile, encodeCommit, fetchCommit, fetchObject, hashObject, isLfsPointerPrefix, lsRefs, operation, parseOid, parseTree, push, resolveCommit, TYPE, validatePath, ZERO_OID, KIND, type Oid, type Span } from 'ply'
import { type CallOpts, type GitOutcome, type GitSpan, type GitTransport } from './call.ts'
import { MODE_TREE, BLOB_MODES } from './constants.ts'
import { refExists } from './errors.ts'
import { readHead } from './head.ts'
import { plyPerson, type Stamp } from './identity.ts'
import { sameBranch, type Change, type EditRequest } from './request.ts'
import { writeResult } from './result.ts'
import { emptyDir, encodeMem, fileLeaf, isTree, lazyNode, lookup, putAt, removeAt, renameAt, replaceOnce, setChild, type Mem } from './tree.ts'

type Transport = GitTransport
type Root = GitSpan
type Outcome = GitOutcome

type Target = { readonly ref: string; readonly oid: Oid | null }
type Parent = { readonly oid: Oid | null; readonly tree: string | null }

const text = new TextEncoder()
const FILE_MODES: ReadonlySet<string> = new Set(BLOB_MODES)
/**
 * No partial-clone filter. `tree:0` and `blob:none` both omit blobs (gitprotocol-v2 / partial clone),
 * and an edit has to read the blob itself. Trees and commits stay on `tree:0`, which ply widens to
 * `blob:none` when the server refuses the narrow filter.
 */
const NO_FILTER = ''

function referencedBlobs(node: Mem, into: Set<string>): void {
  if (node.kind === 'lazy') {
    if (node.mode !== MODE_TREE) into.add(node.oid)
    return
  }
  for (const child of node.entries.values()) referencedBlobs(child, into)
}

function messageBody(message: string): string {
  return message.endsWith('\n') ? message : `${message}\n`
}

async function resolveTarget(t: Transport, ref: string | null): Promise<Target> {
  if (ref === null) {
    const head = await readHead(t)
    if (head.kind === 'born') return { ref: head.ref, oid: head.oid }
    if (head.kind === 'unborn') return { ref: head.ref, oid: null }
    if (head.kind === 'detached') throw fail('bad_request', 'remote HEAD is detached; pass ref explicitly')
    throw fail('not_found', 'remote HEAD is absent; pass ref explicitly')
  }
  const listed = (await lsRefs(t, [ref])).refs.get(ref)?.oid as string | undefined
  return { ref, oid: listed ? oidOf(listed) : null }
}

function oidOf(value: string): Oid {
  const parsed = parseOid(value)
  if (!parsed.ok) throw parsed.error
  return parsed.value
}

async function commitOf(t: Transport, oid: string): Promise<{ tree: string; parents: string[] }> {
  const fetched = await fetchCommit(t, oid)
  if (!fetched.ok) {
    const error = fetched.error
    if (error.code === 'not_found' && error.miss) {
      switch (error.miss.kind) {
        case 'absent':
        case 'not_commit':
          throw error
        default: {
          const unreachable: never = error.miss
          throw unreachable
        }
      }
    }
    throw error
  }
  return { tree: fetched.value.commit.tree, parents: fetched.value.commit.parents }
}

async function resolveParent(t: Transport, req: EditRequest, target: Target): Promise<Parent> {
  if (req.base.kind === 'oid') return { oid: req.base.oid, tree: (await commitOf(t, req.base.oid)).tree }
  if (req.base.kind === 'ref' && !sameBranch(req.base.ref, target.ref)) {
    const resolved = await resolveCommit(t, req.base.ref) as { commit: string }
    return { oid: oidOf(resolved.commit), tree: (await commitOf(t, resolved.commit)).tree }
  }
  if (target.oid === null) return { oid: null, tree: null }
  return { oid: target.oid, tree: (await commitOf(t, target.oid)).tree }
}

function assertHead(target: Target, req: EditRequest): void {
  if (req.head.kind !== 'oid') return
  const actual = target.oid ?? ZERO_OID
  if (req.head.oid !== actual) throw fail('cas_conflict', `${target.ref} is at ${actual}, not the expected head ${req.head.oid}`, { expected: req.head.oid, actual })
}

async function asDir(t: Transport, node: Mem, trees: Map<string, Uint8Array>): Promise<Mem> {
  if (node.kind === 'dir') return node
  if (node.mode !== MODE_TREE) return node
  let data = trees.get(node.oid)
  if (!data) {
    const obj = await fetchObject(t, { oid: node.oid, filter: 'tree:0', expectType: TYPE.TREE })
    data = obj.data as Uint8Array
    trees.set(node.oid, data)
  }
  const entries = parseTree(data, t.limits) as { name: string; mode: string; oid: string }[]
  const map = new Map<string, Mem>()
  for (const entry of entries) map.set(entry.name, lazyNode(entry.mode, entry.oid))
  return { kind: 'dir', entries: map }
}

/** Expand directory nodes along `comps`, stopping before the leaf. Missing components are left for putAt to create. */
async function expandDirs(t: Transport, node: Mem, comps: readonly string[], trees: Map<string, Uint8Array>): Promise<Mem> {
  const dir = await asDir(t, node, trees)
  if (dir.kind !== 'dir' || comps.length <= 1) return dir
  const [name, ...rest] = comps
  if (!name) return dir
  const child = dir.entries.get(name)
  if (!child || !isTree(child)) return dir
  return setChild(dir, name, await expandDirs(t, child, rest, trees))
}

function compsOf(t: Transport, path: string): string[] {
  return validatePath(path, t.limits) as string[]
}

type Blobs = { readonly reads: Map<string, Uint8Array>; readonly created: Map<string, Uint8Array> }

async function blobBytes(t: Transport, oid: string, blobs: Blobs): Promise<Uint8Array> {
  const held = blobs.created.get(oid) ?? blobs.reads.get(oid)
  if (held) return held
  const obj = await fetchObject(t, { oid, filter: NO_FILTER, expectType: TYPE.BLOB })
  const data = obj.data as Uint8Array
  blobs.reads.set(oid, data)
  return data
}

function remember(blobs: Blobs, data: Uint8Array): string {
  const oid = hashObject('blob', data) as string
  blobs.created.set(oid, data)
  return oid
}

function rejectPointer(data: Uint8Array, oid: string): void {
  if (isLfsPointerPrefix(data)) throw fail('lfs_pointer', `${oid} is a Git LFS pointer; the file's content is in the LFS store, not in git`)
}

async function applyOne(t: Transport, mem: Mem, change: Change, blobs: Blobs, trees: Map<string, Uint8Array>): Promise<Mem> {
  if (change.kind === 'rename') {
    const from = compsOf(t, change.from)
    const to = compsOf(t, change.to)
    mem = await expandDirs(t, mem, from, trees)
    mem = await expandDirs(t, mem, to, trees)
    return renameAt(mem, from, to)
  }
  const path = change.path
  const comps = compsOf(t, path)
  mem = await expandDirs(t, mem, comps, trees)
  if (change.kind === 'delete') return removeAt(mem, comps, path)
  if (change.kind === 'edit') {
    const leaf = lookup(mem, comps)
    if (!leaf || leaf.kind === 'dir' || !FILE_MODES.has(leaf.mode)) throw fail('not_found', `${path} not found`)
    const bytes = await blobBytes(t, leaf.oid, blobs)
    rejectPointer(bytes, leaf.oid)
    const replaced = replaceOnce(bytes, text.encode(change.find), text.encode(change.replace))
    if (replaced.kind === 'count') throw fail('match_count', `expected exactly one match, found ${replaced.matches}`, { matches: replaced.matches })
    return putAt(mem, comps, fileLeaf(leaf.mode as typeof BLOB_MODES[number], remember(blobs, replaced.data)), true, path)
  }
  const oid = remember(blobs, text.encode(change.content))
  return putAt(mem, comps, fileLeaf(change.mode, oid), change.kind === 'write', path)
}

function singleEdit(req: EditRequest): { path: string; find: string; replace: string } | null {
  if (req.changes.length !== 1) return null
  const change = req.changes[0]
  return change?.kind === 'edit' ? change : null
}

async function streamEdit(remote: string, req: EditRequest, target: Target, edit: { path: string; find: string; replace: string }, creating: boolean, opts: CallOpts): Promise<Record<string, unknown>> {
  const base = req.base.kind === 'ref' ? req.base.ref : target.ref
  const head = req.head.kind === 'oid' ? { head: req.head.oid, strictHead: true } : req.hint ? { head: req.hint } : {}
  const edited = await editFile(remote, {
    ref: target.ref,
    base,
    path: edit.path,
    find: edit.find,
    replace: edit.replace,
    author: plyPerson(req.author),
    message: req.message,
    time: req.author.time,
  }, { ...opts, ...head })
  const oid = edited.newCommit
  const oldOid = edited.noop || !creating ? edited.oldCommit : null
  return writeResult(edited.noop ? 'noop' : 'commit', target.ref, oid, oldOid, {
    ...edited,
    tree: edited.newTree,
    onto: creating ? edited.oldCommit : oldOid,
  })
}

/**
 * Apply `req` and push. Returns the unified write body.
 * `author` stamps both author and committer unless `committer` is set, in which case the commit is built here
 * (editFile has only one identity).
 */
export async function commitEdit(remote: string, req: EditRequest, opts: CallOpts): Promise<Record<string, unknown>> {
  return operation('commit', remote, {
    ...opts,
    attrs: { 'git.commit.ops': req.changes.map(change => change.kind), 'git.commit.ref': req.ref ?? 'HEAD' },
  }, async ({ t, root, outcome }: { t: Transport; root: Root; outcome: Outcome }) => {
    const target = await resolveTarget(t, req.ref)
    assertHead(target, req)
    const baseIsOther = req.base.kind === 'ref' && !sameBranch(req.base.ref, target.ref)
    if (target.oid !== null && baseIsOther) throw refExists(target.ref, target.oid)
    const creating = target.oid === null
    const edit = singleEdit(req)
    const stream = edit !== null && req.committer === null && req.base.kind !== 'oid' && (target.oid !== null || baseIsOther)
    if (edit && !stream && creating && !baseIsOther) throw fail('not_found', `ref ${target.ref} is unborn or absent; a root commit needs a create`)
    root.set({ 'git.commit.ref': target.ref, 'git.commit.creating': creating, 'git.commit.base': req.base.kind === 'omit' ? '' : req.base.kind === 'oid' ? req.base.oid : req.base.ref })
    if (stream && edit) {
      try {
        const body = await streamEdit(remote, req, target, edit, creating, opts)
        return outcome(String(body.outcome), body)
      } catch (e) {
        if (creating && (e as { code?: string })?.code === 'cas_conflict') {
          const cur = (await lsRefs(t, [target.ref])).refs.get(target.ref)?.oid as string | undefined
          throw refExists(target.ref, cur ?? '')
        }
        throw e
      }
    }
    const parent = await resolveParent(t, req, target)
    if (!creating && parent.oid !== target.oid) throw fail('bad_request', `base ${parent.oid} is not the tip of ${target.ref}; omit base to commit on the tip, or name a new ref to start from that commit`)
    const blobs: Blobs = { reads: new Map(), created: new Map() }
    const trees = new Map<string, Uint8Array>()
    let mem: Mem = parent.tree === null ? emptyDir() : lazyNode(MODE_TREE, parent.tree)
    mem = await t.tracer.span('git.commit.apply', {
      parent: root,
      kind: KIND.CLIENT,
      attrs: { 'git.commit.ops': req.changes.map(change => change.kind), 'git.commit.creating': creating },
    }, async (span: Span) => {
      for (const change of req.changes) mem = await applyOne(t, mem, change, blobs, trees)
      span.set({ 'git.commit.applied': req.changes.length })
      return mem
    })
    const built = encodeMem(mem)
    const committer: Stamp = req.committer ?? req.author
    if (!creating && parent.oid === target.oid && built.oid === parent.tree) {
      root.set({ 'git.commit.tree': built.oid, 'git.commit.oid': target.oid })
      return outcome('noop', writeResult('noop', target.ref, target.oid, target.oid, { tree: built.oid, pushBytes: 0 }))
    }
    const data = encodeCommit({
      tree: built.oid,
      parents: parent.oid ? [parent.oid] : [],
      author: req.author.line,
      committer: committer.line,
      message: messageBody(req.message),
    })
    const oid = hashObject('commit', data)
    const seen = new Set<string>()
    const used = new Set<string>()
    referencedBlobs(mem, used)
    const objects: { type: number; data: Uint8Array }[] = [{ type: TYPE.COMMIT, data }]
    for (const tree of built.trees) if (!seen.has(tree.oid)) { seen.add(tree.oid); objects.push({ type: TYPE.TREE, data: tree.data }) }
    for (const [blob, bytes] of blobs.created) if (used.has(blob) && !seen.has(blob)) { seen.add(blob); objects.push({ type: TYPE.BLOB, data: bytes }) }
    root.set({ 'git.commit.tree': built.oid, 'git.commit.oid': oid, 'git.commit.parent': parent.oid ?? '', 'git.commit.objects': objects.length })
    const oldOid = creating ? ZERO_OID : target.oid
    try {
      const pushed = await push(t, { ref: target.ref, oldOid, newOid: oid, objects }) as { packBytes: number }
      return outcome('commit', writeResult('commit', target.ref, oid, creating ? null : target.oid, { tree: built.oid, pushBytes: pushed.packBytes, onto: parent.oid }))
    } catch (e) {
      if (creating && (e as { code?: string })?.code === 'cas_conflict') {
        const cur = (await lsRefs(t, [target.ref])).refs.get(target.ref)?.oid as string | undefined
        throw refExists(target.ref, cur ?? '')
      }
      throw e
    }
  }) as Promise<Record<string, unknown>>
}
