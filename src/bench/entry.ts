// ProbeBench: the one SQLite Durable Object behind /bench. It admits a run (one at a time, at most RUNS_PER_HOUR),
// runs it (src/bench/run.ts) against the probe namespace, keeps the record in SQLite and the exchange bodies in R2,
// and sweeps any repository a run left behind (an alarm: revoke every token, delete, until none is left). Reached
// through ctx.exports.ProbeBench (no env binding), like RateCounter.
import { DurableObject } from 'cloudflare:workers';
import type { EndedSpan } from 'ply';
import { plyTracer } from '../edge-trace.ts';
import { renderRay } from '../rays.ts';
import { PLY_SHA } from '../version.ts';
import { mintRunId, parseRunId, parseRunSeed, repoNameFor, type RunId } from './brand.ts';
import { findScenario } from './catalogue.ts';
import { runLive, type ProbeRepos } from './run.ts';
import { admit, admittedSince, cleanupCounts, listRuns, loadRun, migrate, repoCleaned, repoCreated, saveRun, uncleaned, type RunSummary, type SpanRow, type Sql, type StoredRun } from './store.ts';

export const RUNS_PER_HOUR = 20;
const HOUR_MS = 3_600_000;
const SWEEP_AFTER_MS = 15 * 60_000;
const BODY_CAP = 1024 * 1024;
const MAX_SPANS = 600;

export type BlobBucket = {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
};
export type BenchEnv = { readonly PROBE_REPOS: ProbeRepos; readonly BENCH_BLOBS: BlobBucket };

export type StartAnswer =
  | { readonly tag: 'done'; readonly run: RunId }
  | { readonly tag: 'refused'; readonly status: 400 | 404 | 409 | 429; readonly reason: string };
export type Counts = { readonly created: number; readonly cleaned: number; readonly lastHour: number };

export const bodyKey = (run: RunId, i: number, which: 'request' | 'response'): string => `runs/${run}/${i}.${which}`;

const spanRow = (s: EndedSpan, t0: bigint): SpanRow => ({
  id: s.spanId, parent: s.parentSpanId, name: s.name, startMs: Number((BigInt(s.startTimeUnixNano) - t0) / 1_000_000n), durationMs: s.durationMs, ok: s.status.code !== 2,
  attrs: Object.fromEntries(Object.entries(s.attrs).filter((e): e is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof e[1]))),
});

export class ProbeBench extends DurableObject<BenchEnv> {
  #running: RunId | null = null;

  #migrated = false;

  #sql(): Sql {
    const sql = this.ctx.storage.sql;
    const out: Sql = { exec: (q, ...b) => sql.exec(q, ...b) };
    if (!this.#migrated) { migrate(out); this.#migrated = true; }
    return out;
  }

