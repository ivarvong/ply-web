// Watched refs: a long-lived refs cache for the public namespace that stays exactly as fresh as the short one, because
// it is purged when a ref moves instead of expiring on a timer.
//
// Today every ls-refs answer is cached `max-age=5, stale-while-revalidate=10`: a page can show a head up to ~15 s old,
// and a visitor on a quiet colo (nothing there for 15 s) waits on the upstream ls-refs (78% of sparse /r/ply wall time,
// run sparse-ply on 2a4741c0). Here, for public-namespace repos only (forges keep the 15 s policy), GitCache stores the
// answer for WATCHED_MAX_AGE_S + WATCHED_SWR_S, tagged with the repo (refsTag), and RefsWatch purges that tag when the
// repo's refs change. Workers Cache purges are global (both tiers, every colo): in 10 trials × 9 regions every colo
// served the new value 21-425 ms after `ctx.cache.purge` returned, p50 144 ms (lab_notebook ply-web-refs-2026-11-07).
//
// RefsWatch (one Durable Object) is the only thing that grants the long policy:
//   lease(repo)    GitCache asks before it stores a watched answer, in parallel with its upstream ls-refs. The answer is
//                  long-lived only when the watcher has polled that repo successfully within HEALTHY_MS; otherwise
//                  GitCache stores today's short policy. The lease keeps the repo polled for LEASE_MS, longer than any
//                  answer granted under it can be served (two cache tiers, each max-age + swr).
//   alarm          every WATCH_TICK_MS: ls-refs each leased repo (straight upstream, never through the cache) and purge
//                  every repo whose refs differ from the last poll. Every purge is repeated SECOND_PURGE_MS later: a
//                  fill that read the old refs before the push and was stored after the first purge is gone by then
//                  (GitCache aborts a watched upstream after REFS_FILL_TIMEOUT_MS < SECOND_PURGE_MS).
//   seen(repo, …)  GitCache reports the refs it stored. A ref the watcher has not seen (a push and its revert inside one
//                  tick, or a fill racing a push) purges the repo.
//   poke(repos)    the mirror cron after it pushes: poll now instead of waiting for the grid.
//   ensure()       the minute cron: an alarm that should be set but is not is set for now.
//
// The alarm (WATCH_TICK_MS, a heartbeat) is separate from the poll grid (pollTicksOf): one ls-refs per poll can be a billed
// Artifacts operation, so polls are every 4th tick; liveness, gap detection, purge retries and failing repos stay on the
// 3 s heartbeat. Repeat purges wait for their repo's next grid tick, so purges for a push share the tick's one purge call:
// at most one call per grid period (12 s, i.e. 5/min, the Workers Cache tag-purge refill).
// Bound on how long a page can show an old head after any push (the mirror's, or one made straight to Artifacts):
// the poll grid + one upstream ls-refs + purge propagation (≈ 12 s + 0.1-0.7 s + 0.1-0.4 s), against ~15 s before.
// Failure modes, each closed: a tick later than WATCH_GAP_MS (alarm stalled, DO restarted, a deploy without the watcher)
// purges every leased repo; a repo that fails two polls FAIL_PURGE_MS apart is purged and no longer granted; a failed purge
// is retried every tick; GitCache stores the short policy whenever the lease does not answer in LEASE_TIMEOUT_MS.
// What is left: the watcher and its cron both stopped for longer than a tick while an answer granted before is still
// cached. That answer can then be served for at most WATCHED_MAX_AGE_S + WATCHED_SWR_S (×2 across tiers).
import { captureGroup, recordGet } from './absent.ts';
import { PUBLIC_NAMESPACE, isPublicRepoName } from './public.ts';

export const WATCHED_MAX_AGE_S = 300;
export const WATCHED_SWR_S = 300;
export const WATCHED_REFS_CACHE = `public, max-age=${WATCHED_MAX_AGE_S}, stale-while-revalidate=${WATCHED_SWR_S}`;

