// The batched rate limiter (docs/rate-limit.md): the counter's SQL on real SQLite (node:sqlite), the batcher under a
// virtual clock, the cached document, and the request-path decision end to end with a fake ctx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyCfBundle } from './cf-bundle.js';
import { CounterCore, InvalidBatch, blockedUntil, firstLiveSlot, type ApplyRequest, type ApplyResult, type SqlExec, type SqlValue } from '../src/rate/core.ts';
import { Batcher, defaultTuning, type BatcherDeps, type FlushReport } from '../src/rate/batcher.ts';
import { SLOT_MS, WINDOW_MS, DOC_PATH, DOC_URL, KEY_HEX, MEMO_FALLBACK_MS, MEMO_REFRESH_ABANDON_MS, MEMO_REFRESH_MS, PRUNE_BATCH_ROWS, DEDUPE_RETENTION_MS } from '../src/rate/config.ts';
import { indexDoc, serveDoc } from '../src/rate/doc.ts';
import type { RefreshTrigger } from '../src/rate/admit.ts';

const COLD_START: RefreshTrigger = { kind: 'cold', cause: { kind: 'isolate_start' } };
const STALE: RefreshTrigger = { kind: 'stale' };
import { counterNamespace } from '../src/rate/stub.ts';
import { admitBatched, coldCause, parseFault, rateIdentity, readDoc, readMemo, refreshMemo, resetRateState, LOAD_CLIENT_HEADER, LOAD_MODE_HEADER, LOAD_TOKEN_HEADER } from '../src/rate/admit.ts';

function sqlite(): SqlExec {
  const db = new DatabaseSync(':memory:');
  return (q: string, ...b: SqlValue[]) => {
    const stmt = db.prepare(q);
    if (/^\s*select/i.test(q)) {
      const rows = stmt.all(...b) as Record<string, SqlValue>[];
      return { toArray: () => rows, rowsWritten: 0 };
    }
    const r = stmt.run(...b);
    return { toArray: () => [], rowsWritten: Number(r.changes) };
  };
}

const K1 = 'aaaaaaaaaaaaaaaa';
const K2 = 'bbbbbbbbbbbbbbbb';
const LIMITS: readonly [number, number] = [60, 20];

function req(id: string, entries: ApplyRequest['entries'], attempt = 1): ApplyRequest {
  return { id, attempt, limits: LIMITS, entries, fault: null };
}

test('core: counts, and an id applies once however often it is replayed', () => {
  const core = new CounterCore(sqlite());
  const t = 1_000_000_000_000;
  const first = core.apply(req('iso:1', [[K1, 0, 30]]), t);
  assert.equal(first.replay, false);
  assert.ok(first.rowsWritten >= 2);
  for (let i = 0; i < 5; i++) {
    const again = core.apply(req('iso:1', [[K1, 0, 30]], i + 2), t + i);
    assert.equal(again.replay, true);
  }
  // 30 counted once: 29 more stays under 60.
  assert.equal(core.apply(req('iso:2', [[K1, 0, 29]]), t + 10).newBlocks, 0);
  assert.equal(core.doc(t + 10).entries.length, 0);
  const crossing = core.apply(req('iso:3', [[K1, 0, 1]]), t + 20);
  assert.equal(crossing.newBlocks, 1);
  const doc = core.doc(t + 20);
  assert.deepEqual(doc.entries.map(e => [e[0], e[1], e[3]]), [[K1, 0, t + 20]]);
  assert.equal(crossing.over[0].peak, 60);
});

test('core: page and pack buckets are separate, and keys are separate', () => {
  const core = new CounterCore(sqlite());
  const t = 1_000_000_000_000;
  core.apply(req('a:1', [[K1, 1, 20], [K2, 0, 20]]), t);
  const doc = core.doc(t);
  assert.deepEqual(doc.entries.map(e => `${e[0]}:${e[1]}`), [`${K1}:1`]);
});

test('core: window edges — a hit counts until its slot end + 60 s, then the block lifts', () => {
  const core = new CounterCore(sqlite());
  const slotStart = Math.floor(1_000_000_000_000 / SLOT_MS) * SLOT_MS;
  const t = slotStart + 3_000;
  core.apply(req('w:1', [[K1, 0, 60]]), t);
  const until = core.doc(t).entries[0][2];
  assert.equal(until, slotStart + SLOT_MS + WINDOW_MS);
  assert.equal(core.doc(until - 1).entries.length, 1);
  assert.equal(core.doc(until).entries.length, 0);
  // At `until` the slot is out of the window: one more hit is 1, not 61.
  const after = core.apply(req('w:2', [[K1, 0, 1]]), until);
  assert.equal(after.newBlocks, 0);
  assert.equal(firstLiveSlot(until), Math.floor(slotStart / SLOT_MS) + 1);
});

test('core: blockedUntil drops oldest slots until the sum is under the limit', () => {
  const slots = [{ slot: 10, n: 30 }, { slot: 11, n: 20 }, { slot: 12, n: 20 }];
  assert.equal(blockedUntil(slots, 70, 60), 11 * SLOT_MS + WINDOW_MS);
  assert.equal(blockedUntil(slots, 70, 30), 12 * SLOT_MS + WINDOW_MS);
});

test('core: overshoot is peak − limit; until moves out as admitted hits keep coming', () => {
  const core = new CounterCore(sqlite());
  const t = Math.floor(1_000_000_000_000 / SLOT_MS) * SLOT_MS;
  core.apply(req('o:1', [[K1, 0, 30]]), t);
  const crossing = core.apply(req('o:2', [[K1, 0, 30]]), t + SLOT_MS);
  assert.equal(crossing.newBlocks, 1);
  assert.equal(core.doc(t + SLOT_MS).entries[0][2], t + SLOT_MS + WINDOW_MS, 'dropping the first slot is enough');
  const g1 = core.gen();
  const r = core.apply(req('o:3', [[K1, 0, 31]]), t + 2 * SLOT_MS);
  assert.equal(r.newBlocks, 0);
  assert.equal(r.over[0].peak, 91);
  assert.equal(r.over[0].crossed, t + SLOT_MS);
  assert.equal(core.doc(t + 2 * SLOT_MS).entries[0][2], t + 2 * SLOT_MS + WINDOW_MS, 'now the first two slots must go');
  assert.ok(core.gen() > g1, 'a moved until bumps the generation');
});

test('core: pruning removes old ids, slots and ended blocks', () => {
  const core = new CounterCore(sqlite());
  const t = 1_000_000_000_000;
  core.apply(req('p:1', [[K1, 0, 60]]), t);
  core.apply(req('p:2', [[K2, 0, 1]]), t + 11 * 60_000);
  assert.deepEqual(core.sizes(), { hits: 1, batches: 1, blocked: 0 });
  // p:1 is gone from the dedupe table after retention: documented bound, far beyond the 5 s client deadline.
});

