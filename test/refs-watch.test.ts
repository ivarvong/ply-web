// Watched refs (src/refs-watch.ts, src/gitcache.ts wrefs): who grants the long policy, when a repo is purged (a change,
// a first baseline, a gap, a failing repo, a fill that saw refs the watcher did not), the repeat purge, and GitCache's
// side (key kind, policy, tag, lease timeout, seen report, the purge RPC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAIL_PURGE_MS, HEALTHY_MS, LEASE_MS, LEASE_TIMEOUT_MS, SECOND_PURGE_MS, WATCHED_REFS_CACHE, WATCH_GAP_MS, WATCH_TICK_MS,
  applyTick, emptyState, leaseRepo, needsAlarm, parseLsRefsAnswer, pollList, purgeFailed, refMapOf, refsTag, sawRefs,
  type PollResult, type RefMap,
} from '../src/refs-watch.ts';
import {
  H_FILLED, H_REFS_POLICY, REFS_CACHE, REFS_STATE_HEADER, createLoopbackFetch, keyHash, keyPath, purgeRefsTags, refsState, routedKind,
  serveGitCache, type LoopbackBinding,
} from '../src/gitcache.ts';
import { ATTR_REFS_AGE, ATTR_REFS_POLICY, createRayLog, durationMs, observeUpstream, parseCfRay, stampUpstreamSpans } from '../src/rays.ts';
import { PUBLIC_GIT_ORIGIN, PUBLIC_NAMESPACE, type TokenSource } from '../src/public.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const PUB = `${PUBLIC_GIT_ORIGIN}/git/${PUBLIC_NAMESPACE}/ply.git`;
const GH = 'https://github.com/octocat/Hello-World.git';
const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
const enc = (s: string) => new TextEncoder().encode(s);
const LSREFS = enc(`${pkt('command=ls-refs\n')}0001${pkt('symrefs\n')}${pkt('ref-prefix HEAD\n')}0000`);
const ok = (refs: RefMap): PollResult => ({ ok: true, refs });
const main = (oid: string): RefMap => ({ HEAD: oid, 'HEAD->': 'refs/heads/main', 'refs/heads/main': oid });

test('lease: a new repo is not granted until the watcher has polled it; then only while its last poll is recent', () => {
  const s = emptyState();
  const t = 1_000_000;
  assert.deepEqual(leaseRepo(s, 'ply', t), { grant: false, reason: 'new' });
  assert.deepEqual(leaseRepo(s, 'ply', t + 1), { grant: false, reason: 'unpolled' });
  assert.deepEqual(leaseRepo(s, '../x', t), { grant: false, reason: 'bad_name' });
  applyTick(s, { ply: ok(main(A)) }, t + 100);
  assert.deepEqual(leaseRepo(s, 'ply', t + 200), { grant: true, reason: 'ok' });
  assert.deepEqual(leaseRepo(s, 'ply', t + 100 + HEALTHY_MS + 1), { grant: false, reason: 'stale' });
  applyTick(s, { ply: { ok: false, error: 'down' } }, t + 100 + HEALTHY_MS + 2);
  assert.deepEqual(leaseRepo(s, 'ply', t + 100 + HEALTHY_MS + 3), { grant: false, reason: 'failing' });
  assert.ok((s.repos['ply'] as { lease: number }).lease >= t + 100 + HEALTHY_MS + 3 + LEASE_MS - 1, 'each lease extends the watch');
});

test('tick: a first baseline and every change purge, and each purge repeats SECOND_PURGE_MS later; no change, no purge', () => {
  const s = emptyState();
  let t = 5_000_000;
  leaseRepo(s, 'ply', t);
  let r = applyTick(s, { ply: ok(main(A)) }, t);
  assert.deepEqual(r.purge, ['ply'], 'an answer from an earlier lease may still be cached');
  t += WATCH_TICK_MS;
  r = applyTick(s, { ply: ok(main(A)) }, t);
  assert.deepEqual(r.purge, []);
  t += WATCH_TICK_MS;
  r = applyTick(s, { ply: ok(main(B)) }, t);
  assert.deepEqual(r.purge, ['ply']);
  assert.deepEqual(r.changed, [{ repo: 'ply', from: A.slice(0, 12), to: B.slice(0, 12) }]);
  const due = s.again['ply'] as number;
  assert.equal(due, t + SECOND_PURGE_MS);
  r = applyTick(s, { ply: ok(main(B)) }, t + WATCH_TICK_MS);
  assert.deepEqual(r.purge, [], 'not due yet');
  r = applyTick(s, { ply: ok(main(B)) }, due);
  assert.deepEqual(r.purge, ['ply']);
  assert.deepEqual(r.again, ['ply']);
  assert.equal('ply' in s.again, false, 'a repeat is not repeated');
  // a tag or branch moving is a change too, and so is HEAD retargeting
  r = applyTick(s, { ply: ok({ ...main(B), 'refs/tags/v1': C }) }, due + WATCH_TICK_MS);
  assert.deepEqual(r.purge, ['ply']);
  r = applyTick(s, { ply: ok({ ...main(B), 'refs/tags/v1': C, 'HEAD->': 'refs/heads/dev' }) }, due + 2 * WATCH_TICK_MS);
  assert.deepEqual(r.purge, ['ply']);
});

