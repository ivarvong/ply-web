// RateCounter: the ONE SQLite Durable Object behind the batched rate limiter (docs/rate-limit.md). It is called by
// isolate flushes (apply, ~5/s per busy isolate) and by RateCache revalidations (blockedDoc, ≤ 1/s per colo).
// The logic is CounterCore (src/rate/core.ts); this class adds the fault hooks and the log lines.
// Durable Object timers do not advance during synchronous work (Spectre mitigation), so apply time is not measured
// here: the caller measures the RPC, and Workers Observability carries this invocation's CPU time.
import { DurableObject } from 'cloudflare:workers';
import { dig } from '../absent.ts';
import { unwrapOr } from '../option.ts';
import { CounterCore, type ApplyRequest, type ApplyResult, type BlockedDoc, type SqlExec } from './core.ts';

export type RateCounterApi = {
  apply(req: ApplyRequest): Promise<ApplyResult>;
  blockedDoc(): Promise<BlockedDoc>;
};

/** How often an apply also logs the prune backlog and the database size (ply.rate.stats). */
const STATS_EVERY_MS = 30_000;

export class RateCounter extends DurableObject {
  #core: CounterCore | null = null;
  #statsAt = 0;

  #counter(): CounterCore {
    if (this.#core === null) {
      const sql = this.ctx.storage.sql;
      const exec: SqlExec = (q, ...b) => sql.exec(q, ...b);
      this.#core = new CounterCore(exec);
    }
    return this.#core;
  }

  async apply(req: ApplyRequest): Promise<ApplyResult> {
    const fault = req.fault !== null && req.attempt <= req.fault.attempts ? req.fault : null;
    if (fault !== null && fault.kind === 'error') {
      console.log(JSON.stringify({ msg: 'ply.rate.apply', id: req.id, attempt: req.attempt, fault: 'error' }));
      throw new Error('injected fault: error before apply');
    }
    const result = this.#counter().apply(req, Date.now());
    console.log(JSON.stringify({
      msg: 'ply.rate.apply',
      id: req.id,
      attempt: req.attempt,
      replay: result.replay,
      keys: result.keys,
      hits: result.hits,
      new_blocks: result.newBlocks,
      rows_written: result.rowsWritten,
      gen: result.gen,
      pruned_hits: result.pruned.hits,
      pruned_batches: result.pruned.batches,
      pruned_blocked: result.pruned.blocked,
      prune_backlog: result.pruned.backlog,
      fault: fault === null ? '' : `${fault.kind}=${fault.ms}`,
    }));
    this.#stats();
    for (const o of result.over) console.log(JSON.stringify({ msg: 'ply.rate.over', k: o.k.slice(0, 8), b: o.b, sum: o.sum, limit: o.limit, crossed: o.crossed, peak: o.peak, at: Date.now() }));
    if (fault !== null && fault.kind === 'slow-ack') await new Promise(r => setTimeout(r, Math.min(fault.ms, 30_000)));
    return { ...result, over: [] };
  }

  /** At most every STATS_EVERY_MS: expired rows still stored per table (the prune backlog) and the SQLite database size. */
  #stats(): void {
    const now = Date.now();
    if (now - this.#statsAt < STATS_EVERY_MS) return;
    this.#statsAt = now;
    try {
      const core = this.#counter();
      const size = unwrapOr(dig(this.ctx.storage.sql, ['databaseSize']), -1);
      // Not COUNT(*) of rate_hits (a scan of ~1M rows under a million clients a minute): the backlog range counts are
      // small while the prune keeps up, and the database size covers the rest.
      console.log(JSON.stringify({ msg: 'ply.rate.stats', backlog: core.backlog(now), db_bytes: typeof size === 'number' ? size : -1 }));
    } catch (e) {
      console.log(JSON.stringify({ msg: 'ply.rate.stats', error_name: e instanceof Error ? e.name : 'Error' }));
    }
  }

  async blockedDoc(): Promise<BlockedDoc> {
    return this.#counter().doc(Date.now());
  }
}
