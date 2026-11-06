// The isolate's write side (docs/rate-limit.md "Write side"): admitted hits accumulate in one open batch; the request
// that opens it schedules one flush LINGER_MS later from ctx.waitUntil. A flush is one RPC carrying an idempotency key,
// raced against a per-attempt timer and retried with the same key until acked or FLUSH_DEADLINE_MS have passed.
// No platform import: the clock, the timer and the RPC are passed in, so the tests drive every path.
import type { ApplyRequest, ApplyResult, BatchEntry, Fault } from './core.ts';
import { ATTEMPT_TIMEOUT_MS, FLUSH_DEADLINE_MS, LINGER_MS, MAX_BATCH_KEYS, MAX_INFLIGHT, RETRY_BACKOFF_MS } from './config.ts';

export type AttemptOutcome = 'ok' | 'timeout' | 'error';
export type Attempt = { readonly outcome: AttemptOutcome; readonly ms: number; readonly error: string };
export type FlushOutcome = 'ok' | 'dropped';
export type FlushReport = {
  readonly id: string;
  readonly keys: number;
  readonly hits: number;
  /** Batch open → first attempt. */
  readonly lingerMs: number;
  readonly attempts: readonly Attempt[];
  readonly outcome: FlushOutcome;
  readonly deadlineHit: boolean;
  /** The acknowledging attempt was a replay: an earlier attempt had already applied. */
  readonly replay: boolean;
  /** First attempt → acked or dropped. */
  readonly flushMs: number;
  /** Batch open → flush end: how long the waitUntil kept the isolate alive for this batch. */
  readonly aliveMs: number;
  readonly ack: ApplyResult | null;
  readonly early: boolean;
  readonly fault: Fault | null;
};

export type BatcherDeps = {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** `owner` is the ctx of the request that opened the batch (the RPC goes through its ctx.exports). */
  readonly send: (req: ApplyRequest, owner: unknown) => Promise<ApplyResult>;
  /** The isolate's id, minted on first use (no randomness at global scope in Workers). */
  readonly isolateId: () => string;
  readonly limits: () => readonly [number, number];
  /** Called once per batch with its report, inside the flush (so inside the opener's waitUntil). */
  readonly report: (r: FlushReport) => void;
  readonly lingerMs: number;
  readonly attemptTimeoutMs: number;
  readonly deadlineMs: number;
  readonly maxKeys: number;
  readonly maxInflight: number;
};

export function defaultTuning(): Pick<BatcherDeps, 'lingerMs' | 'attemptTimeoutMs' | 'deadlineMs' | 'maxKeys' | 'maxInflight'> {
  return { lingerMs: LINGER_MS, attemptTimeoutMs: ATTEMPT_TIMEOUT_MS, deadlineMs: FLUSH_DEADLINE_MS, maxKeys: MAX_BATCH_KEYS, maxInflight: MAX_INFLIGHT };
}

type OpenBatch = {
  readonly seq: number;
  readonly openedAt: number;
  readonly counts: Map<string, number>;
  hits: number;
  fault: Fault | null;
  readonly owner: unknown;
  closed: boolean;
  early: boolean;
  done: Promise<FlushReport>;
};

const TIMEOUT: unique symbol = Symbol('timeout');

function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 120);
  return String(e).slice(0, 120);
}

export class Batcher {
  readonly #deps: BatcherDeps;
  #open: OpenBatch | null = null;
  #seq = 0;
  #inflight = 0;
  /** Batches dropped because MAX_INFLIGHT were already flushing. */
  overflowDrops = 0;

  constructor(deps: BatcherDeps) {
    this.#deps = deps;
  }

  get inflight(): number {
    return this.#inflight;
  }

  /** The keys and hits waiting in the open batch (tests, and the bound). */
  pending(): { keys: number; hits: number } {
    const b = this.#open;
    return b === null ? { keys: 0, hits: 0 } : { keys: b.counts.size, hits: b.hits };
  }