test('core: a retention backlog is pruned in bounded slices, never thousands of rows in one apply', () => {
  const core = new CounterCore(sqlite());
  const t = 1_000_000_000_000;
  // 2,000 batches and 2,000 hit slots, all past retention by the time the next apply runs (an idle spell).
  for (let i = 0; i < 2_000; i++) core.apply(req(`old:${i}`, [[i.toString(16).padStart(KEY_HEX, '0'), 0, 1]]), t);
  assert.deepEqual(core.sizes(), { hits: 2_000, batches: 2_000, blocked: 0 });
  let now = t + DEDUPE_RETENTION_MS + 60_000;
  let applies = 0;
  let maxRows = 0;
  while (core.sizes().batches > 1 + applies || core.sizes().hits > 1 + applies) {
    const r = core.apply(req(`new:${applies}`, [[K1, 0, 1]]), now);
    maxRows = Math.max(maxRows, r.rowsWritten);
    applies++;
    now += 10; // far inside PRUNE_EVERY_MS: the backlog, not the timer, keeps the prune going
    assert.ok(applies < 100, 'the backlog drains');
  }
  // One apply: its own few writes + at most PRUNE_BATCH_ROWS per table.
  assert.ok(maxRows <= 3 * PRUNE_BATCH_ROWS + 5, `max rows written per apply ${maxRows}`);
  assert.equal(applies, Math.ceil(2_000 / PRUNE_BATCH_ROWS));
  // Drained: the next apply after the timer prunes nothing old.
  const quiet = core.apply(req('after', [[K2, 0, 1]]), now + 6_000);
  assert.ok(quiet.rowsWritten <= 5);
});

test('core: rejects what an isolate would never send', () => {
  const core = new CounterCore(sqlite());
  const bad: ApplyRequest[] = [
    req('', [[K1, 0, 1]]),
    req('x y', [[K1, 0, 1]]),
    req('ok:1', [['ZZ', 0, 1]]),
    req('ok:1', [[K1, 2, 1]]),
    req('ok:1', [[K1, 0, 0]]),
    { ...req('ok:1', [[K1, 0, 1]]), limits: [0, 20] },
  ];
  for (const r of bad) assert.throws(() => core.apply(r, 1), InvalidBatch);
});

// ---- a virtual clock for the batcher ----

