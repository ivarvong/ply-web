// The batched limiter on the request path (docs/rate-limit.md). One Workers Cache read of the blocked document decides;
// an admitted hit goes into the isolate's batch and is flushed from ctx.waitUntil. Nothing here waits on the Durable
// Object unless the document is a cache MISS/EXPIRED.
import { dig } from '../absent.ts';
import { EDGE_ATTR, edgeTracingOf, type EdgeSpan } from '../edge-trace.ts';
import { Batcher, defaultTuning, type FlushReport } from './batcher.ts';
import { BUCKET_PACK, BUCKET_PAGE, DOC_URL, KEY_HEX, MAX_DOC_BYTES, MEMO_FALLBACK_MS, MEMO_REFRESH_ABANDON_MS, MEMO_REFRESH_MS, READ_BUDGET_MS } from './config.ts';
import type { Fault } from './core.ts';
import { DOC_AT_HEADER, indexDoc, type DocIndex } from './doc.ts';
import { counterNamespace, counterOf } from './stub.ts';

export type RateMode = 'legacy' | 'batched' | 'memo';
export type SpanSet = (key: string, value: string | number | boolean) => void;

export type RateIdentity = {
  /** Full SHA-256 hex: the legacy shard name. Its first KEY_HEX characters are the batched key. */
  readonly hex: string;
  readonly mode: RateMode;
  readonly fault: Fault | null;
  /** The request proved the load-test token. */
  readonly load: boolean;
  /**
   * Where `mode` came from: `default` is the env's RATE_MODE (what every real request runs), `header` is a load request's
   * `x-ply-rate-mode`. The CD rate gate (scripts/cd/rate-gate.ts) judges only `default` checks against the configured mode.
   */
  readonly modeSource: 'default' | 'header';
};

export const LOAD_TOKEN_HEADER = 'x-ply-load-token';
export const LOAD_CLIENT_HEADER = 'x-ply-rate-client';
export const LOAD_MODE_HEADER = 'x-ply-rate-mode';
export const LOAD_FAULT_HEADER = 'x-ply-rate-fault';

const enc = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

async function tokenEqual(left: string, right: string): Promise<boolean> {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(left)), crypto.subtle.digest("SHA-256", enc.encode(right))]);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual: unknown };
  if (typeof subtle.timingSafeEqual === 'function') return (subtle.timingSafeEqual as (a: ArrayBuffer, b: ArrayBuffer) => boolean).call(subtle, x, y);
  // Node (unit tests) has no timingSafeEqual on SubtleCrypto. Equal-length digests, compared without an early exit.
  const xs = new Uint8Array(x);
  const ys = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xs.length; i++) diff |= xs[i] ^ ys[i];
  return diff === 0;
}

function textBinding(env: unknown, name: string): string {
  const found = dig(env, [name]);
  return found.tag === 'some' && typeof found.value === 'string' ? found.value : '';
}

/** `slow-ack=<ms>;attempts=<n>` or `error;attempts=<n>`. Anything else is no fault. */
export function parseFault(raw: string | null): Fault | null {
  if (raw === null) return null;
  const slow = /^slow-ack=(\d{1,5})(;attempts=(\d{1,2}))*$/.exec(raw.trim());
  if (slow !== null) return { kind: 'slow-ack', ms: Number(slow[1]), attempts: Number(slow[3] || '1') };
  const error = /^error(;attempts=(\d{1,2}))*$/.exec(raw.trim());
  if (error !== null) return { kind: 'error', ms: 0, attempts: Number(error[2] || '1') };
  return null;
}

/** The env's default mode. Batched and memo need the counter binding; otherwise legacy. */
export function defaultMode(env: unknown, ctx: unknown): RateMode {
  const asked = textBinding(env, 'RATE_MODE');
  if ((asked === 'batched' || asked === 'memo') && counterNamespace(env, ctx) !== null) return asked;
  return 'legacy';
}

/**
 * The secret that unlocks the load-test headers: PLY_LOAD_TOKEN, a credential of its own. PLY_TOKEN (the /v1 bearer)
 * does not unlock them, so the load generator (ply-load) never holds the API credential.
 */
export const LOAD_TOKEN_BINDING = 'PLY_LOAD_TOKEN';

/**
 * The client's rate identity. Load-test headers count only with `x-ply-load-token` equal to PLY_LOAD_TOKEN (constant
 * time); the token is never forwarded, logged or echoed. With no PLY_LOAD_TOKEN bound, no request is a load request.
 */