test('tick: a gap purges every leased repo; a failing repo is purged once after FAIL_PURGE_MS; an expired lease stops the watch', () => {
  const s = emptyState();
  let t = 9_000_000;
  leaseRepo(s, 'ply', t);
  leaseRepo(s, 'curl', t);
  applyTick(s, { ply: ok(main(A)), curl: ok(main(B)) }, t);
  t += WATCH_TICK_MS;
  assert.deepEqual(applyTick(s, { ply: ok(main(A)), curl: ok(main(B)) }, t).purge, []);
  t += WATCH_GAP_MS + 1;
  const g = applyTick(s, { ply: ok(main(A)), curl: ok(main(B)) }, t);
  assert.equal(g.gap, true);
  assert.deepEqual(g.purge, ['curl', 'ply'], 'a push inside the gap (even one reverted) is not missed');
  // failing
  t += WATCH_TICK_MS;
  assert.deepEqual(applyTick(s, { ply: { ok: false, error: 'x' }, curl: ok(main(B)) }, t).purge, []);
  const failStart = t;
  t = failStart + FAIL_PURGE_MS;
  assert.deepEqual(applyTick(s, { ply: { ok: false, error: 'x' }, curl: ok(main(B)) }, t).purge.includes('ply'), true);
  t += WATCH_TICK_MS;
  assert.deepEqual(applyTick(s, { ply: { ok: false, error: 'x' }, curl: ok(main(B)) }, t).purge.includes('ply'), false, 'once per failure');
  // recovered: a different head than before the failure is a change
  t += WATCH_TICK_MS;
  assert.deepEqual(applyTick(s, { ply: ok(main(C)), curl: ok(main(B)) }, t).changed.map(c => c.repo), ['ply']);
  // a repo leased while a tick's polls were in flight has no poll: left alone, not failing
  leaseRepo(s, 'deepfile', t);
  applyTick(s, { ply: ok(main(C)), curl: ok(main(B)) }, t + 1);
  assert.equal((s.repos['deepfile'] as { failingSince: number | null }).failingSince, null);
  assert.deepEqual(pollList(s), ['curl', 'deepfile', 'ply']);
  // expiry
  const end = t + LEASE_MS + 1;
  const e = applyTick(s, {}, end);
  assert.deepEqual(e.expired.sort(), ['curl', 'deepfile', 'ply']);
  assert.deepEqual(Object.keys(s.repos), []);
  // repeats still outstanding keep the alarm; once they ran, it stops
  assert.equal(needsAlarm(s), Object.keys(s.again).length > 0);
  applyTick(s, {}, end + SECOND_PURGE_MS);
  assert.equal(needsAlarm(s), false);
});

test('seen: a fill that stored refs the watcher has not seen purges at the next tick; a failed purge is retried', () => {
  const s = emptyState();
  const t = 2_000_000;
  leaseRepo(s, 'ply', t);
  assert.equal(sawRefs(s, 'ply', [['HEAD', A]]), false, 'no baseline yet: nothing to compare');
  applyTick(s, { ply: ok(main(A)) }, t);
  applyTick(s, { ply: ok(main(A)) }, t + WATCH_TICK_MS);
  assert.equal(sawRefs(s, 'ply', [['HEAD', A], ['refs/heads/main', A], ['HEAD->', 'refs/heads/main']]), false);
  assert.equal(sawRefs(s, 'ply', [['HEAD', B]]), true, 'a push and its revert inside one tick');
  assert.equal(sawRefs(s, 'other', [['HEAD', B]]), false);
  assert.equal(needsAlarm(s), true);
  const r = applyTick(s, { ply: ok(main(A)) }, t + 2 * WATCH_TICK_MS);
  assert.deepEqual(r.purge, ['ply']);
  purgeFailed(s, r.purge);
  assert.deepEqual(applyTick(s, { ply: ok(main(A)) }, t + 3 * WATCH_TICK_MS).purge, ['ply']);
  // a watcher whose ls-refs carried no symref target does not count HEAD-> as a difference
  const t2 = emptyState();
  leaseRepo(t2, 'ply', t);
  applyTick(t2, { ply: ok({ HEAD: A }) }, t);
  assert.equal(sawRefs(t2, 'ply', [['HEAD', A], ['HEAD->', 'refs/heads/main']]), false);
});