/** The alarm's period. A heartbeat: it costs no Artifacts operation unless the tick is a poll tick. */
export const WATCH_TICK_MS = 3_000;
/** One poll's own deadline. */
export const POLL_TIMEOUT_MS = 5_000;
/** Default poll period, in ticks. Each ls-refs may be a billed Artifacts operation ($0.15 / 1000 from 2026-11-12). */
export const POLL_EVERY_TICKS = 1;
/** Phase 1 only: experiment arms polled on the 12 s grid while every other repo keeps POLL_EVERY_TICKS. */
export const POLL_TICKS_OVERRIDE: Readonly<Record<string, number>> = { 'fresh-slow': 4, 'ply-slow': 4 };
export function pollTicksOf(repo: string): number {
  const found = recordGet(POLL_TICKS_OVERRIDE, repo);
  return found.tag === 'some' ? found.value : POLL_EVERY_TICKS;
}
export function pollIntervalMs(repo: string): number {
  return pollTicksOf(repo) * WATCH_TICK_MS;
}
/** No tick for this long: the watcher is presumed stopped and grants nothing. */
export const HEALTHY_TICK_MS = 3 * WATCH_TICK_MS;
/** A repo polled less recently than this is not granted: its poll period, one slow poll, one second of alarm jitter. */
export function healthyPollMs(repo: string): number {
  return pollIntervalMs(repo) + POLL_TIMEOUT_MS + 1_000;
}
/** A tick this late may have missed a push: every leased repo is purged. */
export const WATCH_GAP_MS = 4 * WATCH_TICK_MS;
/** The upstream ls-refs of a watched fill is aborted after this, so no fill outlives the second purge. */
export const REFS_FILL_TIMEOUT_MS = 8_000;
export const SECOND_PURGE_MS = REFS_FILL_TIMEOUT_MS + 2_000;
/** A repo failing two polls this far apart is purged once (fail closed) and is not granted until it reads. */
export const FAIL_PURGE_MS = WATCH_TICK_MS;
/** GitCache waits this long for lease(); no answer stores the short policy. */
export const LEASE_TIMEOUT_MS = 2_000;
/** Longer than a granted answer can be served: two tiers, each max-age + swr, plus a minute. */
export const LEASE_MS = 2 * (WATCHED_MAX_AGE_S + WATCHED_SWR_S) * 1000 + 60_000;
/** Workers Cache takes at most 100 tags per purge (developers.cloudflare.com/cache/how-to/purge-cache, 2026-11-07). */
export const MAX_PURGE_TAGS = 100;
/** The one RefsWatch object. */
export const WATCH_NAME = `refs-${PUBLIC_NAMESPACE}`;

/** The Cache-Tag on every watched refs answer of `repo`; RefsWatch purges it. Tags compare case-insensitively. */
export function refsTag(repo: string): string {
  return `ply-refs-${PUBLIC_NAMESPACE}-${repo}`;
}

/** name → oid. HEAD's symref target is kept as `HEAD->` so a retarget is a change too. */
export type RefMap = Record<string, string>;

export type RepoWatch = {
  /** Poll this repo until then. */
  lease: number;
  /** The last successful poll's refs; null before the first. */
  refs: RefMap | null;
  polledAt: number;
  failingSince: number | null;
  failPurged: boolean;
  /** Poll at the next tick whatever the grid says: the mirror pushed, or a fill reported refs the watcher has not seen. */
  pollNow: boolean;
};

export type WatchState = {
  repos: Record<string, RepoWatch>;
  /** The last tick that ran; 0 before the first. */
  tickAt: number;
  /** Ticks run so far (absent in state written before polls left the 3 s grid): the poll grid. */
  ticks: number;
  /** repo → when its repeat purge is due. */
  again: Record<string, number>;
  /** Repos to purge at the next tick (a seen() mismatch, a failed purge). */
  soon: string[];
};

export function emptyState(): WatchState {
  return { repos: {}, tickAt: 0, ticks: 0, again: {}, soon: [] };
}

export type LeaseAnswer = { grant: boolean; reason: 'ok' | 'new' | 'unpolled' | 'stale' | 'failing' | 'bad_name' };

