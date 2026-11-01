// Write-to-visible lag. After a successful conditional put, FlagControl invalidates the one cache tag.
// The next read revalidates and observes the new ETag. Without that invalidate, a fresh hit keeps the old revision
// until max-age. This module measures both with a model of that cache; it does not talk to the network.
import { setRollout } from './api.ts';
import { percentile } from './report.ts';
import { memoryStore, type InvalidateResult } from './store.ts';
import { ABSENT_REVISION, FLAGS_MAX_AGE_S, FLAGS_SWR_S } from './ttl.ts';
import { basisPointsOf } from './types.ts';

export type CacheView = { readonly revision: string | null; readonly cache: 'HIT' | 'REVALIDATED' | 'MISS' };

type Entry = { revision: string; storedAt: number; invalidated: boolean };

export class RulesetCache {
  private entry: Entry | null = null;

  constructor(
    private readonly readRevision: () => Promise<string | null>,
    private readonly now: () => number,
    private readonly maxAgeMs: number,
    private readonly swrMs: number,
  ) {}

  invalidate(): InvalidateResult {
    if (this.entry) this.entry.invalidated = true;
    return { kind: 'ok' };
  }

  async read(): Promise<CacheView> {
    const now = this.now();
    const entry = this.entry;
    const age = entry ? now - entry.storedAt : Number.POSITIVE_INFINITY;
    if (entry && !entry.invalidated && age < this.maxAgeMs) return { revision: entry.revision, cache: 'HIT' };
    const revision = await this.readRevision();
    if (!revision) {
      this.entry = null;
      return { revision: null, cache: 'MISS' };
    }
    const revalidated = entry !== null && entry.revision === revision;
    this.entry = { revision, storedAt: now, invalidated: false };
    return { revision, cache: revalidated ? 'REVALIDATED' : 'MISS' };
  }

  get bounds(): { readonly maxAgeMs: number; readonly swrMs: number } {
    return { maxAgeMs: this.maxAgeMs, swrMs: this.swrMs };
  }
}

export type PropagationRound = { readonly lagMs: number; readonly from: string; readonly to: string };

export async function measureRounds(rounds: number, now: () => number = () => performance.now()): Promise<{ readonly rounds: readonly PropagationRound[]; readonly p50: number | null; readonly p95: number | null; readonly p99: number | null; readonly staleWithoutInvalidate: boolean }> {
  const store = memoryStore();
  const cache = new RulesetCache(async () => (await store.get('flags/config.json'))?.etag ?? null, now, FLAGS_MAX_AGE_S * 1000, FLAGS_SWR_S * 1000);
  let revision: string = ABSENT_REVISION;
  const created = await setRollout(store, { invalidate: async () => cache.invalidate() }, 'ply.usage.note', 0, revision);
  if (created.kind !== 'ok') throw new Error(`seed failed: ${created.kind}`);
  revision = created.revision;
  await cache.read();
  const samples: PropagationRound[] = [];
  for (let i = 0; i < rounds; i++) {
    const basisPoints = i + 1;
    const before = revision;
    const started = now();
    const written = await setRollout(store, { invalidate: async () => cache.invalidate() }, 'ply.usage.note', basisPoints, revision);
    if (written.kind !== 'ok') throw new Error(`write failed: ${written.kind}`);
    revision = written.revision;
    let seen = await cache.read();
    while (seen.revision !== revision) seen = await cache.read();
    samples.push({ lagMs: now() - started, from: before, to: revision });
  }
  const held = memoryStore();
  const quiet = new RulesetCache(async () => (await held.get('flags/config.json'))?.etag ?? null, now, FLAGS_MAX_AGE_S * 1000, FLAGS_SWR_S * 1000);
  const first = await setRollout(held, { invalidate: async () => quiet.invalidate() }, 'ply.usage.note', 1, ABSENT_REVISION);
  if (first.kind !== 'ok') throw new Error('hold seed failed');
  await quiet.read();
  const second = await setRollout(held, { invalidate: async () => ({ kind: 'ok' }) }, 'ply.usage.note', 5, first.revision);
  if (second.kind !== 'ok') throw new Error('hold write failed');
  const stale = await quiet.read();
  const lags = samples.map(sample => sample.lagMs);
  return {
    rounds: samples,
    p50: percentile(lags, 0.5),
    p95: percentile(lags, 0.95),
    p99: percentile(lags, 0.99),
    staleWithoutInvalidate: stale.cache === 'HIT' && stale.revision === first.revision && basisPointsOf(second.config.flags[0]!.rollout) === 5,
  };
}
