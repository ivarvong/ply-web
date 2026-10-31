import type { RayNeed, Expect, Saved } from './judge.ts'

export type HttpStep = {
  readonly name: string
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: (saved: Saved) => object
  readonly expect: Expect
  readonly ray: RayNeed
  readonly rayIncludes?: string
  readonly save?: readonly { readonly key: string; readonly field: string }[]
  /** False skips the Worker bearer. The 401 is decided before any upstream call. */
  readonly ply?: boolean
  /** False skips Git-Token. */
  readonly git?: boolean
}

const T = 1_700_000_000
const ZERO = '0'.repeat(40)

function author(time: number, tz = '+0000') {
  return { name: 'ply cd', email: 'cd@ply.invalid', tz, time }
}

function committer(time: number) {
  return { name: 'ply cd committer', email: 'commit@ply.invalid', tz: '-0800', time }
}

/** The second commit, shared so a replay onto another branch produces the same tree. */
export function secondChanges(): readonly Record<string, string>[] {
  return [
    { op: 'edit', path: 'src/a.txt', find: 'v1', replace: 'v2' },
    { op: 'delete', path: 'src/keep.txt' },
    { op: 'create', path: 'ADDED.txt', content: 'added\n' },
    { op: 'rename', path: 'old.txt', to: 'new.txt' },
    { op: 'write', path: 'notes/w.txt', content: 'w\n' },
  ]
}

/** The same patch plus a path that exists only on the target. That is a conflict, not an empty pick. */
export function widerChanges(): readonly Record<string, string>[] {
  return [...secondChanges(), { op: 'create', path: 'extra.txt', content: 'only here\n' }]
}

function rootChanges(): readonly Record<string, string>[] {
  return [
    { op: 'create', path: 'README.md', content: 'hello\n' },
    { op: 'create', path: 'src/a.txt', content: 'v1\n' },
    { op: 'create', path: 'src/keep.txt', content: 'keep\n' },
    { op: 'create', path: 'old.txt', content: 'x\n' },
    { op: 'create', path: 'bin/run', content: '#!/bin/sh\n', mode: '100755' },
    { op: 'create', path: 'link', content: 'README.md', mode: '120000' },
  ]
}

const write = (name: string, body: (saved: Saved) => Record<string, unknown>, expect: Expect, save?: HttpStep['save']): HttpStep => ({
  name,
  method: 'POST',
  path: '/v1/edit',
  body,
  expect,
  ray: 'required',
  rayIncludes: 'receive-pack=',
  save,
})

const read = (name: string, path: string, expect: Expect, rayIncludes?: string): HttpStep => ({
  name,
  method: 'GET',
  path: '/v1/read',
  query: { path },
  expect,
  ray: 'required',
  rayIncludes,
})

/**
 * One empty Artifacts repo, never seeded with stock git. Oids returned by earlier steps are
 * passed into later ones. The order is the contract in src/index.js.
 */
