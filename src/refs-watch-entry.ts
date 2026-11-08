// RefsWatch, the Durable Object that grants and revokes the long-lived refs policy of the public namespace (the policy and
// its bounds: src/refs-watch.ts). Reached as ctx.exports.RefsWatch from GitCache (lease, seen) and from the cron (ensure,
// poke); it purges through ctx.exports.GitCache.purgeRefs, because a Workers Cache tag is scoped to the entrypoint that
// stored it. One object (WATCH_NAME); its whole state is one small JSON value.
import { DurableObject } from 'cloudflare:workers';
import { Tracer, arrayExporter, createTransport, lsRefs } from 'ply';
import { chainGet, dig, fromNullable, recordGet } from './absent.ts';
import { MIRROR_LIMITS } from './limits.ts';
import { createTokenSource, publicRemote, scrubSecrets, type ArtifactsNamespace, type TokenSource } from './public.ts';
import { checkRemote, createGuardedFetch, redirectOptions } from './remote.ts';
import {
  POLL_TIMEOUT_MS, WATCH_TICK_MS, applyTick, emptyState, leaseRepo, needsAlarm, pollList, purgeFailed, refMapOf, sawRefs,
  type LeaseAnswer, type PollResult, type WatchState,
} from './refs-watch.ts';

type Env = { PUBLIC_REPOS: unknown };
type PurgeAnswer = { ok: boolean; ms: number; error: string };
type GitCacheRpc = { purgeRefs(repos: string[]): Promise<PurgeAnswer> };

const STATE_KEY = 'state';

function errorText(e: unknown): string {
  const code = chainGet(e, 'code');
  const message = chainGet(e, 'message');
  return `${code.tag === 'some' ? String(code.value) : ''} ${message.tag === 'some' ? String(message.value) : String(e)}`.trim().slice(0, 160);
}

/** One ls-refs of every ref, straight upstream with the binding's read token. Never through GitCache. */
export async function pollRefs(repo: string, tokens: TokenSource, fetchImpl: typeof fetch = (i, n) => fetch(i, n)): Promise<PollResult> {
  try {
    const dst = checkRemote(publicRemote(repo));
    const bearer = await tokens.readToken(repo);
    const made = createTransport(dst.href, {
      tracer: new Tracer({ exporter: arrayExporter(), resource: { 'service.name': 'ply-refswatch' } }),
      limits: MIRROR_LIMITS, quirks: {}, auth: { bearer }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      fetchImpl: createGuardedFetch(fetchImpl, dst), ...redirectOptions(dst),
    });
    if (!made.ok) return { ok: false, error: errorText(made.error) };
    const listed = await lsRefs(made.value);
    if (!listed.ok) return { ok: false, error: errorText(listed.error) };
    return { ok: true, refs: refMapOf(listed.value.refs.values(), listed.value.head) };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

function pollError(polls: Record<string, PollResult>, repo: string): string {
  const found = recordGet(polls, repo);
  return found.tag === 'some' && !found.value.ok ? found.value.error : '';
}

export class RefsWatch extends DurableObject<Env> {
  #state: WatchState | null = null;
  #tokens: TokenSource | null = null;
  #ticking = false;

  async #load(): Promise<WatchState> {
    if (this.#state === null) {
      const stored = fromNullable(await this.ctx.storage.get<WatchState>(STATE_KEY));
      this.#state = stored.tag === 'some' ? stored.value as WatchState : emptyState();
    }
    return this.#state;
  }

  async #save(): Promise<void> {
    if (this.#state !== null) await this.ctx.storage.put(STATE_KEY, this.#state);
  }

  async #arm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  #tokenSource(): TokenSource | null {
    if (this.#tokens === null && this.env.PUBLIC_REPOS) this.#tokens = createTokenSource(this.env.PUBLIC_REPOS as ArtifactsNamespace);
    return this.#tokens;
  }

  async lease(repo: string): Promise<LeaseAnswer> {
    const state = await this.#load();
    const answer = leaseRepo(state, repo, Date.now());
    await this.#save();
    // A new repo is polled at once, so the next fill can be granted.
    await this.#arm(answer.reason === 'new' ? Date.now() : Date.now() + WATCH_TICK_MS);
    return answer;
  }

  async seen(repo: string, refs: [string, string][]): Promise<boolean> {
    const state = await this.#load();
    const differs = sawRefs(state, repo, refs);
    if (differs) {
      await this.#save();
      await this.#arm(Date.now());
      console.log(JSON.stringify({ msg: 'ply.refswatch', event: 'seen_mismatch', repo }));
    }
    return differs;
  }

  /** The mirror pushed: poll now. */
  async poke(repos: string[]): Promise<void> {
    const state = await this.#load();
    if (repos.some(r => recordGet(state.repos, r).tag === 'some')) await this.#arm(Date.now());
  }

  /** The minute cron: an alarm that should be set but is not is set for now (that tick then sees the gap and purges). */
  async ensure(): Promise<{ repos: number; alarm: number | null; polls: number }> {
    const state = await this.#load();
    if (needsAlarm(state) && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
    const polls = state.polls || 0;
    state.polls = 0;
    await this.#save();
    return { repos: Object.keys(state.repos).length, alarm: await this.ctx.storage.getAlarm(), polls };
  }

  async status(): Promise<WatchState> {
    return this.#load();
  }

  override async alarm(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#tick();
    } finally {
      this.#ticking = false;
    }
  }

  async #tick(): Promise<void> {
    const t0 = Date.now();
    const state = await this.#load();
    const tokens = this.#tokenSource();
    const repos = pollList(state);
    const polls: Record<string, PollResult> = {};
    await Promise.all(repos.map(async repo => {
      polls[repo] = tokens === null ? { ok: false, error: 'no PUBLIC_REPOS binding' } : await pollRefs(repo, tokens);
    }));
    state.polls = (state.polls || 0) + repos.length;
    const pollMs = Date.now() - t0;
    const now = Date.now();
    const report = applyTick(state, polls, now);
    let purge: PurgeAnswer | null = null;
    if (report.purge.length > 0) {
      purge = await this.#purge(report.purge);
      if (!purge.ok) purgeFailed(state, report.purge);
    }
    await this.#save();
    if (needsAlarm(state)) await this.ctx.storage.setAlarm(t0 + WATCH_TICK_MS);
    const scrub = scrubSecrets(tokens === null ? [] : tokens.secrets());
    if (report.purge.length > 0 || report.failed.length > 0 || report.gap || report.expired.length > 0) {
      console.log(scrub(JSON.stringify({
        msg: 'ply.refswatch', event: 'tick', repos: repos.length, poll_ms: pollMs, since_ms: report.sinceMs, gap: report.gap,
        changed: report.changed, again: report.again, failed: report.failed.map(r => `${r}: ${pollError(polls, r)}`),
        expired: report.expired, purge: report.purge, purge_ok: purge === null ? null : purge.ok, purge_ms: purge === null ? null : purge.ms,
        purge_error: purge === null ? '' : purge.error,
      })));
    }
  }

  async #purge(repos: string[]): Promise<PurgeAnswer> {
    const found = dig(this.ctx, ['exports', 'GitCache']);
    if (found.tag === 'none' || !found.value) return { ok: false, ms: 0, error: 'no GitCache entrypoint' };
    try {
      return await (found.value as GitCacheRpc).purgeRefs(repos);
    } catch (e) {
      return { ok: false, ms: 0, error: errorText(e) };
    }
  }
}