export async function rateIdentity(req: Request, env: unknown, ctx: unknown): Promise<RateIdentity> {
  let mode = defaultMode(env, ctx);
  const presented = req.headers.get(LOAD_TOKEN_HEADER);
  const secret = textBinding(env, LOAD_TOKEN_BINDING);
  if (presented !== null && secret.length > 0 && (await tokenEqual(presented, secret))) {
    const label = req.headers.get(LOAD_CLIENT_HEADER);
    const asked = req.headers.get(LOAD_MODE_HEADER);
    let modeSource: RateIdentity['modeSource'] = 'default';
    if (asked === 'legacy') { mode = 'legacy'; modeSource = 'header'; }
    if ((asked === 'batched' || asked === 'memo') && counterNamespace(env, ctx) !== null) { mode = asked; modeSource = 'header'; }
    const hex = await sha256Hex(`ply-viewer-rate/1\n${label === null ? 'load' : `load:${label.slice(0, 128)}`}`);
    return { hex, mode, fault: parseFault(req.headers.get(LOAD_FAULT_HEADER)), load: true, modeSource };
  }
  const connecting = req.headers.get('cf-connecting-ip');
  const hex = await sha256Hex(`ply-viewer-rate/1\n${connecting === null ? 'unknown' : connecting}`);
  return { hex, mode, fault: null, load: false, modeSource: 'default' };
}

let checks = 0;

/** Count this isolate's rate checks; true for its first. A cold isolate's first batched read may fail open by design. */
export function firstCheckInIsolate(): boolean {
  checks++;
  return checks === 1;
}

// ---- the span helper: Workers spans stamped like ply's (src/edge-trace.ts EDGE_ATTR) ----

export function versionOf(env: unknown): string {
  const v = dig(env, ['VERSION', 'id']);
  return v.tag === 'some' && typeof v.value === 'string' ? v.value : '';
}

export async function inSpan<T>(ctx: unknown, name: string, stamp: Readonly<Record<string, string>>, fn: (set: SpanSet) => Promise<T>): Promise<T> {
  const tracing = edgeTracingOf(ctx);
  if (tracing === null) return fn(() => {});
  return tracing.startActiveSpan(name, async (span: EdgeSpan) => {
    const set: SpanSet = (k, v) => { try { span.setAttribute(k, v); } catch { /* tracing never fails a request */ } };
    for (const [k, v] of Object.entries(stamp)) if (v) set(k, v);
    try {
      return await fn(set);
    } catch (e) {
      try { span.setStatus({ code: 'error', message: e instanceof Error ? e.name : 'Error' }); } catch { /* ignore */ }
      throw e;
    } finally {
      try { span.end(); } catch { /* ignore */ }
    }
  });
}

// ---- read side ----

type Memo = { etag: string; index: DocIndex; gen: number; at: number; entries: number; fetchedAt: number; bytes: number; truncated: boolean };
let memo: Memo | null = null;

export type DocRead = { readonly read: 'ok' | 'memo' | 'fail' | 'late_memo' | 'late_open'; readonly cache: string; readonly memo: Memo | null; readonly parsed: boolean };

type CacheBinding = { fetch(req: Request): Promise<Response> };

function rateCacheOf(ctx: unknown): CacheBinding | null {
  const found = dig(ctx, ['exports', 'RateCache']);
  if (found.tag === 'none' || found.value === null) return null;
  return found.value as CacheBinding;
}

/** The body as text, or null (and the body cancelled) once it passes `max` bytes: never buffers more than max + a chunk. */
async function boundedText(res: Response, max: number): Promise<string | null> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

async function fetchDoc(ctx: unknown, now: number): Promise<DocRead> {
  const rateCache = rateCacheOf(ctx);
  const fallback = (cache: string): DocRead => (memo !== null && now - memo.fetchedAt < MEMO_FALLBACK_MS ? { read: 'memo', cache, memo, parsed: false } : { read: 'fail', cache, memo: null, parsed: false });
  if (rateCache === null) return fallback('NONE');
  let res: Response;
  try {
    res = await rateCache.fetch(new Request(DOC_URL));
  } catch {
    return fallback('ERROR');
  }
  const cacheHeader = res.headers.get('cf-cache-status');
  const cache = cacheHeader === null ? 'NONE' : cacheHeader.toUpperCase();
  if (res.status !== 200) {
    if (res.body !== null) await res.body.cancel();
    return fallback(cache);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOC_BYTES) {
    // Not read: an oversized body must not reach the isolate's heap. The last document (if any) stays in use.
    if (res.body !== null) await res.body.cancel();
    return fallback('TOO_LARGE');
  }
  const etag = res.headers.get('etag');
  const atHeader = Number(res.headers.get(DOC_AT_HEADER));
  if (etag !== null && memo !== null && memo.etag === etag) {
    if (res.body !== null) await res.body.cancel();
    memo = { ...memo, at: Number.isFinite(atHeader) && atHeader > 0 ? atHeader : memo.at, fetchedAt: now };
    return { read: 'ok', cache, memo, parsed: false };
  }
  try {
    const text = await boundedText(res, MAX_DOC_BYTES);
    if (text === null) return fallback('TOO_LARGE');
    const d = indexDoc(text);
    memo = { etag: etag === null ? '' : etag, index: d.index, gen: d.gen, at: d.at, entries: d.entries, fetchedAt: now, bytes: text.length, truncated: d.truncated };
    return { read: 'ok', cache, memo, parsed: true };
  } catch {
    return fallback(cache);
  }
}

