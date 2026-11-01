// Pure pieces of the write API: request parsing, ident stamps, tree edits, the HEAD listing, the shared result.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { encodeTag, hashObject, ZERO_OID } from 'ply'
import { MODE_BLOB } from '../src/write/constants.ts'
import { parseTime, stamp, nowSeconds } from '../src/write/identity.ts'
import { headFromListing } from '../src/write/head.ts'
import { mapPickOutcome } from '../src/write/pick.ts'
import { asBody, parseBase, parseEdit, refOrCommit } from '../src/write/request.ts'
import { unifyPly, writeResult } from '../src/write/result.ts'
import { emptyDir, encodeMem, fileLeaf, lookup, putAt, removeAt, renameAt, replaceOnce } from '../src/write/tree.ts'

const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const code = (fn: () => unknown) => {
  try { fn() } catch (e) { return (e as { code?: string; message?: string }) }
  return null
}

test('parseBase rejects the zero oid and accepts a commit id or a branch', () => {
  assert.deepEqual(parseBase(undefined), { kind: 'omit' })
  assert.equal(parseBase('main').kind, 'ref')
  const oid = 'a'.repeat(40)
  assert.deepEqual(parseBase(oid), { kind: 'oid', oid })
  const zero = code(() => parseBase('0'.repeat(40)))
  assert.equal(zero?.code, 'bad_request')
  assert.match(zero?.message ?? '', /omit base to create a root commit/)
  assert.equal(ZERO_OID, '0'.repeat(40))
})

test('parseEdit: empty find creates, delete and rename, changes xor path', () => {
  const now = nowSeconds()
  const author = { name: 'w', email: 'w@x' }
  const created = parseEdit(asBody({ path: 'a.txt', content: 'hi', author, message: 'm' }), now)
  assert.deepEqual(created.changes, [{ kind: 'create', path: 'a.txt', content: 'hi', mode: MODE_BLOB }])
  const edited = parseEdit(asBody({ path: 'a.txt', find: 'hi', replace: 'yo', author, message: 'm' }), now)
  assert.equal(edited.changes[0]?.kind, 'edit')
  const deleted = parseEdit(asBody({ path: 'a.txt', delete: true, author, message: 'm' }), now)
  assert.deepEqual(deleted.changes, [{ kind: 'delete', path: 'a.txt' }])
  const renamed = parseEdit(asBody({ path: 'a.txt', to: 'b.txt', author, message: 'm' }), now)
  assert.deepEqual(renamed.changes, [{ kind: 'rename', from: 'a.txt', to: 'b.txt' }])
  const many = parseEdit(asBody({ author, message: 'm', changes: [{ op: 'write', path: 'a.txt', content: 'z', mode: '100755' }] }), now)
  assert.equal(many.changes[0]?.kind, 'write')
  assert.equal(code(() => parseEdit(asBody({ path: 'a', changes: [{ op: 'create', path: 'b' }], author, message: 'm' }), now))?.code, 'bad_request')
})

test('timezone offsets and unix seconds', () => {
  const now = nowSeconds()
  const india = stamp({ name: 'w', email: 'w@x', tz: '+0530', time: 1700000000 }, 'author', now)
  assert.equal(india.line, 'w <w@x> 1700000000 +0530')
  const west = stamp({ name: 'w', email: 'w@x', tz: '-1200', time: 1700000000 }, 'author', now)
  assert.equal(west.tz, '-1200')
  assert.equal(code(() => stamp({ name: 'w', email: 'w@x', tz: '+9999' }, 'author', now))?.code, 'bad_request')
  assert.equal(code(() => stamp({ name: 'w', email: 'w@x', tz: '-1201' }, 'author', now))?.code, 'bad_request')
  assert.equal(parseTime(0, 'time'), 0)
  assert.equal(code(() => parseTime(-1, 'time'))?.code, 'bad_request')
  const utc = stamp({ name: 'w', email: 'w@x', time: 1700000000 }, 'author', now)
  assert.equal(utc.line, 'w <w@x> 1700000000 +0000')
})