  /**
   * Count one admitted hit. Returns the promise of the batch it joined, for ctx.waitUntil, or null when the batch was
   * dropped on overflow (recorded in overflowDrops).
   */
  add(key: string, bucket: number, fault: Fault | null, owner: unknown = null): Promise<FlushReport> | null {
    let b = this.#open;
    if (b === null) {
      if (this.#inflight >= this.#deps.maxInflight) {
        this.overflowDrops++;
        return null;
      }
      b = this.#start(owner);
    }
    const slot = `${key}:${bucket}`;
    b.counts.set(slot, (b.counts.get(slot) || 0) + 1);
    b.hits++;
    if (fault !== null) b.fault = fault;
    if (b.counts.size >= this.#deps.maxKeys) {
      b.early = true;
      this.#close(b);
    }
    return b.done;
  }

  #start(owner: unknown): OpenBatch {
    const deps = this.#deps;
    this.#inflight++;
    let release: (r: FlushReport) => void = () => {};
    const done = new Promise<FlushReport>(resolve => { release = resolve; });
    const b: OpenBatch = { seq: ++this.#seq, openedAt: deps.now(), counts: new Map(), hits: 0, fault: null, owner, closed: false, early: false, done };
    this.#open = b;
    // #close starts the flush and resolves `done` when it ends, whichever path closed the batch (linger or size).
    this.#pendingRelease.set(b, release);
    void deps.sleep(deps.lingerMs).then(() => {
      if (!b.closed) this.#close(b);
    });
    return b;
  }

  readonly #pendingRelease = new Map<OpenBatch, (r: FlushReport) => void>();

  #close(b: OpenBatch): void {
    b.closed = true;
    if (this.#open === b) this.#open = null;
    const release = this.#pendingRelease.get(b);
    this.#pendingRelease.delete(b);
    void this.#flush(b).then(r => {
      this.#inflight--;
      try { this.#deps.report(r); } catch { /* a report hook never fails a flush */ }
      if (release) release(r);
    });
  }

  async #flush(b: OpenBatch): Promise<FlushReport> {
    const deps = this.#deps;
    const entries: BatchEntry[] = [];
    for (const [slot, n] of b.counts) {
      const cut = slot.lastIndexOf(':');
      entries.push([slot.slice(0, cut), Number(slot.slice(cut + 1)), n]);
    }
    const id = `${deps.isolateId()}:${b.seq}`;
    const limits = deps.limits();
    const started = deps.now();
    const attempts: Attempt[] = [];
    let ack: ApplyResult | null = null;
    let deadlineHit = false;
    for (let attempt = 1; ; attempt++) {
      const left = deps.deadlineMs - (deps.now() - started);
      if (left <= 0) { deadlineHit = true; break; }
      const t0 = deps.now();
      const call = deps.send({ id, attempt, limits, entries, fault: b.fault }, b.owner);
      // The loser of the race keeps running (that is what the key covers). Its rejection must not be unhandled.
      call.catch(() => {});
      let outcome: AttemptOutcome;
      let error = '';
      try {
        const won = await Promise.race([call, deps.sleep(Math.min(deps.attemptTimeoutMs, left)).then(() => TIMEOUT)]);
        if (typeof won === 'symbol') outcome = 'timeout';
        else { outcome = 'ok'; ack = won; }
      } catch (e) {
        outcome = 'error';
        error = errorText(e);
      }
      attempts.push({ outcome, ms: deps.now() - t0, error });
      if (ack !== null) break;
      const after = deps.deadlineMs - (deps.now() - started);
      if (after <= 0) { deadlineHit = true; break; }
      await deps.sleep(Math.min(RETRY_BACKOFF_MS * 2 ** (attempt - 1), after));
    }
    const end = deps.now();
    return {
      id,
      keys: entries.length,
      hits: b.hits,
      lingerMs: started - b.openedAt,
      attempts,
      outcome: ack === null ? 'dropped' : 'ok',
      deadlineHit,
      replay: ack !== null && ack.replay,
      flushMs: end - started,
      aliveMs: end - b.openedAt,
      ack,
      early: b.early,
      fault: b.fault,
    };
  }
}