/**
 * The read on the request path never waits on the Durable Object (docs/rate-limit.md "Read budget"). The cached fetch
 * gets `budgetMs`; a HIT answers in a few ms. Past the budget (a MISS is a synchronous DO read, 400+ ms on lat2; an
 * isolate's first loopback, ~55 ms) the request decides from the isolate's last document, or admits when it has none,
 * and the fetch finishes in waitUntil, refreshing that document for the next request. `budgetMs` null waits (tests).
 */
export async function readDoc(ctx: unknown, now: number, budgetMs: number | null = null): Promise<DocRead> {
  const pending = fetchDoc(ctx, now);
  if (budgetMs === null) return pending;
  const late: DocRead = { read: 'late_open', cache: 'LATE', memo: null, parsed: false };
  const won = await Promise.race([pending, new Promise<DocRead>(resolve => setTimeout(() => resolve(late), budgetMs))]);
  if (won !== late) return won;
  const waitUntil = dig(ctx, ['waitUntil']);
  if (waitUntil.tag === 'some' && typeof waitUntil.value === 'function') (waitUntil.value as (p: Promise<unknown>) => void).call(ctx, pending.catch(() => null));
  const held = memo;
  if (held !== null && Date.now() - held.fetchedAt < MEMO_FALLBACK_MS) return { read: 'late_memo', cache: 'LATE', memo: held, parsed: false };
  return late;
}

// ---- memo mode: decide from the isolate's document, refresh it single-flight in waitUntil ----

export type RefreshReport = { readonly read: DocRead['read']; readonly cache: string; readonly parsed: boolean; readonly ms: number; readonly joins: number };
type Flight = { promise: Promise<RefreshReport>; readonly startedAt: number; joins: number };
let flight: Flight | null = null;
/**
 * Refreshes this isolate has finished (settled either way, or abandoned). Zero means its first read is still in flight:
 * a cold check then is the isolate's start-up, not a broken read path (the CD rate gate counts it as a cold isolate).
 */
let refreshesSettled = 0;

function waitUntilOf(ctx: unknown): (p: Promise<unknown>) => void {
  const found = dig(ctx, ['waitUntil']);
  if (found.tag === 'some' && typeof found.value === 'function') return p => (found.value as (p: Promise<unknown>) => void).call(ctx, p);
  return () => {};
}

/**
 * At most one refresh of the isolate's document in flight. The request that starts it keeps it alive with
 * ctx.waitUntil, inside a `ply.rate.refresh` span; a request that finds one in flight joins it (counted, and also
 * waitUntil'd: free, and the refresh survives the starter's context ending). A flight older than
 * MEMO_REFRESH_ABANDON_MS is abandoned and replaced. Returns whether this call started a new flight.
 */