test('tree edits prune empty directories and refuse a rename into itself', () => {
  const leaf = fileLeaf(MODE_BLOB, EMPTY_BLOB)
  let mem = putAt(emptyDir(), ['a.txt'], leaf, false, 'a.txt')
  mem = putAt(mem, ['dir', 'b.txt'], leaf, false, 'dir/b.txt')
  assert.equal(code(() => putAt(mem, ['a.txt'], leaf, false, 'a.txt'))?.code, 'bad_request')
  mem = removeAt(mem, ['dir', 'b.txt'], 'dir/b.txt')
  assert.equal(lookup(mem, ['dir']), null)
  mem = putAt(mem, ['old.txt'], leaf, false, 'old.txt')
  mem = renameAt(mem, ['old.txt'], ['new.txt'])
  assert.equal(lookup(mem, ['new.txt'])?.kind, 'lazy')
  assert.equal(code(() => renameAt(mem, ['new.txt'], ['new.txt', 'x']))?.code, 'bad_request')
  const built = encodeMem(emptyDir())
  assert.equal(built.oid, EMPTY_TREE)
  assert.equal(built.trees.length, 1)
})

test('replaceOnce counts every non-overlapping match and replaces exactly one', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  const many = replaceOnce(enc('ababa'), enc('a'), enc('c'))
  assert.deepEqual(many, { kind: 'count', matches: 3 })
  const none = replaceOnce(enc('zzz'), enc('a'), enc('c'))
  assert.deepEqual(none, { kind: 'count', matches: 0 })
  const one = replaceOnce(enc('abc'), enc('b'), enc('c'))
  assert.equal(one.kind, 'replaced')
  if (one.kind === 'replaced') assert.equal(new TextDecoder().decode(one.data), 'acc')
})

test('HEAD listing: unborn, born, detached, absent', () => {
  const oid = 'a'.repeat(40)
  assert.deepEqual(headFromListing({ refs: new Map(), head: null, unborn: { target: 'refs/heads/main' } }), { kind: 'unborn', ref: 'refs/heads/main' })
  const bornRefs = new Map([['HEAD', { oid }]])
  assert.deepEqual(headFromListing({ refs: bornRefs, head: 'refs/heads/main', unborn: null }), { kind: 'born', ref: 'refs/heads/main', oid })
  // an unborn line wins even if a HEAD ref is also listed
  assert.equal(headFromListing({ refs: bornRefs, head: 'refs/heads/main', unborn: { target: 'refs/heads/trunk' } }).kind, 'unborn')
  assert.deepEqual(headFromListing({ refs: new Map([['HEAD', { oid }]]), head: null, unborn: null }), { kind: 'detached', oid })
  assert.deepEqual(headFromListing({ refs: new Map(), head: null, unborn: null }), { kind: 'absent' })
})

test('refOrCommit accepts a branch or a 40-hex commit and rejects zero', () => {
  assert.equal(refOrCommit('main', 'from'), 'refs/heads/main')
  const oid = 'b'.repeat(40)
  assert.equal(refOrCommit(oid, 'onto'), oid)
  assert.equal(code(() => refOrCommit('0'.repeat(40), 'from'))?.code, 'bad_request')
  assert.equal(code(() => refOrCommit('', 'from'))?.code, 'bad_request')
})

test('cherry-pick outcomes map exhaustively: empty, ok, kept_empty, and nothing else', () => {
  const ref = 'refs/heads/main'
  const oid = 'c'.repeat(40)
  const onto = 'd'.repeat(40)
  assert.deepEqual(mapPickOutcome({ outcome: 'empty', ref, oid }, false), { kind: 'empty', ref, oid })
  assert.deepEqual(mapPickOutcome({ outcome: 'ok', ref, oid, tree: 't', onto, pushBytes: 12 }, false), {
    kind: 'applied', name: 'cherry_pick', ref, oid, oldOid: onto, tree: 't', pushBytes: 12,
  })
  assert.deepEqual(mapPickOutcome({ outcome: 'kept_empty', ref, oid, tree: 't', onto, pushBytes: 12 }, false), {
    kind: 'applied', name: 'cherry_pick', ref, oid, oldOid: onto, tree: 't', pushBytes: 12,
  })
  const reverted = mapPickOutcome({ outcome: 'kept_empty', ref, oid, tree: 't', onto, pushBytes: 12 }, true)
  assert.equal(reverted.kind, 'applied')
  if (reverted.kind === 'applied') {
    assert.equal(reverted.name, 'revert')
    assert.equal(reverted.oldOid, onto)
  }
  assert.deepEqual(mapPickOutcome({ outcome: 'ok', ref, oid }, false), {
    kind: 'applied', name: 'cherry_pick', ref, oid, oldOid: null, tree: null, pushBytes: 0,
  })
  assert.deepEqual(mapPickOutcome({ outcome: 'ok', ref, oid, onto: null, tree: null, pushBytes: 0 }, false), {
    kind: 'applied', name: 'cherry_pick', ref, oid, oldOid: null, tree: null, pushBytes: 0,
  })
  assert.deepEqual(mapPickOutcome({ outcome: 'empty', ref, oid, tree: 't', onto, pushBytes: 12 }, false), { kind: 'empty', ref, oid })
  // A non-null non-string is kept. writeResult is what turns a non-string onto into null.
  const numbered = mapPickOutcome({ outcome: 'ok', ref, oid, onto: 4, tree: 5, pushBytes: '12' }, false)
  assert.equal(numbered.kind, 'applied')
  if (numbered.kind === 'applied') {
    assert.equal(numbered.oldOid, 4)
    assert.equal(numbered.tree, 5)
    assert.equal(numbered.pushBytes, '12')
  }
  assert.equal(code(() => mapPickOutcome({ outcome: 'applied', ref, oid }, false))?.code, 'internal')
})