export function lifecycle(): readonly HttpStep[] {
  return [
    {
      name: 'ply-unauth',
      method: 'GET',
      path: '/v1/commit',
      ply: false,
      git: false,
      expect: { kind: 'code', status: 401, code: 'unauthorized' },
      ray: 'absent',
    },
    { name: 'commit-empty', method: 'GET', path: '/v1/commit', expect: { kind: 'empty-commit' }, ray: 'required' },
    {
      name: 'commit-empty-main',
      method: 'GET',
      path: '/v1/commit',
      query: { ref: 'main' },
      expect: { kind: 'empty-commit' },
      ray: 'required',
    },
    {
      name: 'commit-missing',
      method: 'GET',
      path: '/v1/commit',
      query: { ref: 'nope' },
      expect: { kind: 'code', status: 404, code: 'not_found' },
      ray: 'required',
    },
    { name: 'refs-empty', method: 'GET', path: '/v1/refs', expect: { kind: 'refs-empty' }, ray: 'required' },
    {
      name: 'branch-unborn',
      method: 'POST',
      path: '/v1/branch',
      body: () => ({ ref: 'tmp' }),
      expect: { kind: 'code', status: 400, code: 'bad_request', message: /from is required when the remote HEAD is unborn/ },
      ray: 'required',
    },
    {
      name: 'branch-zero',
      method: 'POST',
      path: '/v1/branch',
      body: () => ({ ref: 'tmp', from: ZERO }),
      expect: { kind: 'code', status: 400, code: 'bad_request', message: /zero oid/ },
      ray: 'optional',
    },
    {
      name: 'edit-zero-base',
      method: 'POST',
      path: '/v1/edit',
      body: () => ({ base: ZERO, path: 'a.txt', content: 'a\n', author: author(T), message: 'no' }),
      expect: { kind: 'code', status: 400, code: 'bad_request', message: /zero oid/ },
      ray: 'optional',
    },
    write('root-create', () => ({ message: 'init', author: author(T), changes: rootChanges() }), {
      kind: 'outcome', status: 200, outcome: 'commit', noop: false, nullFields: ['oldOid'],
    }, [{ key: 'c0', field: 'oid' }]),
    {
      name: 'tree-root',
      method: 'GET',
      path: '/v1/tree',
      expect: { kind: 'tree', names: ['README.md', 'src', 'old.txt', 'bin', 'link'] },
      ray: 'required',
    },
    read('read-readme', 'README.md', { kind: 'text', status: 200, text: 'hello\n' }, 'fetch='),
    write('edit-update', () => ({
      message: 'second',
      author: author(T + 100),
      committer: committer(T + 100),
      changes: secondChanges(),
    }), {
      kind: 'outcome', status: 200, outcome: 'commit', equals: [{ field: 'oldOid', key: 'c0' }],
    }, [{ key: 'c1', field: 'oid' }]),
    {
      name: 'merge-zero',
      method: 'POST',
      path: '/v1/merge',
      body: () => ({ ref: 'main', from: ZERO, author: author(T + 105) }),
      expect: { kind: 'code', status: 400, code: 'bad_request', message: /zero oid/ },
      ray: 'optional',
    },
    {
      name: 'merge-from-oid',
      method: 'POST',
      path: '/v1/merge',
      body: saved => ({ from: saved.c0, author: author(T + 106) }),
      expect: { kind: 'outcome', status: 200, outcome: 'up_to_date', noop: true },
      ray: 'required',
    },
    read('read-edited', 'src/a.txt', { kind: 'text', status: 200, text: 'v2\n' }, 'fetch='),
    read('read-added', 'ADDED.txt', { kind: 'text', status: 200, text: 'added\n' }, 'fetch='),
    read('read-renamed', 'new.txt', { kind: 'text', status: 200, text: 'x\n' }, 'fetch='),
    read('read-written', 'notes/w.txt', { kind: 'text', status: 200, text: 'w\n' }, 'fetch='),
    read('read-deleted', 'src/keep.txt', { kind: 'code', status: 404, code: 'not_found' }),
    {
      name: 'cas-stale',
      method: 'POST',
      path: '/v1/edit',
      body: saved => ({ message: 'stale', author: author(T + 110), head: saved.c0, path: 'README.md', find: 'hello', replace: 'stale' }),
      expect: { kind: 'code', status: 409, code: 'cas_conflict' },
      ray: 'required',
    },
    {
      name: 'match-count',
      method: 'POST',
      path: '/v1/edit',
      body: () => ({ message: 'count', author: author(T + 120), path: 'src/a.txt', find: 'no-such-marker', replace: 'z' }),
      expect: { kind: 'code', status: 422, code: 'match_count' },
      ray: 'required',
    },
    {
      name: 'branch-create',
      method: 'POST',
      path: '/v1/branch',
      body: saved => ({ ref: 'other', from: saved.c0 }),
      expect: { kind: 'outcome', status: 201, outcome: 'created', equals: [{ field: 'oid', key: 'c0' }] },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    write('branch-replay', () => ({
      ref: 'other',
      message: 'replay',
      author: author(T + 200),
      changes: secondChanges(),
    }), {
      kind: 'outcome', status: 200, outcome: 'commit', differs: [{ field: 'oid', key: 'c1' }],
    }, [{ key: 'otherTip', field: 'oid' }]),
    {
      name: 'cherry-applied',
      method: 'POST',
      path: '/v1/cherry-pick',
      body: saved => ({ ref: 'other', commit: saved.c1, committer: author(T + 210) }),
      expect: { kind: 'outcome', status: 200, outcome: 'empty', noop: true, equals: [{ field: 'oid', key: 'otherTip' }] },
      ray: 'required',
    },
    {
      name: 'cherry-allow-empty',
      method: 'POST',
      path: '/v1/cherry-pick',
      body: saved => ({ ref: 'other', commit: saved.c1, committer: author(T + 220), allowEmpty: true }),
      expect: { kind: 'outcome', status: 200, outcome: 'cherry_pick', noop: false, differs: [{ field: 'oid', key: 'otherTip' }] },
      ray: 'required',
      rayIncludes: 'receive-pack=',
      save: [{ key: 'emptyPick', field: 'oid' }],
    },
    {
      name: 'branch-wider',
      method: 'POST',
      path: '/v1/branch',
      body: saved => ({ ref: 'wider', from: saved.c0 }),
      expect: { kind: 'outcome', status: 201, outcome: 'created' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    write('wider-file', () => ({
      ref: 'wider',
      message: 'wider',
      author: author(T + 230),
      changes: widerChanges(),
    }), { kind: 'outcome', status: 200, outcome: 'commit' }, [{ key: 'widerTip', field: 'oid' }]),
    {
      name: 'cherry-wider',
      method: 'POST',
      path: '/v1/cherry-pick',
      body: saved => ({ ref: 'wider', commit: saved.c1, committer: author(T + 240) }),
      expect: { kind: 'code', status: 409, code: 'merge_conflict' },
      ray: 'required',
    },
    {
      name: 'cherry-wider-empty',
      method: 'POST',
      path: '/v1/cherry-pick',
      body: saved => ({ ref: 'wider', commit: saved.c1, committer: author(T + 250), allowEmpty: true }),
      expect: { kind: 'code', status: 409, code: 'merge_conflict' },
      ray: 'required',
    },
    {
      name: 'branch-feat',
      method: 'POST',
      path: '/v1/branch',
      body: saved => ({ ref: 'feat', from: saved.c1 }),
      expect: { kind: 'outcome', status: 201, outcome: 'created', equals: [{ field: 'oid', key: 'c1' }] },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    write('feat-file', () => ({
      ref: 'feat',
      message: 'feat file',
      author: author(T + 300),
      changes: [{ op: 'create', path: 'feat.txt', content: 'feat\n' }],
    }), { kind: 'outcome', status: 200, outcome: 'commit' }, [{ key: 'feat', field: 'oid' }]),
    {
      name: 'cherry-pick',
      method: 'POST',
      path: '/v1/cherry-pick',
      body: saved => ({ commit: saved.feat, committer: author(T + 310) }),
      expect: { kind: 'outcome', status: 200, outcome: 'cherry_pick' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
      save: [{ key: 'picked', field: 'oid' }],
    },
    {
      name: 'branch-rwide',
      method: 'POST',
      path: '/v1/branch',
      body: saved => ({ ref: 'rwide', from: saved.picked }),
      expect: { kind: 'outcome', status: 201, outcome: 'created' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    write('rwide-file', () => ({
      ref: 'rwide',
      message: 'rwide extra',
      author: author(T + 330),
      changes: [{ op: 'create', path: 'rwide.txt', content: 'extra\n' }],
    }), { kind: 'outcome', status: 200, outcome: 'commit' }),
    {
      name: 'revert-wider',
      method: 'POST',
      path: '/v1/revert',
      body: saved => ({ ref: 'rwide', commit: saved.picked, committer: author(T + 340) }),
      expect: { kind: 'code', status: 409, code: 'merge_conflict' },
      ray: 'required',
    },
    {
      name: 'revert',
      method: 'POST',
      path: '/v1/revert',
      body: saved => ({ commit: saved.picked, committer: author(T + 320) }),
      expect: { kind: 'outcome', status: 200, outcome: 'revert' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
      save: [{ key: 'reverted', field: 'oid' }],
    },
    {
      name: 'branch-ff',
      method: 'POST',
      path: '/v1/branch',
      body: saved => ({ ref: 'ff', from: saved.reverted }),
      expect: { kind: 'outcome', status: 201, outcome: 'created' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    write('ff-file', () => ({
      ref: 'ff',
      message: 'ff file',
      author: author(T + 400),
      changes: [{ op: 'create', path: 'ff.txt', content: 'ff\n' }],
    }), { kind: 'outcome', status: 200, outcome: 'commit' }, [{ key: 'ffTip', field: 'oid' }]),
    {
      name: 'merge-ff',
      method: 'POST',
      path: '/v1/merge',
      body: () => ({ from: 'ff', author: author(T + 410), message: 'merge ff' }),
      expect: { kind: 'outcome', status: 200, outcome: 'fast_forward', equals: [{ field: 'oid', key: 'ffTip' }] },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    {
      name: 'branch-diverge',
      method: 'POST',
      path: '/v1/branch',
      body: saved => ({ ref: 'diverge', from: saved.ffTip }),
      expect: { kind: 'outcome', status: 201, outcome: 'created' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    write('diverge-file', () => ({
      ref: 'diverge',
      message: 'diverge',
      author: author(T + 500),
      changes: [{ op: 'create', path: 'div.txt', content: 'div\n' }],
    }), { kind: 'outcome', status: 200, outcome: 'commit' }, [{ key: 'divTip', field: 'oid' }]),
    write('main-diverge', () => ({
      message: 'main moves',
      author: author(T + 510),
      changes: [{ op: 'create', path: 'main-moved.txt', content: 'm\n' }],
    }), { kind: 'outcome', status: 200, outcome: 'commit' }, [{ key: 'mainMoved', field: 'oid' }]),
    {
      name: 'merge-ff-only',
      method: 'POST',
      path: '/v1/merge',
      body: () => ({ from: 'diverge', author: author(T + 520), message: 'ff only', fastForwardOnly: true }),
      expect: { kind: 'code', status: 409, code: 'not_fast_forward' },
      ray: 'required',
    },
    {
      name: 'branch-noff',
      method: 'POST',
      path: '/v1/branch',
      body: saved => ({ ref: 'noff', from: saved.mainMoved }),
      expect: { kind: 'outcome', status: 201, outcome: 'created' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    write('noff-file', () => ({
      ref: 'noff',
      message: 'noff',
      author: author(T + 600),
      changes: [{ op: 'create', path: 'noff.txt', content: 'n\n' }],
    }), { kind: 'outcome', status: 200, outcome: 'commit' }, [{ key: 'noffTip', field: 'oid' }]),
    {
      name: 'merge-noff',
      method: 'POST',
      path: '/v1/merge',
      body: () => ({
        from: 'noff',
        author: author(T + 610),
        committer: committer(T + 630),
        message: 'merge noff',
        noFastForward: true,
      }),
      expect: { kind: 'outcome', status: 200, outcome: 'merge' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
      save: [{ key: 'noffMerge', field: 'oid' }],
    },
    {
      name: 'commit-noff-parents',
      method: 'GET',
      path: '/v1/commit',
      query: { ref: 'main' },
      expect: { kind: 'parents', count: 2, oidEquals: 'noffMerge' },
      ray: 'required',
    },
    {
      name: 'merge-stamps',
      method: 'GET',
      path: '/v1/commit',
      query: { ref: 'main' },
      expect: { kind: 'stamps', authorEmail: 'cd@ply.invalid', committerEmail: 'commit@ply.invalid' },
      ray: 'required',
    },
    {
      name: 'merge-diverged',
      method: 'POST',
      path: '/v1/merge',
      body: () => ({ from: 'diverge', author: author(T + 620), message: 'merge diverged' }),
      expect: { kind: 'outcome', status: 200, outcome: 'merge' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    {
      name: 'tag-light',
      method: 'POST',
      path: '/v1/tag',
      body: saved => ({ name: 'v-light', target: saved.c0 }),
      expect: { kind: 'outcome', status: 201, outcome: 'tag', equals: [{ field: 'oid', key: 'c0' }] },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    {
      name: 'tag-annotated',
      method: 'POST',
      path: '/v1/tag',
      body: saved => ({ name: 'v-ann', target: saved.c1, annotated: true, message: 'ann\n', tagger: author(T + 700) }),
      expect: {
        kind: 'outcome',
        status: 201,
        outcome: 'tag',
        equals: [{ field: 'commit', key: 'c1' }],
        differs: [{ field: 'oid', key: 'c1' }],
      },
      ray: 'required',
      rayIncludes: 'receive-pack=',
      save: [{ key: 'ann', field: 'oid' }],
    },
    {
      name: 'tag-exists',
      method: 'POST',
      path: '/v1/tag',
      body: saved => ({ name: 'v-light', target: saved.c0 }),
      expect: { kind: 'code', status: 409, code: 'ref_exists' },
      ray: 'required',
    },
    {
      name: 'tag-stale',
      method: 'DELETE',
      path: '/v1/tag',
      body: saved => ({ name: 'v-light', oid: saved.c1 }),
      expect: { kind: 'code', status: 409, code: 'stale_expected' },
      ray: 'required',
    },
    {
      name: 'tag-delete',
      method: 'DELETE',
      path: '/v1/tag',
      body: saved => ({ name: 'v-light', oid: saved.c0 }),
      expect: { kind: 'outcome', status: 200, outcome: 'deleted' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    {
      name: 'branch-tmp',
      method: 'POST',
      path: '/v1/branch',
      body: saved => ({ ref: 'tmp', from: saved.c0 }),
      expect: { kind: 'outcome', status: 201, outcome: 'created' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    {
      name: 'branch-dup',
      method: 'POST',
      path: '/v1/branch',
      body: saved => ({ ref: 'tmp', from: saved.c0 }),
      expect: { kind: 'code', status: 409, code: 'ref_exists' },
      ray: 'required',
    },
    {
      name: 'branch-stale',
      method: 'DELETE',
      path: '/v1/branch',
      body: saved => ({ ref: 'tmp', oid: saved.c1 }),
      expect: { kind: 'code', status: 409, code: 'stale_expected' },
      ray: 'required',
    },
    {
      name: 'branch-delete',
      method: 'DELETE',
      path: '/v1/branch',
      body: saved => ({ ref: 'tmp', oid: saved.c0 }),
      expect: { kind: 'outcome', status: 200, outcome: 'deleted' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    {
      name: 'branch-rebase',
      method: 'POST',
      path: '/v1/branch',
      body: saved => ({ ref: 'rebase', from: saved.c0 }),
      expect: { kind: 'outcome', status: 201, outcome: 'created' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    write('rebase-file', () => ({
      ref: 'rebase',
      message: 'rebase file',
      author: author(T + 800),
      changes: [{ op: 'create', path: 'rebase.txt', content: 'r\n' }],
    }), { kind: 'outcome', status: 200, outcome: 'commit' }),
    {
      name: 'commit-main',
      method: 'GET',
      path: '/v1/commit',
      expect: { kind: 'born' },
      ray: 'required',
      save: [{ key: 'mainTip', field: 'oid' }],
    },
    {
      name: 'rebase-zero',
      method: 'POST',
      path: '/v1/rebase',
      body: () => ({ ref: 'rebase', onto: ZERO, committer: author(T + 805) }),
      expect: { kind: 'code', status: 400, code: 'bad_request', message: /zero oid/ },
      ray: 'optional',
    },
    {
      name: 'rebase',
      method: 'POST',
      path: '/v1/rebase',
      body: saved => ({
        ref: 'rebase',
        onto: saved.mainTip,
        committer: committer(T + 810),
        author: author(T + 820),
      }),
      expect: { kind: 'outcome', status: 200, outcome: 'rebase' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    {
      name: 'branch-squash',
      method: 'POST',
      path: '/v1/branch',
      body: saved => ({ ref: 'squash', from: saved.c0 }),
      expect: { kind: 'outcome', status: 201, outcome: 'created' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    write('squash-file-1', () => ({
      ref: 'squash',
      message: 'squash 1',
      author: author(T + 900),
      changes: [{ op: 'create', path: 'sq1.txt', content: '1\n' }],
    }), { kind: 'outcome', status: 200, outcome: 'commit' }),
    write('squash-file-2', () => ({
      ref: 'squash',
      message: 'squash 2',
      author: author(T + 910),
      changes: [{ op: 'create', path: 'sq2.txt', content: '2\n' }],
    }), { kind: 'outcome', status: 200, outcome: 'commit' }),
    {
      name: 'squash',
      method: 'POST',
      path: '/v1/rebase',
      body: () => ({ ref: 'squash', onto: 'main', committer: author(T + 920), squash: true, message: 'squashed' }),
      expect: { kind: 'outcome', status: 200, outcome: 'squash' },
      ray: 'required',
      rayIncludes: 'receive-pack=',
    },
    {
      name: 'refs-final',
      method: 'GET',
      path: '/v1/refs',
      expect: {
        kind: 'refs-final',
        has: ['refs/heads/main', 'refs/tags/v-ann'],
        missing: ['refs/heads/tmp', 'refs/tags/v-light'],
        head: 'refs/heads/main',
      },
      ray: 'required',
    },
  ]
}

export function expectedStatus(step: HttpStep): number {
  const expect = step.expect
  if (expect.kind === 'empty-commit' || expect.kind === 'refs-empty' || expect.kind === 'tree' || expect.kind === 'parents' || expect.kind === 'born' || expect.kind === 'stamps' || expect.kind === 'refs-final') {
    return 200
  }
  return expect.status
}