class Clock {
  t = 1_000_000_000_000;
  timers: { at: number; fire: () => void }[] = [];
  now = (): number => this.t;
  sleep = (ms: number): Promise<void> => new Promise(resolve => { this.timers.push({ at: this.t + ms, fire: resolve }); });
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flushMicrotasks();
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (next === void 0 || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fire();
    }
    this.t = end;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

type Harness = { clock: Clock; core: CounterCore; batcher: Batcher; reports: FlushReport[]; sends: ApplyRequest[] };

function harness(send: (h: { clock: Clock; core: CounterCore }, r: ApplyRequest) => Promise<ApplyResult>, tuning: Partial<BatcherDeps> = {}): Harness {
  const clock = new Clock();
  const core = new CounterCore(sqlite());
  const reports: FlushReport[] = [];
  const sends: ApplyRequest[] = [];
  const batcher = new Batcher({
    now: clock.now,
    sleep: clock.sleep,
    send: r => { sends.push(r); return send({ clock, core }, r); },
    isolateId: () => 'iso',
    limits: () => LIMITS,
    report: r => { reports.push(r); },
    ...defaultTuning(),
    ...tuning,
  });
  return { clock, core, batcher, reports, sends };
}

const instant = ({ clock, core }: { clock: Clock; core: CounterCore }, r: ApplyRequest): Promise<ApplyResult> => Promise.resolve(core.apply(r, clock.now()));

test('batcher: hits within the linger are one RPC with one id; the next batch has the next id', async () => {
  const h = harness(instant);
  h.batcher.add(K1, 0, null);
  h.batcher.add(K1, 0, null);
  h.batcher.add(K2, 1, null);
  assert.equal(h.sends.length, 0, 'nothing is sent before the linger');
  await h.clock.advance(199);
  assert.equal(h.sends.length, 0);
  await h.clock.advance(1);
  assert.equal(h.sends.length, 1);
  assert.deepEqual([...h.sends[0].entries].sort(), [[K1, 0, 2], [K2, 1, 1]].sort());
  assert.equal(h.sends[0].id, 'iso:1');
  await h.clock.advance(1);
  assert.equal(h.reports[0].outcome, 'ok');
  assert.equal(h.reports[0].lingerMs, 200);
  h.batcher.add(K1, 0, null);
  await h.clock.advance(250);
  assert.equal(h.sends[1].id, 'iso:2');
  assert.equal(h.batcher.inflight, 0);
});

test('batcher: a DO that applies after the client gave up, plus the retry, counts once', async () => {
  // Attempt 1 applies at once but its answer takes 3 s (the client's 1.5 s timer wins); attempt 2 is answered at once.
  const h = harness(({ clock, core }, r) => {
    const result = core.apply(r, clock.now());
    if (r.attempt === 1) return clock.sleep(3_000).then(() => result);
    return Promise.resolve(result);
  });
  for (let i = 0; i < 60; i++) h.batcher.add(K1, 0, null);
  await h.clock.advance(200 + 1_500 + 50 + 10);
  const r = h.reports[0];
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(r.attempts.map(a => a.outcome), ['timeout', 'ok']);
  assert.equal(r.attempts[0].ms, 1_500);
  assert.equal(r.replay, true, 'the retry was acknowledged as a replay');
  assert.equal(new Set(h.sends.map(s => s.id)).size, 1, 'every attempt carries the same key');
  // Exactly 60 counted: one more admitted hit makes 61, and the block's peak is 60 before it.
  const doc = h.core.doc(h.clock.now());
  assert.equal(doc.entries.length, 1);
  const more = h.core.apply(req('other:1', [[K1, 0, 1]]), h.clock.now());
  assert.equal(more.over[0].sum, 61);
  await h.clock.advance(3_000);
});

test('batcher: a slow DO that applies late (after the retry) still counts once', async () => {
  // Attempt 1 is delivered late: it applies 2 s after it was sent. Attempt 2 applies first. Attempt 1 is then a replay.
  const h = harness(({ clock, core }, r) => {
    if (r.attempt === 1) return clock.sleep(2_000).then(() => core.apply(r, clock.now()));
    return Promise.resolve(core.apply(r, clock.now()));
  });
  for (let i = 0; i < 10; i++) h.batcher.add(K1, 0, null);
  await h.clock.advance(5_000);
  assert.equal(h.reports[0].outcome, 'ok');
  assert.equal(h.reports[0].replay, false, 'attempt 2 applied');
  const after = h.core.apply(req('x:1', [[K1, 0, 50]]), h.clock.now());
  assert.equal(after.over[0].sum, 60, '10 + 50: the late attempt 1 did not add 10 more');
});

test('batcher: errors are retried with backoff and the same id', async () => {
  let calls = 0;
  const h = harness(({ clock, core }, r) => {
    calls++;
    if (calls <= 2) return Promise.reject(new Error('Network connection lost'));
    return Promise.resolve(core.apply(r, clock.now()));
  });
  h.batcher.add(K1, 0, null);
  await h.clock.advance(1_000);
  const r = h.reports[0];
  assert.deepEqual(r.attempts.map(a => a.outcome), ['error', 'error', 'ok']);
  assert.equal(r.flushMs, 50 + 100);
  assert.match(r.attempts[0].error, /Network connection lost/);
  assert.equal(new Set(h.sends.map(s => s.id)).size, 1);
});

test('batcher: 5 s after the first attempt the batch is dropped and recorded (bounded under-count)', async () => {
  const h = harness(({ clock }) => clock.sleep(60_000).then(() => { throw new Error('never'); }));
  h.batcher.add(K1, 0, null);
  h.batcher.add(K1, 0, null);
  await h.clock.advance(200 + 5_000 + 10);
  const r = h.reports[0];
  assert.equal(r.outcome, 'dropped');
  assert.equal(r.deadlineHit, true);
  assert.equal(r.hits, 2);
  assert.ok(r.flushMs <= 5_000, `flush ${r.flushMs}`);
  assert.ok(r.attempts.length >= 4, `attempts ${r.attempts.length}`);
  assert.equal(r.attempts.every(a => a.outcome === 'timeout'), true);
  assert.equal(r.aliveMs, r.flushMs + 200);
  assert.equal(h.batcher.inflight, 0);
});

test('batcher: the accumulator is bounded — a full batch flushes at once; too many in flight are dropped', async () => {
  const h = harness(({ clock }) => clock.sleep(60_000).then(() => { throw new Error('x'); }), { maxKeys: 3, maxInflight: 2 });
  h.batcher.add('000000000000000a', 0, null);
  h.batcher.add('000000000000000b', 0, null);
  assert.equal(h.sends.length, 0);
  h.batcher.add('000000000000000c', 0, null);
  await h.clock.advance(0);
  assert.equal(h.sends.length, 1, 'the third key closed the batch without waiting for the linger');
  assert.equal(h.batcher.pending().keys, 0);
  h.batcher.add('000000000000000d', 0, null);
  assert.equal(h.batcher.inflight, 2);
  assert.equal(h.batcher.add('000000000000000e', 0, null) === null, false, 'joins the open batch');
  h.batcher.add('000000000000000f', 0, null);
  assert.equal(h.batcher.add('0000000000000010', 0, null), null, 'a third batch is over maxInflight');
  assert.equal(h.batcher.overflowDrops, 1);
  await h.clock.advance(6_000);
});

test('batcher: an isolate that dies before its flush loses only that batch', async () => {
  const h = harness(instant);
  for (let i = 0; i < 7; i++) h.batcher.add(K1, 0, null);
  await h.clock.advance(250);
  for (let i = 0; i < 3; i++) h.batcher.add(K1, 0, null);
  const lost = h.batcher.pending().hits;
  // The isolate is evicted here: its timers never fire. What reached the DO is everything but the open batch.
  const counted = h.core.apply(req('probe:1', [[K1, 0, 1]]), h.clock.now());
  assert.equal(lost, 3);
  assert.equal(counted.over.length, 0);
  const sum = h.core.apply(req('probe:2', [[K1, 0, 52]]), h.clock.now()).over[0].sum;
  assert.equal(sum, 7 + 1 + 52, 'the 3 hits in the open batch are the whole under-count');
});

test('batcher: a fault rides only on its own batch, flushed at once', async () => {
  const h = harness(instant);
  h.batcher.add(K1, 0, { kind: 'slow-ack', ms: 1500, attempts: 1 });
  await h.clock.advance(0);
  assert.equal(h.sends.length, 1, 'no linger: the faulted hit is sent at once');
  assert.deepEqual(h.sends[0].fault, { kind: 'slow-ack', ms: 1500, attempts: 1 });
  assert.deepEqual(h.sends[0].entries, [[K1, 0, 1]]);
  await h.clock.advance(250);
});

test('batcher: a faulted hit never joins, and never taints, the shared batch real clients are in', async () => {
  // Every attempt carrying a fault errors (as the DO does for error;attempts=n): the faulted batch is retried to its
  // deadline and dropped. The real clients' batch, open in the same isolate at the same time, is unaffected.
  const h = harness(({ clock, core }, r) => (r.fault !== null ? Promise.reject(new Error('injected')) : Promise.resolve(core.apply(r, clock.now()))));
  h.batcher.add(K1, 0, null);
  const faulted = h.batcher.add('000000000000000f', 0, { kind: 'error', ms: 0, attempts: 99 });
  h.batcher.add(K2, 0, null);
  assert.equal(h.batcher.pending().hits, 2, 'the open batch holds only the real hits');
  assert.equal(h.batcher.inflight, 2);
  await h.clock.advance(6_000);
  const shared = h.reports.find(r => r.fault === null);
  const own = h.reports.find(r => r.fault !== null);
  assert.ok(shared && own);
  assert.equal(shared.outcome, 'ok');
  assert.equal(shared.hits, 2);
  assert.deepEqual(shared.attempts.map(a => a.outcome), ['ok']);
  assert.equal(own.outcome, 'dropped');
  assert.equal(own.hits, 1);
  assert.equal(own.keys, 1);
  const faultedReport = await faulted;
  assert.ok(faultedReport);
  assert.equal(faultedReport.id, own.id);
  assert.notEqual(own.id, shared.id);
  assert.equal(h.sends.filter(s => s.fault === null).every(s => s.entries.every(e => e[0] !== '000000000000000f')), true);
  // The real counts reached the counter exactly once.
  assert.equal(h.core.apply(req('probe:x', [[K1, 0, 58]]), h.clock.now()).over.length, 0);
  assert.equal(h.core.apply(req('probe:y', [[K1, 0, 1]]), h.clock.now()).over[0].sum, 60);
});

test('batcher: an isolated (faulted) batch respects the in-flight bound', async () => {
  const h = harness(({ clock }) => clock.sleep(60_000).then(() => { throw new Error('x'); }), { maxInflight: 1 });
  assert.notEqual(h.batcher.add(K1, 0, { kind: 'error', ms: 0, attempts: 9 }), null);
  assert.equal(h.batcher.add(K2, 0, { kind: 'error', ms: 0, attempts: 9 }), null);
  assert.equal(h.batcher.overflowDrops, 1);
  await h.clock.advance(6_000);
});

test('fault header parse', () => {
  assert.deepEqual(parseFault('slow-ack=3000;attempts=2'), { kind: 'slow-ack', ms: 3000, attempts: 2 });
  assert.deepEqual(parseFault('slow-ack=3000'), { kind: 'slow-ack', ms: 3000, attempts: 1 });
  assert.deepEqual(parseFault('error;attempts=3'), { kind: 'error', ms: 0, attempts: 3 });
  assert.equal(parseFault('drop table'), null);
  assert.equal(parseFault(null), null);
});

// ---- the document ----

test('doc: served with max-age + SWR, one path only, and indexed by key and bucket', async () => {
  const core = new CounterCore(sqlite());
  core.apply(req('d:1', [[K1, 0, 60]]), 1_000_000_000_000);
  const source = { blockedDoc: async () => core.doc(1_000_000_000_000) };
  const res = await serveDoc(new Request(DOC_URL), source);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=1, stale-while-revalidate=30');
  assert.match(String(res.headers.get('etag')), /^"g\d+"$/);
  const d = indexDoc(await res.text());
  assert.equal(d.index.has(`${K1}:0`), true);
  assert.equal((await serveDoc(new Request(`https://rate.internal${DOC_PATH}x`), source)).status, 404);
  assert.equal((await serveDoc(new Request(DOC_URL, { method: 'POST' }), source)).status, 405);
  const failing = await serveDoc(new Request(DOC_URL), { blockedDoc: () => Promise.reject(new Error('down')) });
  assert.equal(failing.status, 503);
  assert.equal(failing.headers.get('cache-control'), 'no-store');
});

// ---- identity ----

test('identity: load-test headers count only with the right token', async () => {
  const env = { PLY_LOAD_TOKEN: 'secret-token-123', RATE_MODE: 'legacy', RATE_COUNTER: fakeNamespace(new CounterCore(sqlite())) };
  const plain = await rateIdentity(new Request('https://x/', { headers: { 'cf-connecting-ip': '198.51.100.1', [LOAD_CLIENT_HEADER]: 'c1', [LOAD_MODE_HEADER]: 'batched' } }), env, null);
  assert.equal(plain.load, false);
  assert.equal(plain.mode, 'legacy');
  assert.equal(plain.modeSource, 'default');
  const wrong = await rateIdentity(new Request('https://x/', { headers: { [LOAD_TOKEN_HEADER]: 'nope', [LOAD_CLIENT_HEADER]: 'c1', [LOAD_MODE_HEADER]: 'batched' } }), env, null);
  assert.equal(wrong.load, false);
  const right = await rateIdentity(new Request('https://x/', { headers: { [LOAD_TOKEN_HEADER]: 'secret-token-123', [LOAD_CLIENT_HEADER]: 'c1', [LOAD_MODE_HEADER]: 'batched' } }), env, null);
  assert.equal(right.load, true);
  assert.equal(right.mode, 'batched');
  assert.equal(right.modeSource, 'header');
  const other = await rateIdentity(new Request('https://x/', { headers: { [LOAD_TOKEN_HEADER]: 'secret-token-123', [LOAD_CLIENT_HEADER]: 'c2' } }), env, null);
  assert.notEqual(right.hex, other.hex);
  assert.equal(other.mode, 'legacy');
  assert.equal(other.modeSource, 'default', 'a load request with no mode header runs the default, like a real one');
  assert.equal(right.hex.length, 64);
});

test('identity: PLY_TOKEN (the /v1 bearer) does not unlock the load-test headers', async () => {
  const fault = { 'x-ply-rate-fault': 'error;attempts=3' };
  const apiOnly = { PLY_TOKEN: 'api-bearer-456', RATE_MODE: 'batched', RATE_COUNTER: fakeNamespace(new CounterCore(sqlite())) };
  const withApi = await rateIdentity(new Request('https://x/', { headers: { 'cf-connecting-ip': '198.51.100.7', [LOAD_TOKEN_HEADER]: 'api-bearer-456', [LOAD_CLIENT_HEADER]: 'c1', [LOAD_MODE_HEADER]: 'legacy', ...fault } }), apiOnly, null);
  assert.equal(withApi.load, false, 'no PLY_LOAD_TOKEN bound: nothing is a load request, whatever is presented');
  assert.equal(withApi.mode, 'batched');
  assert.equal(withApi.fault, null);
  const plainIp = await rateIdentity(new Request('https://x/', { headers: { 'cf-connecting-ip': '198.51.100.7' } }), apiOnly, null);
  assert.equal(withApi.hex, plainIp.hex, 'keyed by the address, the label ignored');
  const both = { ...apiOnly, PLY_LOAD_TOKEN: 'load-only-789' };
  const apiPresented = await rateIdentity(new Request('https://x/', { headers: { [LOAD_TOKEN_HEADER]: 'api-bearer-456', [LOAD_MODE_HEADER]: 'legacy', ...fault } }), both, null);
  assert.equal(apiPresented.load, false, 'PLY_TOKEN presented while PLY_LOAD_TOKEN is bound: still refused');
  assert.equal(apiPresented.fault, null);
  const loadPresented = await rateIdentity(new Request('https://x/', { headers: { [LOAD_TOKEN_HEADER]: 'load-only-789', [LOAD_MODE_HEADER]: 'legacy', ...fault } }), both, null);
  assert.equal(loadPresented.load, true);
  assert.equal(loadPresented.mode, 'legacy');
  assert.deepEqual(loadPresented.fault, { kind: 'error', ms: 0, attempts: 3 });
  const empty = await rateIdentity(new Request('https://x/', { headers: { [LOAD_TOKEN_HEADER]: '' } }), { ...apiOnly, PLY_LOAD_TOKEN: '' }, null);
  assert.equal(empty.load, false, 'an empty PLY_LOAD_TOKEN matches nothing');
});

// ---- end to end with a fake ctx: Workers Cache emulated with max-age, the DO as CounterCore ----

function fakeNamespace(core: CounterCore, clock: { now(): number } = { now: () => Date.now() }) {
  const stub = {
    apply: async (r: ApplyRequest) => core.apply(r, clock.now()),
    blockedDoc: async () => core.doc(clock.now()),
  };
  return { idFromName: (n: string) => n, get: () => stub };
}

test('admit: the client over its limit is refused once its batch is flushed and the cached document refreshes', async () => {
  resetRateState();
  const core = new CounterCore(sqlite());
  const ns = fakeNamespace(core);
  const env = { RATE_MODE: 'batched', RATE_COUNTER: ns, PLY_LOAD_TOKEN: 't' };
  let cached: { body: string; etag: string; at: string; storedAt: number } | null = null;
  let docReads = 0;
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { waits.push(p); },
    exports: {
      RateCache: {
        fetch: async (r: Request) => {
          if (cached !== null && Date.now() - cached.storedAt < 1_000) return new Response(cached.body, { headers: { etag: cached.etag, 'x-ply-rate-at': cached.at, 'cf-cache-status': 'HIT' } });
          docReads++;
          const res = await serveDoc(r, ns.get());
          const body = await res.text();
          cached = { body, etag: String(res.headers.get('etag')), at: String(res.headers.get('x-ply-rate-at')), storedAt: Date.now() };
          return new Response(body, { headers: { etag: cached.etag, 'x-ply-rate-at': cached.at, 'cf-cache-status': 'MISS' } });
        },
      },
    },
  };
  const id = { hex: 'c'.repeat(64), mode: 'batched' as const, fault: null, load: true, modeSource: 'default' as const };
  const limitFor = (b: 'page' | 'pack') => (b === 'page' ? 3 : 20);
  const attrs: Record<string, string | number | boolean> = {};
  const set = (k: string, v: string | number | boolean) => { attrs[k] = v; };
  for (let i = 0; i < 5; i++) {
    const d = await admitBatched({ ctx, env, id, bucket: 'page', now: Date.now(), limitFor, set });
    assert.equal(d.ok, true, 'within the lag every request is admitted (the overshoot)');
  }
  assert.equal(waits.length, 1, 'only the request that opened the batch waits for it');
  await Promise.all(waits);
  assert.equal(attrs['rate.cache'], 'HIT');
  await new Promise(r => setTimeout(r, 1_050));
  const denied = await admitBatched({ ctx, env, id, bucket: 'page', now: Date.now(), limitFor, set });
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterMs > 50_000);
  assert.equal(attrs['rate.decision'], 'deny');
  assert.equal(attrs['rate.cache'], 'MISS');
  assert.equal(docReads, 2);
  const other = { ...id, hex: 'd'.repeat(64) };
  assert.equal((await admitBatched({ ctx, env, id: other, bucket: 'page', now: Date.now(), limitFor, set })).ok, true);
  assert.equal(core.doc(Date.now()).entries[0][0], 'c'.repeat(KEY_HEX));
  await Promise.all(waits);
});