test('parseLsRefsAnswer and refMapOf agree on the same listing', () => {
  const body = enc(`${pkt(`${A} HEAD symref-target:refs/heads/main\n`)}${pkt(`${A} refs/heads/main\n`)}${pkt(`${B} refs/tags/v1 peeled:${C}\n`)}${pkt('unborn HEAD\n')}0000`);
  const parsed = parseLsRefsAnswer(body);
  assert.deepEqual(parsed, [['HEAD', A], ['HEAD->', 'refs/heads/main'], ['refs/heads/main', A], ['refs/tags/v1', B]]);
  const map = refMapOf([{ name: 'HEAD', oid: A }, { name: 'refs/heads/main', oid: A }, { name: 'refs/tags/v1', oid: B }], 'refs/heads/main');
  assert.deepEqual(Object.fromEntries(parsed), map);
  assert.deepEqual(parseLsRefsAnswer(enc('zzzz')), []);
  assert.deepEqual(parseLsRefsAnswer(enc('0000')), []);
  assert.equal(refsTag('ply'), `ply-refs-${PUBLIC_NAMESPACE}-ply`);
});

test('routedKind: only a public-namespace ls-refs becomes wrefs, and only with the watched policy on', () => {
  assert.equal(routedKind('refs', 'POST', `${PUB}/git-upload-pack`, { watchedRefs: true }), 'wrefs');
  assert.equal(routedKind('refs', 'POST', `${PUB}/git-upload-pack`, { watchedRefs: false }), 'refs');
  assert.equal(routedKind('refs', 'POST', `${GH}/git-upload-pack`, { watchedRefs: true }), 'refs', 'forges keep the 15 s policy');
  assert.equal(routedKind('pack', 'POST', `${PUB}/git-upload-pack`, { watchedRefs: true }), 'pack');
  assert.equal(routedKind(null, 'POST', `${PUB}/git-upload-pack`, { watchedRefs: true }), null);
});