/** GitCache's question before it stores a watched answer. Starts watching a repo it does not know. */
export function leaseRepo(state: WatchState, repo: string, now: number): LeaseAnswer {
  if (!isPublicRepoName(repo)) return { grant: false, reason: 'bad_name' };
  const found = recordGet(state.repos, repo);
  if (found.tag === 'none') {
    state.repos[repo] = { lease: now + LEASE_MS, refs: null, polledAt: 0, failingSince: null, failPurged: false, pollNow: false };
    return { grant: false, reason: 'new' };
  }
  const known = found.value;
  known.lease = Math.max(known.lease, now + LEASE_MS);
  if (known.refs === null) return { grant: false, reason: 'unpolled' };
  if (known.failingSince !== null) return { grant: false, reason: 'failing' };
  if (now - state.tickAt > HEALTHY_TICK_MS || now - known.polledAt > healthyPollMs(repo)) return { grant: false, reason: 'stale' };
  return { grant: true, reason: 'ok' };
}

/** GitCache stored these refs for `repo`. True when one differs from the watcher's view (the repo is purged next tick). */
export function sawRefs(state: WatchState, repo: string, seen: readonly (readonly [string, string])[]): boolean {
  const known = recordGet(state.repos, repo);
  if (known.tag === 'none' || known.value.refs === null) return false;
  const refs = known.value.refs;
  // A HEAD target the watcher did not list (its ls-refs carried no symref) is not a difference.
  const differs = seen.some(([name, oid]) => !(name === 'HEAD->' && !(name in refs)) && refs[name] !== oid);
  if (differs) {
    if (!state.soon.includes(repo)) state.soon.push(repo);
    known.value.pollNow = true;
  }
  return differs;
}

export type PollResult = { ok: true; refs: RefMap } | { ok: false; error: string };

export type TickReport = {
  /** Repos to purge now (deduplicated, sorted). */
  purge: string[];
  changed: { repo: string; from: string; to: string }[];
  gap: boolean;
  /** ms since the previous tick, or null on the first. */
  sinceMs: number | null;
  failed: string[];
  expired: string[];
  again: string[];
};

function sameRefs(a: RefMap, b: RefMap): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every(k => a[k] === b[k]);
}

/** A short label for a log line: HEAD's oid when there is one. */
export function headLabel(refs: RefMap | null): string {
  if (refs === null) return '';
  const head = recordGet(refs, 'HEAD');
  return head.tag === 'none' ? `${Object.keys(refs).length} refs` : head.value.slice(0, 12);
}

/** Ticks since the first (0 for state written before the grid existed). */
function tickCount(state: WatchState): number {
  return state.ticks || 0;
}

/**
 * The repos to poll this tick. A repo is polled on its own grid (every pollTicksOf ticks, so all default repos poll on the
 * same tick and share one purge call), and also when it has no baseline, when something asked for it, or while it fails
 * and has not been purged yet: a failing repo is retried each tick so its failure bound does not depend on the grid.
 */
export function pollList(state: WatchState): string[] {
  const n = tickCount(state);
  return Object.keys(state.repos).filter(repo => {
    const w = state.repos[repo] as RepoWatch;
    return w.pollNow || w.refs === null || (w.failingSince !== null && !w.failPurged) || n % pollTicksOf(repo) === 0;
  }).sort();
}

/**
 * Apply one tick's polls. Mutates `state`. Every purge it asks for is also scheduled again SECOND_PURGE_MS later.
 * `polls` holds a result for each repo this tick polled; a repo leased since has none and is left for the next tick.
 */