test('admit: a failed read uses the last good document, and with none admits (fail open)', async () => {
  resetRateState();
  const env = { RATE_MODE: 'batched', RATE_COUNTER: fakeNamespace(new CounterCore(sqlite())) };
  const ctx = { waitUntil: () => {}, exports: { RateCache: { fetch: async () => { throw new Error('down'); } } } };
  const r = await readDoc(ctx, Date.now());
  assert.equal(r.read, 'fail');
  const attrs: Record<string, string | number | boolean> = {};
  const d = await admitBatched({ ctx, env, id: { hex: 'e'.repeat(64), mode: 'batched', fault: null, load: false, modeSource: 'default' }, bucket: 'page', now: Date.now(), limitFor: () => 60, set: (k, v) => { attrs[k] = v; } });
  assert.equal(d.ok, true);
  assert.equal(attrs['rate.decision'], 'fail_open');
  resetRateState();
});

// ---- the deployed bundle under workerd: real RateCounter on SQLite, ctx.exports.RateCache, the load-test headers ----

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const WORKERD = [process.env.WORKERD, fileURLToPath(new URL('../node_modules/.bin/workerd', import.meta.url))].filter((p): p is string => !!p && existsSync(p));

async function workerdRun(withBinding: boolean): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ply-rate-'));
  const out = join(root, 'wk');
  mkdirSync(out);
  copyCfBundle(join(out, 'worker.mjs'));
  const port = await freePort();
  const token = 'load-token-' + 'y'.repeat(20);
  writeFileSync(join(out, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = (
    modules = [ (name = "worker.mjs", esModule = embed "worker.mjs") ],
    compatibilityDate = "2026-10-18",
    compatibilityFlags = ["nodejs_als"],
    durableObjectNamespaces = [ (className = "ViewerRateLimit", uniqueKey = "viewer-rate-test", enableSql = true), (className = "RateCounter", uniqueKey = "rate-counter-test", enableSql = true) ],
    durableObjectStorage = (localDisk = "do-disk"),
    bindings = [
      (name = "PLY_TOKEN", text = "api-${token}"),
      (name = "PLY_LOAD_TOKEN", text = "${token}"),
      (name = "WRITES", text = "off"),
      (name = "PACK_CACHE", text = "off"),
      (name = "VIEWER_RATE_PER_MIN", text = "3"),
      (name = "RATE_MODE", text = "batched"),
      (name = "VIEWER_RATE", durableObjectNamespace = "ViewerRateLimit")${withBinding ? ', (name = "RATE_COUNTER", durableObjectNamespace = "RateCounter")' : ''}
    ]
  )), (name = "do-disk", disk = (path = "${join(root, 'do')}", writable = true)), (name = "internet", network = (allow = ["private", "public", "local"])) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ]
);
`);
  mkdirSync(join(root, 'do'));
  let logs = '';
  const proc = spawn(WORKERD[0] as string, ['serve', join(out, 'config.capnp'), '--verbose'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => { logs += d; });
  proc.stderr.on('data', d => { logs += d; });
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { await sleep(100); }
    }
    assert.equal(up, true, logs.slice(-1500));
    const hit = (client: string, extra: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/view`, { headers: { [LOAD_TOKEN_HEADER]: token, [LOAD_CLIENT_HEADER]: client, ...extra } });
    // Limit 3. The batch flushes 200 ms after the first request; workerd has no Workers Cache, so the next read sees it.
    for (let i = 0; i < 3; i++) assert.equal((await hit('c1')).status, 200);
    await sleep(600);
    const refused = await hit('c1');
    assert.equal(refused.status, 429, `${await refused.text()}\n${logs.slice(-3000)}`);
    assert.ok(Number(refused.headers.get('retry-after')) >= 50);
    assert.equal((await hit('c2')).status, 200, 'another client is not refused');
    // Legacy arm through the same headers: its own per-client object.
    for (let i = 0; i < 3; i++) assert.equal((await hit('c3', { [LOAD_MODE_HEADER]: 'legacy' })).status, 200);
    assert.equal((await hit('c3', { [LOAD_MODE_HEADER]: 'legacy' })).status, 429);
    // Memo arm: decides from the isolate's document with no fetch. The first request after the flush still decides
    // from a document read before it (the memo's lag) and refreshes it; a later one is refused.
    for (let i = 0; i < 3; i++) assert.equal((await hit('c5', { [LOAD_MODE_HEADER]: 'memo' })).status, 200);
    await sleep(700);
    assert.equal((await hit('c5', { [LOAD_MODE_HEADER]: 'memo' })).status, 200, 'decided from the stale memo; refresh started');
    await sleep(300);
    const memoRefused = await hit('c5', { [LOAD_MODE_HEADER]: 'memo' });
    assert.equal(memoRefused.status, 429);
    assert.ok(Number(memoRefused.headers.get('retry-after')) >= 50);
    // A forged token is ignored: the headers do nothing and the request is keyed by its (absent) address.
    const forged = await fetch(`http://127.0.0.1:${port}/view`, { headers: { [LOAD_TOKEN_HEADER]: 'nope', [LOAD_CLIENT_HEADER]: 'c1' } });
    assert.equal(forged.status, 200);
    // The /v1 bearer is not the load token: presented as one, the label is ignored (keyed by the absent address, which
    // the forged request above already counted once), so c1's block does not apply to it.
    const apiAsLoad = await fetch(`http://127.0.0.1:${port}/view`, { headers: { [LOAD_TOKEN_HEADER]: `api-${token}`, [LOAD_CLIENT_HEADER]: 'c1' } });
    assert.equal(apiAsLoad.status, 200, 'PLY_TOKEN does not unlock x-ply-rate-client');
    if (!withBinding) return;
    // workerd prints a Durable Object's console only when it is reached through an env binding, so the fault half runs there.
    // Fault: the DO applies and holds its answer 1.5 s; the 1 s attempt timer fires, the retry with the same id is a replay.
    assert.equal((await hit('c4', { 'x-ply-rate-fault': 'slow-ack=1500;attempts=1' })).status, 200);
    await sleep(2_500);
    const applies = logs.split('\n').filter(l => l.includes('"ply.rate.apply"') && l.includes('slow-ack') === false).map(l => JSON.parse(l.slice(l.indexOf('{'))));
    const faulted = logs.split('\n').filter(l => l.includes('"ply.rate.apply"') && l.includes('slow-ack=1500')).map(l => JSON.parse(l.slice(l.indexOf('{'))));
    assert.equal(faulted.length, 1, logs.split('\n').filter(l => !l.includes('ply.request')).join('\n').slice(-3000));
    const replays = applies.filter(a => a.id === faulted[0].id);
    assert.equal(replays.length, 1, `one retry of the faulted batch\n${logs.split('\n').filter(l => l.includes('rate') || l.includes('rror')).join('\n').slice(-4000)}`);
    assert.equal(replays[0].replay, true);
    assert.equal(replays[0].attempt, 2);
    assert.equal(logs.includes(token), false, 'the load token never reaches a log');
    assert.equal(faulted[0].keys, 1, 'the faulted request flushed in a batch of its own');
  } finally {
    if (process.env.RATE_TEST_LOG) writeFileSync(process.env.RATE_TEST_LOG, logs);
    if (proc.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } }
    else proc.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
}