test('createLoopbackFetch: a watched ls-refs uses the wrefs key and reports policy and age to the ray log and span', async () => {
  const urls: string[] = [];
  const filled = Date.now() - 42_000;
  const binding: LoopbackBinding = {
    async fetch(req) {
      urls.push(new URL(req.url).pathname);
      return new Response('refs', { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result', 'cf-cache-status': 'HIT', [H_REFS_POLICY]: 'watched;ok', [H_FILLED]: String(filled) } });
    },
  };
  const rays = createRayLog();
  const f = observeUpstream(createLoopbackFetch(async () => new Response('d'), () => binding, { watchedRefs: true }), rays);
  const res = await f(`${PUB}/git-upload-pack`, { method: 'POST', body: LSREFS, headers: { 'git-protocol': 'version=2' } });
  assert.equal(urls[0], keyPath('wrefs', await keyHash('wrefs', `${PUB}/git-upload-pack`, 'version=2', LSREFS)));
  assert.match(String(res.headers.get(REFS_STATE_HEADER)), /^watched;ok;age=4[12]$/);
  const span = { name: 'git.upload-pack ls-refs', startTimeUnixNano: '1', attrs: { 'http.request.method': 'POST' } as Record<string, unknown> };
  stampUpstreamSpans([span], rays.report());
  assert.equal(span.attrs[ATTR_REFS_POLICY], 'watched;ok');
  assert.ok([41, 42].includes(span.attrs[ATTR_REFS_AGE] as number));
  // off: the refs key, and the short policy reported
  const g = createLoopbackFetch(async () => new Response('d'), () => binding);
  const r2 = await g(`${PUB}/git-upload-pack`, { method: 'POST', body: LSREFS, headers: { 'git-protocol': 'version=2' } });
  assert.match(String(urls[1]), /\/refs\//);
  assert.match(String(r2.headers.get(REFS_STATE_HEADER)), /^short;ttl;age=/);
  assert.equal(refsState('pack', new Headers(), 0), null);
  assert.equal(refsState('wrefs', new Headers(), 0), 'none;age=-1');
  void durationMs; void parseCfRay;
});

function tokens(): TokenSource {
  const tok = `art_v1_${'c4c4'.repeat(10)}?expires=4102444800`;
  return { readToken: async () => tok, secrets: () => [tok] };
}

async function wrefsRequest(url: string, body: Uint8Array) {
  const hash = await keyHash('wrefs', url, 'version=2', body);
  const headers = new Headers({ 'x-ply-gc-url': url, 'x-ply-gc-proto': 'version=2', 'x-ply-gc-ua': 'ply-test', 'x-ply-gc-body': btoa(String.fromCharCode(...body)) });
  return new Request(`https://gitcache.internal${keyPath('wrefs', hash)}`, { headers });
}

function watchCtx(lease: (repo: string) => Promise<{ grant: boolean; reason: string }>) {
  const seen: [string, [string, string][]][] = [];
  const waited: Promise<unknown>[] = [];
  const ns = {
    idFromName: (n: string) => n,
    get: () => ({ lease, seen: async (repo: string, refs: [string, string][]) => { seen.push([repo, refs]); return false; } }),
  };
  return { seen, waited, ctx: { exports: { RefsWatch: ns }, waitUntil: (p: Promise<unknown>) => { waited.push(p); } } };
}

const LISTING = `${pkt(`${A} HEAD symref-target:refs/heads/main\n`)}0000`;
const up: typeof globalThis.fetch = async () => new Response(LISTING, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });

test('serveGitCache wrefs: a granted lease stores the watched policy with the repo tag and reports the refs; anything else stores 5 s + 10 s', async () => {
  const granted = watchCtx(async () => ({ grant: true, reason: 'ok' }));
  const res = await serveGitCache(await wrefsRequest(`${PUB}/git-upload-pack`, LSREFS), tokens(), granted.ctx, up);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), WATCHED_REFS_CACHE);
  assert.match(String(res.headers.get('cache-tag')), new RegExp(`,${refsTag('ply')}$`));
  assert.equal(res.headers.get(H_REFS_POLICY), 'watched;ok');
  assert.ok(Number(res.headers.get(H_FILLED)) > 0);
  assert.equal(await res.text(), LISTING);
  await Promise.all(granted.waited);
  assert.deepEqual(granted.seen, [['ply', [['HEAD', A], ['HEAD->', 'refs/heads/main']]]]);
  const refused = watchCtx(async () => ({ grant: false, reason: 'new' }));
  const short = await serveGitCache(await wrefsRequest(`${PUB}/git-upload-pack`, LSREFS), tokens(), refused.ctx, up);
  assert.equal(short.headers.get('cache-control'), REFS_CACHE);
  assert.equal(short.headers.get(H_REFS_POLICY), 'short;new');
  assert.match(String(short.headers.get('cache-tag')), new RegExp(refsTag('ply')), 'tagged even when short');
  assert.deepEqual(refused.seen, []);
  const broken = watchCtx(async () => { throw new Error('do down'); });
  assert.equal((await serveGitCache(await wrefsRequest(`${PUB}/git-upload-pack`, LSREFS), tokens(), broken.ctx, up)).headers.get('cache-control'), REFS_CACHE);
  const none = await serveGitCache(await wrefsRequest(`${PUB}/git-upload-pack`, LSREFS), tokens(), {}, up);
  assert.equal(none.headers.get('cache-control'), REFS_CACHE, 'no RefsWatch: short');
  // a wrefs key for a forge is not a watched exchange
  assert.equal((await serveGitCache(await wrefsRequest(`${GH}/git-upload-pack`, LSREFS), tokens(), granted.ctx, up)).status, 403);
});

test('serveGitCache wrefs: a lease that does not answer within LEASE_TIMEOUT_MS stores the short policy', async () => {
  const slow = watchCtx(() => new Promise(() => {}));
  const t0 = Date.now();
  const res = await serveGitCache(await wrefsRequest(`${PUB}/git-upload-pack`, LSREFS), tokens(), slow.ctx, up);
  assert.equal(res.headers.get('cache-control'), REFS_CACHE);
  assert.ok(Date.now() - t0 >= LEASE_TIMEOUT_MS - 50);
});

test('purgeRefsTags: one purge of every repo tag from the calling entrypoint; a refusal or a throw is reported, never thrown', async () => {
  const calls: unknown[] = [];
  const ctx = { cache: { purge: async (o: unknown) => { calls.push(o); return { success: true, errors: [] }; } } };
  assert.deepEqual((await purgeRefsTags(ctx, ['ply', 'curl', '../bad'])).ok, true);
  assert.deepEqual(calls, [{ tags: [refsTag('ply'), refsTag('curl')] }]);
  assert.deepEqual(await purgeRefsTags(ctx, []), { ok: true, ms: 0, error: '' });
  const limited = await purgeRefsTags({ cache: { purge: async () => ({ success: false, errors: [{ code: 1, message: 'rate limited' }] }) } }, ['ply']);
  assert.equal(limited.ok, false);
  assert.match(limited.error, /rate limited/);
  assert.equal((await purgeRefsTags({ cache: { purge: async () => { throw new Error('boom'); } } }, ['ply'])).ok, false);
  assert.equal((await purgeRefsTags({}, ['ply'])).ok, false);
  assert.equal((await purgeRefsTags(ctx, Array.from({ length: 101 }, (_, i) => `r${i}`))).ok, false);
});
