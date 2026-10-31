// Pure pieces of the write API: request parsing, ident stamps, tree edits, the unborn HEAD line, the shared result.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { hashObject } from 'ply'
import { MODE_BLOB } from '../src/write/constants.ts'
import { encodeTagObject } from '../src/write/tag.ts'
import { parseTz, parseTime, stamp, nowSeconds } from '../src/write/identity.ts'
import { headFromLines, parseHeadLine } from '../src/write/head.ts'
import { isZeroOid } from '../src/write/oid.ts'
import { asBody, parseBase, parseEdit } from '../src/write/request.ts'
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
  assert.equal(isZeroOid('0'.repeat(40)), true)
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
  assert.equal(parseTz('+0530', 'tz'), '+0530')
  assert.equal(parseTz('-1200', 'tz'), '-1200')
  assert.equal(code(() => parseTz('+9999', 'tz'))?.code, 'bad_request')
  assert.equal(code(() => parseTz('-1201', 'tz'))?.code, 'bad_request')
  assert.equal(parseTime(0, 'time'), 0)
  assert.equal(code(() => parseTime(-1, 'time'))?.code, 'bad_request')
  const s = stamp({ name: 'w', email: 'w@x', tz: '+0530', time: 1700000000 }, 'author', nowSeconds())
  assert.equal(s.line, 'w <w@x> 1700000000 +0530')
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

test('unborn HEAD line is the symref git reports for an empty repository', () => {
  const line = parseHeadLine('unborn HEAD symref-target:refs/heads/main')
  assert.deepEqual(headFromLines([line]), { kind: 'unborn', ref: 'refs/heads/main' })
  const born = parseHeadLine(`${'a'.repeat(40)} HEAD symref-target:refs/heads/main`)
  assert.equal(headFromLines([born]).kind, 'born')
})

test('write results share oid aliases and empty outcomes are noops', () => {
  const empty = writeResult('empty', 'refs/heads/main', 'abc', 'abc')
  assert.equal(empty.noop, true)
  assert.equal(empty.newCommit, 'abc')
  assert.equal(empty.oldCommit, 'abc')
  const created = writeResult('commit', 'refs/heads/main', 'abc', null)
  assert.equal(created.oldOid, null)
  assert.equal(created.noop, false)
  const folded = unifyPly({ newCommit: 'abc', oldCommit: 'def', tree: 'ttt', pushBytes: 4 }, 'commit', 'refs/heads/main')
  assert.equal(folded.oid, 'abc')
  assert.equal(folded.oldOid, 'def')
  assert.equal(folded.newCommit, 'abc')
  assert.equal(folded.outcome, 'commit')
  assert.equal(folded.tree, 'ttt')
})

test('annotated tag bytes hash the way git hash-object does', () => {
  const object = 'a'.repeat(40)
  const tagger = 'w <w@x> 1700000000 +0530'
  const data = encodeTagObject({ object, type: 'commit', tag: 'v2', tagger, message: 'version two\n' })
  const oid = hashObject('tag', data) as string
  const gitOid = execFileSync('git', ['hash-object', '-t', 'tag', '--stdin'], { input: data }).toString().trim()
  assert.equal(oid, gitOid)
})