test('write results share oid aliases and empty outcomes are noops', () => {
  const empty = writeResult('empty', 'refs/heads/main', 'abc', 'abc')
  assert.equal(empty.noop, true)
  assert.equal(empty.newCommit, 'abc')
  assert.equal(empty.oldCommit, 'abc')
  assert.equal(empty.onto, 'abc')
  const created = writeResult('commit', 'refs/heads/main', 'abc', null)
  assert.equal(created.oldOid, null)
  assert.equal(created.onto, null)
  assert.equal(created.noop, false)
  const viaTheirs = writeResult('merge', 'refs/heads/main', 'abc', 'def', { onto: null, theirs: 'ghi' })
  assert.equal(viaTheirs.onto, 'ghi')
  assert.equal(viaTheirs.theirs, 'ghi')
  assert.equal(writeResult('merge', 'refs/heads/main', 'abc', 'def', { onto: '' }).onto, '')
  assert.equal(writeResult('merge', 'refs/heads/main', 'abc', 'def', { onto: 1, theirs: 'ghi' }).onto, null)
  const folded = unifyPly({ newCommit: 'abc', oldCommit: 'def', tree: 'ttt', pushBytes: 4 }, 'commit', 'refs/heads/main')
  assert.equal(folded.oid, 'abc')
  assert.equal(folded.oldOid, 'def')
  assert.equal(folded.newCommit, 'abc')
  assert.equal(folded.oldCommit, 'def')
  assert.equal(folded.onto, 'def')
  assert.equal(folded.outcome, 'commit')
  assert.equal(folded.tree, 'ttt')
  assert.equal(folded.pushBytes, 4)
  assert.equal(folded.noop, false)
  const ranked = unifyPly({
    oid: null, newCommit: 'abc',
    oldCommit: null, ours: null, oldTip: 'def',
    onto: null, theirs: 'ghi',
    tree: null, newTree: 'ttt',
    pushBytes: null,
  }, 'merge', 'refs/heads/main')
  assert.equal(ranked.oid, 'abc')
  assert.equal(ranked.oldOid, 'def')
  assert.equal(ranked.onto, 'ghi')
  assert.equal(ranked.tree, 'ttt')
  assert.equal(ranked.pushBytes, 0)
  const preferred = unifyPly({ oid: 'aaa', newCommit: 'bbb', oldCommit: 'ccc', ours: 'ddd', onto: 'eee', theirs: 'fff', pushBytes: 0 }, 'commit', 'refs/heads/main')
  assert.equal(preferred.oid, 'aaa')
  assert.equal(preferred.oldOid, 'ccc')
  assert.equal(preferred.onto, 'eee')
  assert.equal(preferred.pushBytes, 0)
  assert.equal(unifyPly({ oid: 'abc', oldCommit: 'def', noop: false }, 'empty', 'refs/heads/main').noop, false)
  assert.equal(unifyPly({ oid: 'abc', oldCommit: 'def' }, 'empty', 'refs/heads/main').noop, true)
})

test('annotated tag bytes hash the way git hash-object does', () => {
  const object = 'a'.repeat(40)
  const tagger = 'w <w@x> 1700000000 +0530'
  const data = encodeTag({ object, type: 'commit', tag: 'v2', tagger, message: 'version two\n' })
  const oid = hashObject('tag', data) as string
  const gitOid = execFileSync('git', ['hash-object', '-t', 'tag', '--stdin'], { input: data }).toString().trim()
  assert.equal(oid, gitOid)
})