export function applyTick(state: WatchState, polls: Record<string, PollResult>, now: number): TickReport {
  const purge = new Set<string>();
  const changed: TickReport['changed'] = [];
  const failed: string[] = [];
  const expired: string[] = [];
  const sinceMs = state.tickAt === 0 ? null : now - state.tickAt;
  const gap = sinceMs !== null && sinceMs > WATCH_GAP_MS;
  for (const repo of pollList(state)) {
    const watch = state.repos[repo] as RepoWatch;
    if (gap) purge.add(repo);
    const result = recordGet(polls, repo);
    const polled = result.tag === 'some' ? result.value : null;
    if (polled !== null) watch.pollNow = false;
    if (polled === null) {
      // Off its grid this tick, or leased while this tick's polls were in flight.
    } else if (polled.ok) {
      // A first baseline purges too: an answer from an earlier lease of this repo may still be cached.
      if (watch.refs === null || !sameRefs(watch.refs, polled.refs)) {
        purge.add(repo);
        changed.push({ repo, from: headLabel(watch.refs), to: headLabel(polled.refs) });
      }
      watch.refs = polled.refs;
      watch.polledAt = now;
      watch.failingSince = null;
      watch.failPurged = false;
    } else {
      failed.push(repo);
      if (watch.failingSince === null) watch.failingSince = now;
      if (!watch.failPurged && now - watch.failingSince >= FAIL_PURGE_MS) {
        purge.add(repo);
        watch.failPurged = true;
      }
    }
    if (now > watch.lease) {
      expired.push(repo);
      delete state.repos[repo];
    }
  }
  for (const repo of state.soon) purge.add(repo);
  state.soon = [];
  const again: string[] = [];
  for (const [repo, due] of Object.entries(state.again)) {
    // A repeat waits for its repo's next grid tick: it shares that tick's purge call, and a later repeat is never short.
    if (due <= now && tickCount(state) % pollTicksOf(repo) === 0) {
      again.push(repo);
      purge.add(repo);
      delete state.again[repo];
    }
  }
  // Every purge except a repeat is repeated once (a repeat that coincides with a fresh purge is rescheduled).
  for (const repo of purge) {
    if (!again.includes(repo) || changed.some(c => c.repo === repo)) state.again[repo] = now + SECOND_PURGE_MS;
  }
  state.tickAt = now;
  state.ticks = tickCount(state) + 1;
  return { purge: [...purge].sort(), changed, gap, sinceMs, failed, expired, again };
}

/** A purge that did not go through: its repos are purged at the next tick. */
export function purgeFailed(state: WatchState, repos: readonly string[]): void {
  for (const repo of repos) if (!state.soon.includes(repo)) state.soon.push(repo);
}

/** Keep polling while a lease or a repeat purge is outstanding. */
export function needsAlarm(state: WatchState): boolean {
  return Object.keys(state.repos).length > 0 || Object.keys(state.again).length > 0 || state.soon.length > 0;
}

/**
 * The refs in an ls-refs (protocol v2) answer: pkt-lines `<oid> <name>[ attr…]`. A `symref-target:` on HEAD is kept as
 * `HEAD->`. Anything else (flush, unborn, a malformed line) is skipped: the result is only ever compared.
 */
export function parseLsRefsAnswer(bytes: Uint8Array): [string, string][] {
  const out: [string, string][] = [];
  let i = 0;
  const dec = new TextDecoder();
  while (i + 4 <= bytes.length) {
    const len = Number.parseInt(dec.decode(bytes.subarray(i, i + 4)), 16);
    if (!Number.isFinite(len)) break;
    if (len < 4) { i += 4; continue; }
    const line = dec.decode(bytes.subarray(i + 4, i + len)).replace(/\n$/, '');
    i += len;
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)(.*)$/.exec(line);
    if (m === null) continue;
    const [, oid, name, rest] = m as unknown as [string, string, string, string];
    out.push([name, oid]);
    const target = captureGroup(/(^| )symref-target:(\S+)/.exec(rest), 2);
    if (name === 'HEAD' && target.tag === 'some') out.push(['HEAD->', target.value]);
  }
  return out;
}

/** The watcher's RefMap from ply's ls-refs result. */
export function refMapOf(refs: Iterable<{ name: string; oid: string }>, head: string | null): RefMap {
  const out: RefMap = {};
  for (const r of refs) out[r.name] = r.oid;
  if (head !== null) out['HEAD->'] = head;
  return out;
}
