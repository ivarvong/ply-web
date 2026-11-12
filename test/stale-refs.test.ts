// Viewer stale refs on a slow upstream (504-diagnosis a179dd82, 2026-11-12): Codeberg's ls-refs body took ~10 s and the
// 12 s requestTimeoutMs cut the page. Expected values are hand-derived from the owner decision: past the budget with a
// last good list -> that list, marked stale with its age; no list -> wait for the live answer as today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFS_STALE_BUDGET_MS, createRefsMemo, refsOrStale } from '../src/viewer/refmemo.ts';
import { VIEWER_CAPS } from '../src/viewer/limits.ts';

const after = <T>(ms: number, v: T) => new Promise<T>(r => setTimeout(() => r(v), ms));
const never = <T>() => new Promise<T>(() => {});

test('budget leaves most of the request timeout for the page', () => {
  assert.ok(REFS_STALE_BUDGET_MS >= 3_000 && REFS_STALE_BUDGET_MS <= 4_000);
  assert.ok(VIEWER_CAPS.requestTimeoutMs - REFS_STALE_BUDGET_MS >= 8_000);
});

test('slow body past the budget with an expired entry: stale list, age, background refresh replaces it', async () => {
  const memo = createRefsMemo(8);
  memo.put('k', { refs: ['old'] }, 1_000);
  const deferred: Promise<unknown>[] = [];
  let resolveLive: (v: { refs: string[] }) => void = () => {};
  const live = new Promise<{ refs: string[] }>(r => { resolveLive = r; });
  const got = await refsOrStale(memo, 'k', live, { budgetMs: 30, now: () => 61_000, defer: p => deferred.push(p) });
  assert.deepEqual(got, { value: { refs: ['old'] }, stale: { asOf: 1_000, ageMs: 60_000, budgetMs: 30 } });
  assert.equal(deferred.length, 1);
  resolveLive({ refs: ['new'] });
  await Promise.all(deferred);
  assert.deepEqual(memo.get('k'), { value: { refs: ['new'] }, at: 61_000 });
  const next = await refsOrStale(memo, 'k', Promise.resolve({ refs: ['new'] }), { budgetMs: 30, now: () => 62_000, defer: null });
  assert.deepEqual(next, { value: { refs: ['new'] }, stale: null });
});

test('no entry: waits for the live answer (and its failure) as today', async () => {
  const memo = createRefsMemo(8);
  const got = await refsOrStale(memo, 'k', after(60, { refs: ['live'] }), { budgetMs: 10, now: () => 5, defer: null });
  assert.deepEqual(got, { value: { refs: ['live'] }, stale: null });
  const timeout = Object.assign(new Error('timeout'), { code: 'timeout' });
  await assert.rejects(refsOrStale(createRefsMemo(8), 'k', Promise.reject(timeout), { budgetMs: 10, now: () => 5, defer: null }), /timeout/);
});

test('fast upstream: fresh, no stale marker, entry updated', async () => {
  const memo = createRefsMemo(8);
  memo.put('k', { refs: ['old'] }, 1);
  const got = await refsOrStale(memo, 'k', after(1, { refs: ['fresh'] }), { budgetMs: 200, now: () => 9, defer: null });
  assert.deepEqual(got, { value: { refs: ['fresh'] }, stale: null });
  assert.deepEqual(memo.get('k'), { value: { refs: ['fresh'] }, at: 9 });
});

test('a live failure after a stale serve keeps the last good entry', async () => {
  const memo = createRefsMemo(8);
  memo.put('k', { refs: ['old'] }, 1);
  const deferred: Promise<unknown>[] = [];
  let fail: (e: Error) => void = () => {};
  const live = new Promise<{ refs: string[] }>((_, j) => { fail = j; });
  const got = await refsOrStale(memo, 'k', live, { budgetMs: 5, now: () => 2, defer: p => deferred.push(p) });
  assert.ok(got.stale);
  fail(new Error('timeout'));
  await Promise.all(deferred);
  assert.deepEqual(memo.get('k'), { value: { refs: ['old'] }, at: 1 });
  void never;
});

test('memo is bounded: oldest key evicted', () => {
  const memo = createRefsMemo(2);
  memo.put('a', 1, 1); memo.put('b', 2, 2); memo.put('c', 3, 3);
  assert.equal(memo.get('a'), null);
  assert.deepEqual(memo.get('c'), { value: 3, at: 3 });
});