export function refreshMemo(ctx: unknown, env: unknown, trigger: 'cold' | 'stale'): { started: boolean; promise: Promise<RefreshReport> } {
  const now = Date.now();
  const keep = waitUntilOf(ctx);
  if (flight !== null && now - flight.startedAt < MEMO_REFRESH_ABANDON_MS) {
    flight.joins++;
    keep(flight.promise);
    return { started: false, promise: flight.promise };
  }
  if (flight !== null) refreshesSettled++; // abandoned: a hung first read is no longer start-up
  const mine: Flight = { promise: Promise.resolve({ read: 'fail', cache: 'NONE', parsed: false, ms: 0, joins: 0 }), startedAt: now, joins: 0 };
  flight = mine;
  const run = inSpan(ctx, 'ply.rate.refresh', { [EDGE_ATTR.version]: versionOf(env), [EDGE_ATTR.route]: 'rate.refresh' }, async set => {
    const t0 = performance.now();
    set('rate.refresh.trigger', trigger);
    let r: DocRead;
    try {
      r = await fetchDoc(ctx, now);
    } finally {
      if (flight === mine) flight = null;
      refreshesSettled++;
    }
    const report: RefreshReport = { read: r.read, cache: r.cache, parsed: r.parsed, ms: Math.round((performance.now() - t0) * 1000) / 1000, joins: mine.joins };
    set('rate.refresh.read', report.read);
    set('rate.refresh.cache', report.cache);
    set('rate.refresh.parsed', report.parsed);
    set('rate.refresh.ms', report.ms);
    set('rate.refresh.joins', report.joins);
    if (r.memo !== null) {
      set('rate.doc_bytes', r.memo.bytes);
      if (r.memo.truncated) set('rate.doc_truncated', true);
      set('rate.doc_entries', r.memo.entries);
      set('rate.doc_gen', r.memo.gen);
      set('rate.doc_age_ms', Math.max(0, Date.now() - r.memo.at));
    }
    return report;
  });
  mine.promise = run.catch((): RefreshReport => {
    if (flight === mine) flight = null;
    return { read: 'fail', cache: 'ERROR', parsed: false, ms: 0, joins: mine.joins };
  });
  keep(mine.promise);
  return { started: true, promise: mine.promise };
}

/** The memo-mode read: never a fetch on the request path. */
export type MemoRead = {
  readonly read: 'memo_fresh' | 'memo_stale_refresh' | 'cold';
  readonly memo: Memo | null;
  readonly memoAgeMs: number | null;
  readonly started: boolean;
  /** Cold, and no refresh of this isolate has settled yet: its first read is in flight. */
  readonly firstRead: boolean;
};

export function readMemo(ctx: unknown, env: unknown, now: number): MemoRead {
  const held = memo !== null && now - memo.fetchedAt < MEMO_FALLBACK_MS ? memo : null;
  if (held === null) {
    const firstRead = refreshesSettled === 0;
    const { started } = refreshMemo(ctx, env, 'cold');
    return { read: 'cold', memo: null, memoAgeMs: null, started, firstRead };
  }
  const age = Math.max(0, now - held.fetchedAt);
  if (age < MEMO_REFRESH_MS) return { read: 'memo_fresh', memo: held, memoAgeMs: age, started: false, firstRead: false };
  const { started } = refreshMemo(ctx, env, 'stale');
  return { read: 'memo_stale_refresh', memo: held, memoAgeMs: age, started, firstRead: false };
}

// ---- write side: the isolate's one batcher ----

let isolate = '';
let batcher: Batcher | null = null;

