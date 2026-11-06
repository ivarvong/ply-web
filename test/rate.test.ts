// The batched rate limiter (docs/rate-limit.md): the counter's SQL on real SQLite (node:sqlite), the batcher under a
// virtual clock, the cached document, and the request-path decision end to end with a fake ctx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyCfBundle } from './cf-bundle.js';
import { CounterCore, InvalidBatch, blockedUntil, firstLiveSlot, type ApplyRequest, type ApplyResult, type SqlExec, type SqlValue } from '../src/rate/core.ts';
import { Batcher, defaultTuning, type BatcherDeps, type FlushReport } from '../src/rate/batcher.ts';
import { SLOT_MS, WINDOW_MS, DOC_PATH, DOC_URL, KEY_HEX } from '../src/rate/config.ts';
import { indexDoc, serveDoc } from '../src/rate/doc.ts';
import { admitBatched, parseFault, rateIdentity, readDoc, resetRateState, LOAD_CLIENT_HEADER, LOAD_MODE_HEADER, LOAD_TOKEN_HEADER } from '../src/rate/admit.ts';

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
  // Attempt 1 applies at once but its answer takes 3 s (the client's 1 s timer wins); attempt 2 is answered at once.
  const h = harness(({ clock, core }, r) => {
    const result = core.apply(r, clock.now());
    if (r.attempt === 1) return clock.sleep(3_000).then(() => result);
    return Promise.resolve(result);
  });
  for (let i = 0; i < 60; i++) h.batcher.add(K1, 0, null);
  await h.clock.advance(200 + 1_000 + 50 + 10);
  const r = h.reports[0];
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(r.attempts.map(a => a.outcome), ['timeout', 'ok']);
  assert.equal(r.attempts[0].ms, 1_000);
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
  // Attempt 1 is delivered late: it applies 1.5 s after it was sent. Attempt 2 applies first. Attempt 1 is then a replay.
  const h = harness(({ clock, core }, r) => {
    if (r.attempt === 1) return clock.sleep(1_500).then(() => core.apply(r, clock.now()));
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

test('batcher: a fault rides on the batch', async () => {
  const h = harness(instant);
  h.batcher.add(K1, 0, { kind: 'slow-ack', ms: 1500, attempts: 1 });
  await h.clock.advance(250);
  assert.deepEqual(h.sends[0].fault, { kind: 'slow-ack', ms: 1500, attempts: 1 });
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
  const env = { PLY_TOKEN: 'secret-token-123', RATE_MODE: 'legacy', RATE_COUNTER: fakeNamespace(new CounterCore(sqlite())) };
  const plain = await rateIdentity(new Request('https://x/', { headers: { 'cf-connecting-ip': '198.51.100.1', [LOAD_CLIENT_HEADER]: 'c1', [LOAD_MODE_HEADER]: 'batched' } }), env);
  assert.equal(plain.load, false);
  assert.equal(plain.mode, 'legacy');
  const wrong = await rateIdentity(new Request('https://x/', { headers: { [LOAD_TOKEN_HEADER]: 'nope', [LOAD_CLIENT_HEADER]: 'c1', [LOAD_MODE_HEADER]: 'batched' } }), env);
  assert.equal(wrong.load, false);
  const right = await rateIdentity(new Request('https://x/', { headers: { [LOAD_TOKEN_HEADER]: 'secret-token-123', [LOAD_CLIENT_HEADER]: 'c1', [LOAD_MODE_HEADER]: 'batched' } }), env);
  assert.equal(right.load, true);
  assert.equal(right.mode, 'batched');
  const other = await rateIdentity(new Request('https://x/', { headers: { [LOAD_TOKEN_HEADER]: 'secret-token-123', [LOAD_CLIENT_HEADER]: 'c2' } }), env);
  assert.notEqual(right.hex, other.hex);
  assert.equal(other.mode, 'legacy');
  assert.equal(right.hex.length, 64);
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
  const env = { RATE_MODE: 'batched', RATE_COUNTER: ns, PLY_TOKEN: 't' };
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
  const id = { hex: 'c'.repeat(64), mode: 'batched' as const, fault: null, load: true };
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
  const d = await admitBatched({ ctx, env, id: { hex: 'e'.repeat(64), mode: 'batched', fault: null, load: false }, bucket: 'page', now: Date.now(), limitFor: () => 60, set: (k, v) => { attrs[k] = v; } });
  assert.equal(d.ok, true);
  assert.equal(attrs['rate.decision'], 'fail_open');
  resetRateState();
});

// ---- the deployed bundle under workerd: real RateCounter on SQLite, ctx.exports.RateCache, the load-test headers ----

const WORKERD = [process.env.WORKERD, fileURLToPath(new URL('../node_modules/.bin/workerd', import.meta.url))].filter((p): p is string => !!p && existsSync(p));

test('workerd: batched limiter refuses within the lag, and a slow ack is retried as a replay', { skip: WORKERD.length === 0 && 'workerd not installed', timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ply-rate-'));
  const out = join(root, 'wk');
  mkdirSync(out);
  copyCfBundle(join(out, 'worker.mjs'));
  const port = 19200 + (process.pid % 40);
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
      (name = "PLY_TOKEN", text = "${token}"),
      (name = "WRITES", text = "off"),
      (name = "PACK_CACHE", text = "off"),
      (name = "VIEWER_RATE_PER_MIN", text = "3"),
      (name = "RATE_MODE", text = "batched"),
      (name = "VIEWER_RATE", durableObjectNamespace = "ViewerRateLimit"),
      (name = "RATE_COUNTER", durableObjectNamespace = "RateCounter")
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
    // A forged token is ignored: the headers do nothing and the request is keyed by its (absent) address.
    const forged = await fetch(`http://127.0.0.1:${port}/view`, { headers: { [LOAD_TOKEN_HEADER]: 'nope', [LOAD_CLIENT_HEADER]: 'c1' } });
    assert.equal(forged.status, 200);
    // Fault: the DO applies and holds its answer 1.5 s; the 1 s attempt timer fires, the retry with the same id is a replay.
    assert.equal((await hit('c4', { 'x-ply-rate-fault': 'slow-ack=1500;attempts=1' })).status, 200);
    await sleep(2_500);
    const applies = logs.split('\n').filter(l => l.includes('"ply.rate.apply"') && l.includes('slow-ack') === false).map(l => JSON.parse(l.slice(l.indexOf('{'))));
    const faulted = logs.split('\n').filter(l => l.includes('"ply.rate.apply"') && l.includes('slow-ack=1500')).map(l => JSON.parse(l.slice(l.indexOf('{'))));
    assert.equal(faulted.length, 1, logs.slice(-3000));
    const replays = applies.filter(a => a.id === faulted[0].id);
    assert.equal(replays.length, 1, 'one retry of the faulted batch');
    assert.equal(replays[0].replay, true);
    assert.equal(replays[0].attempt, 2);
    assert.equal(logs.includes(token), false, 'the load token never reaches a log');
  } finally {
    if (proc.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } }
    else proc.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