test('workerd: batched limiter through ctx.exports.RateCounter (production path) refuses within the lag', { skip: WORKERD.length === 0 && 'workerd not installed', timeout: 60_000 }, () => workerdRun(false));

test('workerd: a slow ack is retried with the same id and applied once (replay)', { skip: WORKERD.length === 0 && 'workerd not installed', timeout: 60_000 }, () => workerdRun(true));

test('counterNamespace: found on a ctx.exports that answers `in` with false (the platform object does)', () => {
  const ns = fakeNamespace(new CounterCore(sqlite()));
  const exportsLike = new Proxy({ RateCounter: ns }, { has: () => false });
  assert.equal('RateCounter' in exportsLike, false);
  assert.equal(counterNamespace({}, { exports: exportsLike }), ns);
  assert.equal(counterNamespace({}, { exports: {} }), null);
  // The platform's namespace is callable: typeof 'function', with idFromName.
  const callable = Object.assign(() => {}, ns);
  assert.equal(counterNamespace({}, { exports: { RateCounter: callable } }), callable);
  assert.equal(counterNamespace({}, null), null);
});

test('admit: the read never waits past its budget — late reads use the isolate memo, or admit with none', async () => {
  resetRateState();
  const core = new CounterCore(sqlite());
  core.apply(req('b:1', [['f'.repeat(KEY_HEX), 0, 60]]), Date.now());
  const ns = fakeNamespace(core);
  const env = { RATE_MODE: 'batched', RATE_COUNTER: ns };
  const waits: Promise<unknown>[] = [];
  // Every read is a slow MISS: 100 ms, four times the budget.
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, exports: { RateCache: { fetch: async (r: Request) => { await new Promise(res => setTimeout(res, 100)); return serveDoc(r, ns.get()); } } } };
  const id = { hex: 'f'.repeat(64), mode: 'batched' as const, fault: null, load: true, modeSource: 'default' as const };
  const attrs: Record<string, string | number | boolean> = {};
  const set = (k: string, v: string | number | boolean) => { attrs[k] = v; };
  const t0 = Date.now();
  const first = await admitBatched({ ctx, env, id, bucket: 'page', now: Date.now(), limitFor: () => 60, set });
  assert.ok(Date.now() - t0 < 80, 'did not wait for the slow read');
  assert.equal(first.ok, true, 'no document in this isolate yet: admitted (the bounded extra lag)');
  assert.equal(attrs['rate.read'], 'late_open');
  await Promise.all(waits);
  const second = await admitBatched({ ctx, env, id, bucket: 'page', now: Date.now(), limitFor: () => 60, set });
  assert.equal(second.ok, false, 'the late fetch refreshed the isolate document; this read decides from it');
  assert.equal(attrs['rate.read'], 'late_memo');
  await Promise.all(waits);
  resetRateState();
});

