// The batched limiter on the request path (docs/rate-limit.md). One Workers Cache read of the blocked document decides;
// an admitted hit goes into the isolate's batch and is flushed from ctx.waitUntil. Nothing here waits on the Durable
// Object unless the document is a cache MISS/EXPIRED.
import { dig } from '../absent.ts';
import { EDGE_ATTR, edgeTracingOf, type EdgeSpan } from '../edge-trace.ts';
import { Batcher, defaultTuning, type FlushReport } from './batcher.ts';
import { BUCKET_PACK, BUCKET_PAGE, DOC_URL, KEY_HEX, MEMO_FALLBACK_MS } from './config.ts';
import type { Fault } from './core.ts';
import { DOC_AT_HEADER, indexDoc, type DocIndex } from './doc.ts';
import { counterNamespace, counterOf } from './stub.ts';

export type RateMode = 'legacy' | 'batched';
export type SpanSet = (key: string, value: string | number | boolean) => void;

export type RateIdentity = {
  /** Full SHA-256 hex: the legacy shard name. Its first KEY_HEX characters are the batched key. */
  readonly hex: string;
  readonly mode: RateMode;
  readonly fault: Fault | null;
  /** The request proved the load-test token. */
  readonly load: boolean;
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

/** The env's default mode. Batched needs the counter binding; otherwise legacy. */
export function defaultMode(env: unknown, ctx: unknown): RateMode {
  return textBinding(env, 'RATE_MODE') === 'batched' && counterNamespace(env, ctx) !== null ? 'batched' : 'legacy';
}

/**
 * The client's rate identity. Load-test headers count only with `x-ply-load-token` equal to PLY_TOKEN (constant time);
 * the token is never forwarded, logged or echoed.
 */
export async function rateIdentity(req: Request, env: unknown, ctx: unknown): Promise<RateIdentity> {
  let mode = defaultMode(env, ctx);
  const presented = req.headers.get(LOAD_TOKEN_HEADER);
  const secret = textBinding(env, 'PLY_TOKEN');
  if (presented !== null && secret.length > 0 && (await tokenEqual(presented, secret))) {
    const label = req.headers.get(LOAD_CLIENT_HEADER);
    const asked = req.headers.get(LOAD_MODE_HEADER);
    if (asked === 'legacy') mode = 'legacy';
    if (asked === 'batched' && counterNamespace(env, ctx) !== null) mode = 'batched';
    const hex = await sha256Hex(`ply-viewer-rate/1\n${label === null ? 'load' : `load:${label.slice(0, 128)}`}`);
    return { hex, mode, fault: parseFault(req.headers.get(LOAD_FAULT_HEADER)), load: true };
  }
  const connecting = req.headers.get('cf-connecting-ip');
  const hex = await sha256Hex(`ply-viewer-rate/1\n${connecting === null ? 'unknown' : connecting}`);
  return { hex, mode, fault: null, load: false };
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

type Memo = { etag: string; index: DocIndex; gen: number; at: number; entries: number; fetchedAt: number };
let memo: Memo | null = null;

export type DocRead = { readonly read: 'ok' | 'memo' | 'fail'; readonly cache: string; readonly memo: Memo | null; readonly parsed: boolean };

type CacheBinding = { fetch(req: Request): Promise<Response> };

function rateCacheOf(ctx: unknown): CacheBinding | null {
  const found = dig(ctx, ['exports', 'RateCache']);
  if (found.tag === 'none' || found.value === null) return null;
  return found.value as CacheBinding;
}

export async function readDoc(ctx: unknown, now: number): Promise<DocRead> {
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
  const etag = res.headers.get('etag');
  const atHeader = Number(res.headers.get(DOC_AT_HEADER));
  if (etag !== null && memo !== null && memo.etag === etag) {
    if (res.body !== null) await res.body.cancel();
    memo = { ...memo, at: Number.isFinite(atHeader) && atHeader > 0 ? atHeader : memo.at, fetchedAt: now };
    return { read: 'ok', cache, memo, parsed: false };
  }
  try {
    const d = indexDoc(await res.text());
    memo = { etag: etag === null ? '' : etag, index: d.index, gen: d.gen, at: d.at, entries: d.entries, fetchedAt: now };
    return { read: 'ok', cache, memo, parsed: true };
  } catch {
    return fallback(cache);
  }
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

/** Tests: forget the isolate's batcher and memo. */
export function resetRateState(): void {
  batcher = null;
  memo = null;
  isolate = '';
}

export type BatchedDecision = { ok: boolean; remaining: number; retryAfterMs: number };

/**
 * The batched decision. `set` is the ply.rate.check span's attribute setter.
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
  const doc = await readDoc(ctx, now);
  set('rate.read', doc.read);
  set('rate.cache', doc.cache);
  set('rate.doc_parsed', doc.parsed);
  if (doc.memo !== null) {
    set('rate.doc_entries', doc.memo.entries);
    set('rate.doc_gen', doc.memo.gen);
    set('rate.doc_age_ms', Math.max(0, Date.now() - doc.memo.at));
    const hit = doc.memo.index.get(`${key}:${b}`);
    if (hit !== void 0 && hit[0] > now) {
      set('rate.decision', 'deny');
      set('rate.blocked_for_ms', Math.max(0, now - hit[1]));
      return { ok: false, remaining: 0, retryAfterMs: hit[0] - now };
    }
  }
  set('rate.decision', doc.read === 'fail' ? 'fail_open' : 'allow');
  const batch = batcherFor(env, input.limitFor);
  const before = batch.pending().keys === 0 && batch.pending().hits === 0;
  const version = versionOf(env);
  const joined = batch.add(key, b, id.fault, ctx);
  const waitUntil = (p: Promise<unknown>): void => {
    const found = dig(ctx, ['waitUntil']);
    if (found.tag === 'some' && typeof found.value === 'function') (found.value as (p: Promise<unknown>) => void).call(ctx, p);
  };
  if (joined === null) {
    set('rate.batch.dropped', 'overflow');
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