  async start(scenarioId: string, seedText: string): Promise<StartAnswer> {
    const entry = findScenario(scenarioId);
    if (entry.tag === 'none') return { tag: 'refused', status: 404, reason: `no scenario ${scenarioId} in ply's catalogue at ${PLY_SHA}` };
    const support = entry.value.support;
    if (support.tag === 'git-only') return { tag: 'refused', status: 400, reason: `stock git only: ${support.why}` };
    if (support.tag === 'too-large') return { tag: 'refused', status: 400, reason: `the seed is ${support.bytes} bytes; the workbench holds at most 8 MiB in a Worker` };
    const seed = parseRunSeed(seedText);
    if (!seed.ok) return { tag: 'refused', status: 400, reason: seed.error };
    if (this.#running !== null) return { tag: 'refused', status: 409, reason: `run ${this.#running} is in progress; one run at a time` };
    const sql = this.#sql();
    const now = Date.now();
    if (admittedSince(sql, now - HOUR_MS) >= RUNS_PER_HOUR) return { tag: 'refused', status: 429, reason: `at most ${RUNS_PER_HOUR} runs an hour` };
    const id = mintRunId();
    const repo = repoNameFor(seed.value, id);
    this.#running = id;
    admit(sql, id, now);
    await this.ctx.storage.setAlarm(now + SWEEP_AFTER_MS);
    const ended: EndedSpan[] = [];
    const tracer = plyTracer(this.ctx, { onEnd: s => { if (ended.length < MAX_SPANS) ended.push(s); }, resource: { 'service.name': 'ply-bench' } });
    const puts: Array<Promise<unknown>> = [];
    const keep = (i: number, request: Uint8Array, response: Uint8Array): void => {
      if (request.length > 0) puts.push(this.env.BENCH_BLOBS.put(bodyKey(id, i, 'request'), request.subarray(0, BODY_CAP)).catch(() => null));
      if (response.length > 0) puts.push(this.env.BENCH_BLOBS.put(bodyKey(id, i, 'response'), response.subarray(0, BODY_CAP)).catch(() => null));
    };
    try {
      const result = await runLive({ repos: this.env.PROBE_REPOS, upstream: async (input, init) => fetch(input, init), tracer, parent: null, keepBodies: keep, created: async name => { repoCreated(sql, name, id, Date.now()); } }, entry.value.scenario, seed.value, repo);
      await Promise.all(puts);
      const c = result.cleanup;
      if (c.refused && c.deleted && c.gone) repoCleaned(sql, repo, Date.now());
      const t0 = BigInt(now) * 1_000_000n;
      const record: StoredRun = { id, scenario: entry.value.scenario.id, seed: seed.value, repo, startedAt: now, finishedAt: Date.now(), ply: PLY_SHA, result, spans: ended.map(s => spanRow(s, t0)) };
      saveRun(sql, record);
      console.log(JSON.stringify({ msg: 'ply.bench.run', run: id, scenario: record.scenario, verdict: result.verdict.tag, exchanges: result.exchanges.length, cf_rays: result.exchanges.map(x => renderRay(x.cfRay)), tokens_listed: c.tokensListed, tokens_revoked: c.tokensRevoked, revoked_status: c.revokedStatus, deleted: c.deleted, gone: c.gone, ms: record.finishedAt - now }));
      return { tag: 'done', run: id };
    } finally {
      this.#running = null;
    }
  }

  async runs(limit: number): Promise<RunSummary[]> { return listRuns(this.#sql(), Math.min(200, Math.max(1, limit))); }
  async run(id: string): Promise<StoredRun | null> {
    const r = parseRunId(id);
    return r.ok ? loadRun(this.#sql(), r.value) : null;
  }
  async body(id: string, i: number, which: 'request' | 'response'): Promise<Uint8Array | null> {
    const r = parseRunId(id);
    if (!r.ok || !Number.isSafeInteger(i) || i < 0) return null;
    const o = await this.env.BENCH_BLOBS.get(bodyKey(r.value, i, which));
    return o === null ? null : new Uint8Array(await o.arrayBuffer());
  }
  async counts(): Promise<Counts> {
    const sql = this.#sql();
    return { ...cleanupCounts(sql), lastHour: admittedSince(sql, Date.now() - HOUR_MS) };
  }

  // The sweep: any repository a run created and did not prove cleaned. Revoke every token, delete, record it.
  async alarm(): Promise<void> {
    const sql = this.#sql();
    const left = uncleaned(sql, Date.now() - (this.#running === null ? 0 : SWEEP_AFTER_MS));
    let swept = 0;
    for (const name of left) {
      let ok = false;
      try {
        const repo = await this.env.PROBE_REPOS.get(name);
        for (const t of (await repo.listTokens()).tokens) if (t.state === 'active') await repo.revokeToken(t.id);
        await this.env.PROBE_REPOS.delete(name);
        ok = true;
      } catch (e) {
        // a repository that is already gone is cleaned
        ok = /NOT_FOUND|not found/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));
      }
      if (ok) { repoCleaned(sql, name as never, Date.now()); swept++; }
    }
    console.log(JSON.stringify({ msg: 'ply.bench.sweep', left: left.length, swept }));
    if (uncleaned(sql, Number.MAX_SAFE_INTEGER).length > 0) await this.ctx.storage.setAlarm(Date.now() + SWEEP_AFTER_MS);
  }
}