// ---- memo mode: the decision is a lookup into the isolate's document; refreshes are single-flight in waitUntil ----

function memoRig(fetchDelayMs: number) {
  const core = new CounterCore(sqlite());
  const ns = fakeNamespace(core);
  const env = { RATE_MODE: 'memo', RATE_COUNTER: ns };
  const waits: Promise<unknown>[] = [];
  let fetches = 0;
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { waits.push(p); },
    exports: { RateCache: { fetch: async (r: Request) => { fetches++; await new Promise(res => setTimeout(res, fetchDelayMs)); return serveDoc(r, ns.get()); } } },
  };
  const attrs: Record<string, string | number | boolean> = {};
  const set = (k: string, v: string | number | boolean) => { attrs[k] = v; };
  const id = (c: string) => ({ hex: c.repeat(64), mode: 'memo' as const, fault: null, load: true, modeSource: 'header' as const });
  const admit = (c: string) => admitBatched({ ctx, env, id: id(c), bucket: 'page', now: Date.now(), limitFor: () => 60, set });
  return { core, env, ctx, waits, attrs, admit, fetches: () => fetches, settle: () => Promise.all(waits) };
}

test('memo: a cold isolate admits at once (fail_open, read cold) and refreshes in waitUntil; then denies from the memo', async () => {
  resetRateState();
  const rig = memoRig(100);
  rig.core.apply(req('m:1', [['a'.repeat(KEY_HEX), 0, 60]]), Date.now());
  const t0 = Date.now();
  const first = await rig.admit('a');
  assert.ok(Date.now() - t0 < 50, 'no fetch on the request path');
  assert.equal(first.ok, true, 'cold: admitted, though the document would refuse it');
  assert.equal(rig.attrs['rate.read'], 'cold');
  assert.equal(rig.attrs['rate.decision'], 'fail_open');
  assert.equal(rig.attrs['rate.refresh.started'], true);
  await rig.settle();
  const second = await rig.admit('a');
  assert.equal(second.ok, false, 'deny from the memo');
  assert.equal(rig.attrs['rate.read'], 'memo_fresh');
  assert.equal(rig.attrs['rate.decision'], 'deny');
  assert.ok(second.retryAfterMs > 50_000);
  assert.equal((await rig.admit('b')).ok, true, 'another client is admitted from the same memo');
  assert.equal(rig.fetches(), 1, 'fresh memo: no further reads');
  await rig.settle();
  resetRateState();
});

test('memo: cold while the first read is in flight is isolate_start (rate.cold); cold after a failed read is read_failed', async () => {
  resetRateState();
  const rig = memoRig(60);
  await rig.admit('a');
  assert.equal(rig.attrs['rate.cold'], 'isolate_start', 'the isolate\'s first check');
  assert.equal(rig.attrs['rate.fail_open_reason'], 'isolate_start');
  delete rig.attrs['rate.cold'];
  await rig.admit('b');
  assert.equal(rig.attrs['rate.read'], 'cold');
  assert.equal(rig.attrs['rate.cold'], 'isolate_start', 'joined the first read, still start-up');
  await rig.settle();
  resetRateState();
  // A broken read path: the first refresh settles with no document. Later cold checks are degradation, not start-up.
  const env = { RATE_MODE: 'memo', RATE_COUNTER: fakeNamespace(new CounterCore(sqlite())) };
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, exports: { RateCache: { fetch: async () => new Response('no', { status: 503 }) } } };
  const attrs: Record<string, string | number | boolean> = {};
  const set = (k: string, v: string | number | boolean) => { attrs[k] = v; };
  const id = { hex: 'c'.repeat(64), mode: 'memo' as const, fault: null, load: false, modeSource: 'default' as const };
  await admitBatched({ ctx, env, id, bucket: 'page', now: Date.now(), limitFor: () => 60, set });
  assert.equal(attrs['rate.cold'], 'isolate_start');
  await Promise.all(waits);
  delete attrs['rate.cold'];
  await admitBatched({ ctx, env, id, bucket: 'page', now: Date.now(), limitFor: () => 60, set });
  assert.equal(attrs['rate.read'], 'cold');
  assert.equal(attrs['rate.decision'], 'fail_open');
  assert.equal(attrs['rate.fail_open_reason'], 'read_failed');
  assert.equal(attrs['rate.cold_last_read'], 'fail');
  assert.equal('rate.cold' in attrs, false, 'the first read settled with nothing: a warm fail_open the CD gate counts');
  await Promise.all(waits);
  resetRateState();
});