function isolateId(): string {
  if (isolate === '') isolate = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  return isolate;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stampFlush(set: SpanSet, r: FlushReport): void {
  set('rate.batch.id', r.id);
  set('rate.batch.keys', r.keys);
  set('rate.batch.hits', r.hits);
  set('rate.batch.early', r.early);
  set('rate.batch.linger_ms', r.lingerMs);
  set('rate.batch.attempts', r.attempts.length);
  set('rate.batch.attempt_log', r.attempts.map(a => `${a.outcome}:${a.ms}`).join(','));
  set('rate.batch.timeouts', r.attempts.filter(a => a.outcome === 'timeout').length);
  set('rate.batch.errors', r.attempts.filter(a => a.outcome === 'error').length);
  const lastError = r.attempts.filter(a => a.error !== '').map(a => a.error).pop();
  if (lastError !== void 0) set('rate.batch.error', lastError);
  set('rate.batch.outcome', r.outcome);
  set('rate.batch.deadline_hit', r.deadlineHit);
  set('rate.batch.replay', r.replay);
  set('rate.batch.flush_ms', r.flushMs);
  set('rate.batch.alive_ms', r.aliveMs);
  const ok = r.attempts.filter(a => a.outcome === 'ok').pop();
  if (ok !== void 0) set('rate.do.rpc_ms', ok.ms);
  if (r.ack !== null) {
    set('rate.do.rows_written', r.ack.rowsWritten);
    set('rate.do.new_blocks', r.ack.newBlocks);
    set('rate.do.gen', r.ack.gen);
  }
  if (r.fault !== null) set('rate.fault', `${r.fault.kind}=${r.fault.ms};attempts=${r.fault.attempts}`);
}

function batcherFor(env: unknown, limitFor: (bucket: 'page' | 'pack') => number): Batcher {
  if (batcher === null) {
    batcher = new Batcher({
      now: () => Date.now(),
      sleep,
      send: (req, owner) => {
        const stub = counterOf(env, owner);
        if (stub === null) return Promise.reject(new Error('RATE_COUNTER is not bound'));
        return stub.apply(req);
      },
      isolateId,
      limits: () => [limitFor('page'), limitFor('pack')] as const,
      report: () => {},
      ...defaultTuning(),
    });
  }
  return batcher;
}

/** Tests: forget the isolate's batcher, memo and refresh flight. */
export function resetRateState(): void {
  checks = 0;
  batcher = null;
  memo = null;
  flight = null;
  refreshesSettled = 0;
  isolate = '';
}

export type BatchedDecision = { ok: boolean; remaining: number; retryAfterMs: number };

/**
 * The batched and memo decisions (id.mode). Batched reads the cached document within READ_BUDGET_MS; memo decides from
 * the isolate's document with no fetch and refreshes it in waitUntil (readMemo). `set` is the ply.rate.check span's attribute setter.
 * Denied requests are not counted (as legacy). A failed read with no usable memo admits (fail open).
 */
export async function admitBatched(input: {
  readonly ctx: unknown;
  readonly env: unknown;
  readonly id: RateIdentity;
  readonly bucket: 'page' | 'pack';
  readonly now: number;
  readonly limitFor: (bucket: 'page' | 'pack') => number;
  readonly set: SpanSet;
}): Promise<BatchedDecision> {
  const { ctx, env, id, bucket, now, set } = input;
  const key = id.hex.slice(0, KEY_HEX);
  const b = bucket === 'pack' ? BUCKET_PACK : BUCKET_PAGE;
  let held: Memo | null;
  let open: boolean;
  if (id.mode === 'memo') {
    const m = readMemo(ctx, env, now);
    set('rate.read', m.read);
    set('rate.cache', 'MEMO');
    if (m.memoAgeMs !== null) set('rate.memo_age_ms', m.memoAgeMs);
    if (m.read !== 'memo_fresh') set('rate.refresh.started', m.started);
    // Cold while the isolate's first read is still in flight (or about to start): start-up, judged as a cold isolate.
    if (m.read === 'cold' && m.firstRead) set('rate.cold_isolate', true);
    held = m.memo;
    open = m.read === 'cold';
  } else {
    const doc = await readDoc(ctx, now, READ_BUDGET_MS);
    set('rate.read', doc.read);
    set('rate.cache', doc.cache);
    set('rate.doc_parsed', doc.parsed);
    held = doc.memo;
    open = doc.read === 'fail' || doc.read === 'late_open';
  }
  if (held !== null) {
    set('rate.doc_entries', held.entries);
    set('rate.doc_gen', held.gen);
    set('rate.doc_age_ms', Math.max(0, Date.now() - held.at));
    const hit = held.index.get(`${key}:${b}`);
    if (hit !== void 0 && hit[0] > now) {
      set('rate.decision', 'deny');
      set('rate.blocked_for_ms', Math.max(0, now - hit[1]));
      return { ok: false, remaining: 0, retryAfterMs: hit[0] - now };
    }
  }
  set('rate.decision', open ? 'fail_open' : 'allow');
  const batch = batcherFor(env, input.limitFor);
  // A faulted (load-test) hit never joins the shared batch: it flushes alone, so a fault slows or drops only its own count.
  const before = id.fault !== null || (batch.pending().keys === 0 && batch.pending().hits === 0);
  const version = versionOf(env);
  const joined = id.fault !== null ? batch.addIsolated(key, b, id.fault, ctx) : batch.add(key, b, null, ctx);
  const waitUntil = waitUntilOf(ctx);
  set('rate.batch.keys_held', batch.keysHeld);
  if (joined === null) {
    set('rate.batch.dropped', batch.lastDrop === null ? 'overflow' : batch.lastDrop);
  } else if (before) {
    // This request opened the batch: its waitUntil keeps the isolate alive through the linger and the retries.
    const flushSpan = inSpan(ctx, 'ply.rate.flush', { [EDGE_ATTR.version]: version, [EDGE_ATTR.route]: 'rate.flush' }, async fset => {
      const report = await joined;
      stampFlush(fset, report);
      return report;
    });
    flushSpan.catch(() => {});
    waitUntil(flushSpan);
    set('rate.batch.opened', true);
  } else if (batch.pending().keys === 0) {
    // This request filled the batch to MAX_BATCH_KEYS and started its flush in this request's context: keep it alive too.
    waitUntil(joined);
    set('rate.batch.closed_early', true);
  }
  return { ok: true, remaining: 0, retryAfterMs: 0 };
}