// ply-web#156: CD 2026-11-12T13-06-51-511Z, isolate 2058502eefa348bb9abc idle 339.4 s after the canary probes, then a
// crawler request (cf-ray a595ccf10c639249) read cold and failed open; its refresh read ok in 6 ms.
test('memo: an idle isolate whose memo aged past MEMO_FALLBACK_MS is memo_expired (expected), and its refresh carries the cause', async () => {
  resetRateState();
  const rig = memoRig(1);
  const spans: { name: string; attrs: Record<string, string | number | boolean> }[] = [];
  const tracing = { startActiveSpan: async <T>(name: string, fn: (span: { setAttribute(k: string, v: string | number | boolean): void; end(): void; setStatus(): void; recordException(): void }) => Promise<T>) => {
    const attrs: Record<string, string | number | boolean> = {};
    spans.push({ name, attrs });
    return fn({ setAttribute: (k, v) => { attrs[k] = v; }, end: () => {}, setStatus: () => {}, recordException: () => {} });
  } };
  const ctx = { ...rig.ctx, tracing };
  await admitBatched({ ctx, env: rig.env, id: { hex: 'a'.repeat(64), mode: 'memo', fault: null, load: false, modeSource: 'default' }, bucket: 'page', now: Date.now(), limitFor: () => 60, set: () => {} });
  await rig.settle();
  const realNow = Date.now;
  const idle = 339_400;
  try {
    const base = realNow();
    Date.now = () => base + idle;
    const attrs: Record<string, string | number | boolean> = {};
    const set = (k: string, v: string | number | boolean) => { attrs[k] = v; };
    const d = await admitBatched({ ctx, env: rig.env, id: { hex: 'b'.repeat(64), mode: 'memo', fault: null, load: false, modeSource: 'default' }, bucket: 'page', now: base + idle, limitFor: () => 60, set });
    assert.equal(d.ok, true);
    assert.equal(attrs['rate.read'], 'cold');
    assert.equal(attrs['rate.decision'], 'fail_open');
    assert.equal(attrs['rate.cold'], 'memo_expired');
    assert.equal(attrs['rate.fail_open_reason'], 'memo_expired');
    assert.ok(Number(attrs['rate.memo_expired_ms']) >= idle - 50, 'the expired memo\'s age is stamped');
    assert.equal(attrs['rate.refresh.started'], true);
  } finally {
    Date.now = realNow;
  }
  await rig.settle();
  const refresh = spans.filter(s => s.name === 'ply.rate.refresh').pop();
  assert.ok(refresh !== void 0 && refresh.attrs['rate.refresh.trigger'] === 'cold');
  assert.equal(refresh.attrs['rate.refresh.cold'], 'memo_expired');
  assert.equal(refresh.attrs['rate.refresh.read'], 'ok', 'healthy: the CD gate keeps it out of the warm share');
  resetRateState();
});

test('memo: an expired memo after a failed refresh is read_failed, not memo_expired', () => {
  const memo = { etag: '', index: new Map(), gen: 1, at: 0, entries: 0, fetchedAt: 0, bytes: 0, truncated: false };
  assert.deepEqual(coldCause(memo, { kind: 'ok' }, MEMO_FALLBACK_MS + 1), { kind: 'memo_expired', memoAgeMs: MEMO_FALLBACK_MS + 1 });
  assert.deepEqual(coldCause(memo, { kind: 'failed', read: 'memo' }, MEMO_FALLBACK_MS + 1), { kind: 'read_failed', lastRead: 'memo', memoAgeMs: MEMO_FALLBACK_MS + 1 });
  assert.deepEqual(coldCause(memo, { kind: 'failed', read: 'abandoned' }, MEMO_FALLBACK_MS + 1), { kind: 'read_failed', lastRead: 'abandoned', memoAgeMs: MEMO_FALLBACK_MS + 1 });
  assert.deepEqual(coldCause(null, { kind: 'failed', read: 'fail' }, 5), { kind: 'read_failed', lastRead: 'fail', memoAgeMs: null });
  assert.deepEqual(coldCause(null, { kind: 'none' }, 5), { kind: 'isolate_start' });
});

test('memo: refresh is single-flight — concurrent stale requests join the one in flight', async () => {
  resetRateState();
  const rig = memoRig(80);
  const a = refreshMemo(rig.ctx, rig.env, COLD_START);
  assert.equal(a.started, true);
  const joined = [refreshMemo(rig.ctx, rig.env, STALE), refreshMemo(rig.ctx, rig.env, STALE), refreshMemo(rig.ctx, rig.env, STALE)];
  for (const j of joined) assert.equal(j.started, false);
  const report = await a.promise;
  assert.equal(rig.fetches(), 1);
  assert.equal(report.joins, 3);
  assert.equal(report.read, 'ok');
  for (const j of joined) assert.equal(await j.promise, report, 'joiners see the same refresh');
  assert.equal(rig.waits.length, 4, 'every joiner keeps the flight alive with waitUntil');
  // Settled: the next stale request starts a new flight.
  assert.equal(refreshMemo(rig.ctx, rig.env, STALE).started, true);
  await rig.settle();
  assert.equal(rig.fetches(), 2);
  // Through admit: stale memo, many requests, one fetch.
  const realNow = Date.now;
  try {
    const base = realNow();
    Date.now = () => base + MEMO_REFRESH_MS + 1;
    const before = rig.fetches();
    await Promise.all([rig.admit('c'), rig.admit('d'), rig.admit('e'), rig.admit('f')]);
    assert.equal(rig.attrs['rate.read'], 'memo_stale_refresh');
    Date.now = realNow;
    await rig.settle();
    assert.equal(rig.fetches() - before, 1);
  } finally {
    Date.now = realNow;
  }
  resetRateState();
});

test('memo: age bounds — fresh below MEMO_REFRESH_MS, stale-and-refresh above, no memo beyond MEMO_FALLBACK_MS', async () => {
  resetRateState();
  const rig = memoRig(1);
  rig.core.apply(req('m:2', [['a'.repeat(KEY_HEX), 0, 60]]), Date.now());
  const fetchedBy = Date.now();
  await refreshMemo(rig.ctx, rig.env, COLD_START).promise;
  const fresh = readMemo(rig.ctx, rig.env, fetchedBy + MEMO_REFRESH_MS - 50);
  assert.equal(fresh.read, 'memo_fresh');
  assert.equal(rig.fetches(), 1);
  const stale = readMemo(rig.ctx, rig.env, Date.now() + MEMO_REFRESH_MS);
  assert.equal(stale.read, 'memo_stale_refresh');
  if (stale.read !== 'memo_stale_refresh') return;
  assert.equal(stale.started, true);
  assert.equal(stale.memo.entries, 1, 'a stale memo still decides');
  await rig.settle();
  const expired = readMemo(rig.ctx, rig.env, Date.now() + MEMO_FALLBACK_MS + 1);
  assert.equal(expired.read, 'cold', 'older than the 5 min bound: treated as no memo');
  if (expired.read !== 'cold') return;
  assert.equal(expired.cause.kind, 'memo_expired', 'the last refresh read ok: the memo expired while idle');
  await rig.settle();
  resetRateState();
});

test('memo: a hung refresh is abandoned after MEMO_REFRESH_ABANDON_MS, so the flight cannot pin forever', async () => {
  resetRateState();
  let calls = 0;
  const ctx = { waitUntil: () => {}, exports: { RateCache: { fetch: () => { calls++; return new Promise<Response>(() => {}); } } } };
  const env = { RATE_MODE: 'memo', RATE_COUNTER: fakeNamespace(new CounterCore(sqlite())) };
  assert.equal(refreshMemo(ctx, env, COLD_START).started, true);
  assert.equal(refreshMemo(ctx, env, COLD_START).started, false);
  const realNow = Date.now;
  const base = realNow();
  try {
    Date.now = () => base + MEMO_REFRESH_ABANDON_MS + 1;
    assert.equal(refreshMemo(ctx, env, COLD_START).started, true);
  } finally {
    Date.now = realNow;
  }
  await new Promise(r => setTimeout(r, 5));
  assert.equal(calls, 2);
  resetRateState();
});

test('identity: x-ply-rate-mode memo with the token; RATE_MODE=memo as the default', async () => {
  const ns = fakeNamespace(new CounterCore(sqlite()));
  const env = { PLY_LOAD_TOKEN: 'secret-token-123', RATE_MODE: 'batched', RATE_COUNTER: ns };
  const asked = await rateIdentity(new Request('https://x/', { headers: { [LOAD_TOKEN_HEADER]: 'secret-token-123', [LOAD_MODE_HEADER]: 'memo' } }), env, null);
  assert.equal(asked.mode, 'memo');
  const forged = await rateIdentity(new Request('https://x/', { headers: { [LOAD_TOKEN_HEADER]: 'nope', [LOAD_MODE_HEADER]: 'memo' } }), env, null);
  assert.equal(forged.mode, 'batched');
  const byEnv = await rateIdentity(new Request('https://x/'), { ...env, RATE_MODE: 'memo' }, null);
  assert.equal(byEnv.mode, 'memo');
  const unbound = await rateIdentity(new Request('https://x/'), { RATE_MODE: 'memo' }, null);
  assert.equal(unbound.mode, 'legacy');
});

// ---- memory and storage bounds under many distinct clients (a million client addresses a minute) ----

test('batcher: distinct keys held across open + flushing batches are bounded; a new key past it is dropped (budget)', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const h = harness(async ({ clock, core }, r) => { await gate; return core.apply(r, clock.now()); }, { maxKeys: 2, maxKeysHeld: 3 });
  const key = (i: number) => i.toString(16).padStart(KEY_HEX, '0');
  assert.ok(h.batcher.add(key(1), 0, null));
  assert.ok(h.batcher.add(key(2), 0, null), 'fills batch 1 (maxKeys 2): it flushes and stays held until acked');
  assert.ok(h.batcher.add(key(3), 0, null));
  assert.equal(h.batcher.keysHeld, 3);
  assert.equal(h.batcher.add(key(4), 0, null), null, 'a fourth distinct key is over the budget');
  assert.equal(h.batcher.lastDrop, 'budget');
  assert.equal(h.batcher.budgetDrops, 1);
  assert.ok(h.batcher.add(key(3), 0, null), 'a key already in the open batch still counts (no new memory)');
  assert.equal(h.batcher.keysHeld, 3);
  release();
  await h.clock.advance(1_000);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.batcher.keysHeld, 0, 'acked batches release their keys');
  assert.ok(h.batcher.add(key(4), 0, null));
});

test('doc reader: entries over the cap are cut (newest until first is kept); a text over the byte cap is refused', () => {
  const entries = Array.from({ length: 10 }, (_, i) => [i.toString(16).padStart(KEY_HEX, '0'), 0, 2_000 - i, 1]);
  const text = JSON.stringify({ v: 1, gen: 1, at: 1, entries });
  const cut = indexDoc(text, { maxBytes: 1 << 20, maxEntries: 4 });
  assert.equal(cut.entries, 4);
  assert.equal(cut.truncated, true);
  assert.ok(cut.index.has(`${'0'.repeat(KEY_HEX)}:0`));
  assert.equal(indexDoc(text).truncated, false);
  assert.throws(() => indexDoc(text, { maxBytes: text.length - 1, maxEntries: 4_096 }), /too large/);
});

test('doc reader: an oversized body is not read into the isolate (TOO_LARGE), and the last document stays in use', async () => {
  resetRateState();
  const ok = await serveDoc(new Request(DOC_URL), { blockedDoc: async () => ({ v: 1 as const, gen: 1, at: Date.now(), entries: [[K1, 0, Date.now() + 60_000, Date.now()] as const] }) });
  const okText = await ok.text();
  let big = false;
  const ctx = {
    waitUntil: () => {},
    exports: {
      RateCache: {
        fetch: async () => {
          if (!big) return new Response(okText, { headers: { etag: '"g1"' } });
          // No content-length: a stream of 64 KiB chunks, far past MAX_DOC_BYTES. The reader must stop and cancel it.
          let sent = 0;
          const body = new ReadableStream<Uint8Array>({ pull(c) { sent++; c.enqueue(new Uint8Array(65_536).fill(32)); if (sent > 1_000) c.close(); } });
          return new Response(body, { headers: { etag: '"g2"' } });
        },
      },
    },
  };
  const first = await readDoc(ctx, Date.now());
  assert.equal(first.read, 'ok');
  big = true;
  const second = await readDoc(ctx, Date.now());
  assert.equal(second.read, 'memo', 'fell back to the last good document');
  assert.equal(second.cache, 'TOO_LARGE');
  assert.ok(second.memo !== null && second.memo.index.has(`${K1}:0`));
  resetRateState();
});

test('core: the document query and the blocked prune use the until index (no scan + sort)', () => {
  const db = new DatabaseSync(':memory:');
  const exec: SqlExec = (q, ...b) => {
    const stmt = db.prepare(q);
    if (/^\s*select/i.test(q)) { const rows = stmt.all(...b) as Record<string, SqlValue>[]; return { toArray: () => rows, rowsWritten: 0 }; }
    const r = stmt.run(...b);
    return { toArray: () => [], rowsWritten: Number(r.changes) };
  };
  new CounterCore(exec);
  const plan = (q: string) => (db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(1, 4_096) as { detail: string }[]).map(r => r.detail).join(' | ');
  const doc = plan('SELECT k, b, until, crossed FROM rate_blocked WHERE until > ? ORDER BY until DESC LIMIT ?');
  assert.match(doc, /USING (COVERING )?INDEX rate_blocked_until/, doc);
  assert.doesNotMatch(doc, /TEMP B-TREE/, doc);
  const prune = plan('SELECT rowid AS r FROM rate_blocked WHERE until <= ? ORDER BY until LIMIT ?');
  assert.match(prune, /USING (COVERING )?INDEX rate_blocked_until/, prune);
});

test('core: under a million-clients-a-minute inflow the prune takes out at least what each apply puts in', () => {
  const core = new CounterCore(sqlite());
  const t = 1_000_000_000_000;
  let n = 0;
  const fresh = (count: number) => Array.from({ length: count }, () => [(n++).toString(16).padStart(KEY_HEX, '0'), 0, 1] as const);
  // A minute of full batches (2,048 distinct clients each): 30 applies, 61,440 hit rows.
  for (let i = 0; i < 30; i++) core.apply(req(`m1:${i}`, fresh(2_048)), t + i * 2_000);
  // Two minutes later all of it is expired, and the inflow goes on at the same rate.
  let now = t + 3 * 60_000;
  let backlog = core.backlog(now).hits;
  assert.equal(backlog, 61_440);
  let maxRows = 0;
  for (let i = 0; i < 40; i++) {
    const r = core.apply(req(`m3:${i}`, fresh(2_048)), now);
    maxRows = Math.max(maxRows, r.rowsWritten);
    assert.ok(r.pruned.hits >= Math.min(2_048, backlog), `apply ${i} pruned ${r.pruned.hits} of backlog ${backlog}`);
    const next = core.backlog(now).hits;
    assert.ok(next <= Math.max(0, backlog - 2_048), 'the backlog shrinks by at least the inflow + 128 per apply');
    backlog = next;
    now += 50;
  }
  assert.equal(backlog, 0, 'drained while the inflow continued');
  // Bounded: an apply writes its own entries, its batch row, and at most entries + 128 (+1, + new blocks) pruned per table.
  assert.ok(maxRows <= 2 * 2_048 + 3 * PRUNE_BATCH_ROWS + 10, `max rows written ${maxRows}`);
});
