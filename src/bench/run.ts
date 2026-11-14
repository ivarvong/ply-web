// One run of one scenario against Artifacts, from the Worker: build the seed (src/bench/seed.ts), create a fresh
// repository in the probe namespace, seed it, run each step with ply as the client under test (faults applied by the
// recorder), read the end state back (src/bench/judge.ts), classify (src/bench/verdict.ts), then clean up: revoke every
// token the repository has (the one create minted included), prove the revoked token is refused, delete the repository
// and prove it is gone. The steps follow ply's own runner (test/probes/runner.mjs runScenario) step for step.
import { GitHttp, type Span, type Tracer } from 'ply';
import { plyOutcome, type Classified, type EndState, type Fault, type From, type Names, type Observation, type Push, type Scenario, type StepObservation, type Timeouts } from 'ply/probes';
import { renderRay } from '../rays.ts';
import type { RepoName, RunSeed } from './brand.ts';
import { handPack } from './handpack.ts';
import { readEnd } from './judge.ts';
import { createRecorder, type Channel, type Exchange, type Recorder } from './recorder.ts';
import { type Result, err, ok } from './result.ts';
import { buildSeed, objectsFor, oidOf, reachable, seedTips, ZERO_OID, type SeedStore, type StoredObject } from './seed.ts';
import { verdictOf, type RunVerdict } from './verdict.ts';

const TYPE_CODE: Readonly<Record<StoredObject['type'], number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const BLOB = 3;
const REVOKED = new Set([401, 403]);

// The parts of the Artifacts Workers binding a run uses (the namespace binding, scoped to the probe namespace).
export type RepoHandle = {
  listTokens(): Promise<{ readonly tokens: ReadonlyArray<{ readonly id: string; readonly state: string }> }>;
  revokeToken(tokenOrId: string): Promise<boolean>;
};
export type ProbeRepos = {
  create(name: string): Promise<{ readonly name: string; readonly remote: string; readonly token: string }>;
  get(name: string): Promise<RepoHandle>;
  delete(name: string): Promise<boolean>;
};

export type Cleanup = {
  readonly tokensListed: number;
  readonly tokensRevoked: number;
  // the create-minted token, tried after the revokes: the status Artifacts answered and its cf-ray
  readonly revokedStatus: number | null;
  readonly revokedRay: string;
  readonly refused: boolean;
  readonly deleted: boolean;
  readonly gone: boolean;
  readonly errors: readonly string[];
};
export type RunResult = {
  readonly steps: readonly StepObservation[];
  readonly end: EndState | null;
  readonly names: Names;
  readonly exchanges: readonly Exchange[];
  readonly verdict: RunVerdict;
  readonly cleanup: Cleanup;
  readonly remote: string;
};
export type RunDeps = {
  readonly repos: ProbeRepos;
  readonly upstream: typeof fetch;
  readonly tracer: Tracer;
  readonly parent: Span | null;
  readonly keepBodies: (i: number, request: Uint8Array, response: Uint8Array) => void;
  // called once the repository exists, before anything is pushed: the run's owner records it for the sweep
  readonly created: (name: RepoName) => Promise<void>;
};

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);
const plyErr = (e: { readonly code: string; readonly message: string }, prefix: string): Classified => plyOutcome({ ok: false, code: e.code, message: `${prefix}${String(e.message)}` });
const asPackObjects = (objs: readonly StoredObject[]): Array<{ readonly oid: string; readonly type: number; readonly data: Uint8Array }> => objs.map(o => ({ oid: o.oid, type: TYPE_CODE[o.type], data: o.data }));

type Ctx = {
  readonly store: SeedStore;
  readonly scenario: Scenario;
  readonly recorder: Recorder;
  readonly remote: string;
  readonly token: string;
  readonly tracer: Tracer;
};
function client(c: Ctx, ch: Channel, parent: Span, timeouts: Timeouts): Result<GitHttp, Classified> {
  const limits = timeouts === null ? {} : { limits: { firstByteTimeoutMs: timeouts.ms, idleTimeoutMs: timeouts.ms } };
  const g = GitHttp.create(c.remote, { fetchImpl: c.recorder.fetchFor(ch), auth: { bearer: c.token }, tracer: c.tracer, parent, quirks: {}, recordResponseHeaders: ['cf-ray'], ...limits });
  return g.ok ? ok(g.value) : err(plyErr(g.error, 'client: '));
}

async function plyPush(c: Ctx, push: Push, from: From, timeouts: Timeouts, parent: Span): Promise<Classified> {
  const g = client(c, 'main', parent, timeouts);
  if (!g.ok) return g.error;
  if (from.tag === 'partial') {
    const main = c.scenario.seed.refs.find(r => r.ref === 'refs/heads/main');
    const tip = oidOf(c.store, { tag: 'obj', name: typeof main === 'object' ? main.at : '' });
    if (!tip.ok) return { outcome: 'rejected', error: 'harness', detail: tip.error };
    const f = await g.value.fetchPack({ wants: [tip.value], filter: 'blob:none' });
    if (!f.ok) return plyErr(f.error, 'partial fetch: ');
    const blobs = f.value.objects === null ? 0 : [...f.value.objects.values()].filter(o => o.type === BLOB).length;
    if (blobs > 0) return { outcome: 'rejected', error: 'harness', detail: `partial fetch carried ${blobs} blobs` };
  }
  const have = seedTips(c.store, c.scenario);
  if (!have.ok) return { outcome: 'rejected', error: 'harness', detail: have.error };
  const objects = objectsFor(c.store, push, have.value);
  if (!objects.ok) return { outcome: 'rejected', error: 'harness', detail: objects.error };
  const cmds: Array<{ readonly ref: string; readonly oldOid: string; readonly newOid: string }> = [];
  for (const u of push.updates) {
    const o = oidOf(c.store, u.old);
    const n = oidOf(c.store, u.new);
    if (!o.ok || !n.ok) return { outcome: 'rejected', error: 'harness', detail: `unknown object in ${u.ref}` };
    cmds.push({ ref: u.ref, oldOid: o.value, newOid: n.value });
  }
  const [first, ...rest] = cmds;
  if (typeof first !== 'object') return { outcome: 'rejected', error: 'harness', detail: 'a push with no command' };
  const commands = [first, ...rest] as const;
  const atomic = push.atomic ? { atomic: true } : {};
  if (push.pack.tag === 'hand') {
    const bytes = await handPack(c.store, objects.value, push.pack);
    if (!bytes.ok) return { outcome: 'rejected', error: 'harness', detail: bytes.error };
    const body = bytes.value;
    const pack = new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(body); ctl.close(); } });
    const r = await g.value.pushPack({ commands, pack, length: body.length, ...atomic });
    return r.ok ? plyOutcome({ ok: true }) : plyErr(r.error, '');
  }
  const r = await g.value.push({ commands, objects: asPackObjects(objects.value), ...atomic });
  return r.ok ? plyOutcome({ ok: true }) : plyErr(r.error, '');
}

async function plyFetch(c: Ctx, want: string, timeouts: Timeouts, parent: Span): Promise<Classified> {
  const g = client(c, 'main', parent, timeouts);
  if (!g.ok) return g.error;
  const id = oidOf(c.store, { tag: 'obj', name: want });
  if (!id.ok) return { outcome: 'rejected', error: 'harness', detail: id.error };
  const f = await g.value.fetchPack({ wants: [id.value] });
  if (!f.ok) return plyErr(f.error, '');
  const objs = f.value.objects;
  return objs !== null && objs.has(id.value) ? { outcome: 'landed', error: null, detail: `fetched ${objs.size} objects` } : { outcome: 'rejected', error: 'harness', detail: 'the wanted object did not arrive' };
}

// The other writer of a race: a forced move of each ref (old id = what the ref holds now), on the side channel.
async function sideMove(c: Ctx, f: Extract<Fault, { readonly tag: 'race' }>, parent: Span): Promise<number> {
  const span = c.tracer.start('bench.race', { parent, attrs: { 'bench.moves': f.moves.length } });
  const g = client(c, 'side', span, null);
  if (!g.ok) { span.error(new Error(g.error.detail)).end(); return 0; }
  const ls = await g.value.lsRefs();
  const now = new Map<string, string>(ls.ok ? [...ls.value.refs].map(([k, v]) => [k, String(v.oid)]) : []);
  const commands = f.moves.map(m => {
    const to = oidOf(c.store, m.to);
    return { ref: m.ref, oldOid: now.get(m.ref) || ZERO_OID, newOid: to.ok ? to.value : ZERO_OID };
  });
  const objs = reachable(c.store, commands.map(x => x.newOid).filter(x => x !== ZERO_OID) as never).flatMap(o => {
    const got = c.store.objects.get(o);
    return typeof got === 'object' ? [got] : [];
  });
  const [first, ...rest] = commands;
  const r = typeof first === 'object' ? await g.value.push({ commands: [first, ...rest], objects: asPackObjects(objs) }) : null;
  span.set({ 'bench.race.ok': r !== null && r.ok }).end();
  return commands.length;
}

async function seedRepo(c: Ctx, parent: Span): Promise<Result<number, string>> {
  const refs = c.scenario.seed.refs;
  if (refs.length === 0) return ok(0);
  const span = c.tracer.start('bench.seed.push', { parent, attrs: { 'bench.refs': refs.length } });
  c.recorder.setPhase({ tag: 'seed' }, span);
  const g = client(c, 'side', span, null);
  if (!g.ok) { span.error(new Error(g.error.detail)).end(); return err(g.error.detail); }
  const tips = seedTips(c.store, c.scenario);
  if (!tips.ok) { span.end(); return tips; }
  const commands = refs.map((r, i) => ({ ref: r.ref, oldOid: ZERO_OID, newOid: String(tips.value[i]) }));
  const objs = reachable(c.store, tips.value).flatMap(o => {
    const got = c.store.objects.get(o);
    return typeof got === 'object' ? [got] : [];
  });
  const [first, ...rest] = commands;
  if (typeof first !== 'object') { span.end(); return ok(0); }
  const r = await g.value.push({ commands: [first, ...rest], objects: asPackObjects(objs) });
  if (!r.ok) { span.error(new Error(r.error.message)).end(); return err(`seed push: ${r.error.code}: ${r.error.message}`); }
  span.set({ 'bench.objects': objs.length }).ok().end();
  return ok(objs.length);
}

async function runStep(c: Ctx, i: number, steps: readonly StepObservation[], span: Span): Promise<StepObservation> {
  const st = c.scenario.steps[i];
  if (typeof st !== 'object') return { outcomes: [{ outcome: 'rejected', error: 'harness', detail: 'no such step' }] };
  switch (st.tag) {
    case 'push':
    case 'fetch': {
      if (st.tag === 'push' && st.ply.tag === 'none') return { outcomes: [{ outcome: 'landed', error: 'skipped', detail: st.ply.why }] };
      const f = st.fault;
      if (f.tag !== 'none') c.recorder.arm({ fault: f, on: st.tag === 'push' ? 'receive' : 'fetch', race: async () => (f.tag === 'race' ? sideMove(c, f, span) : 0) });
      const r = st.tag === 'fetch' ? await plyFetch(c, st.want, st.timeouts, span) : await plyPush(c, st.push, st.from, st.timeouts, span);
      const unfired = c.recorder.disarm();
      return { outcomes: [{ outcome: r.outcome, error: r.error, detail: unfired ? `fault ${f.tag} never fired; ${r.detail}` : r.detail }] };
    }
    case 'retry-unlanded': {
      const prev = c.scenario.steps[st.of];
      const seen = steps[st.of];
      const pushes = typeof prev === 'object' && prev.tag === 'concurrent' ? prev.pushes : [];
      const outcomes: Array<StepObservation['outcomes'][number]> = [];
      for (const [k, p] of pushes.entries()) {
        const firstTry = typeof seen === 'object' ? seen.outcomes[k] : null;
        if (typeof firstTry === 'object' && firstTry !== null && firstTry.outcome === 'landed') { outcomes.push({ outcome: 'landed', error: null, detail: 'landed the first time' }); continue; }
        const r = await plyPush(c, p, { tag: 'full' }, null, span);
        outcomes.push({ outcome: r.outcome, error: r.error, detail: `retry after ${typeof firstTry === 'object' && firstTry !== null ? firstTry.outcome : '?'}: ${r.detail}` });
      }
      const [o0, ...more] = outcomes;
      return typeof o0 === 'object' ? { outcomes: [o0, ...more] } : { outcomes: [{ outcome: 'landed', error: null, detail: 'nothing to retry' }] };
    }
    case 'concurrent': {
      const rs = await Promise.all(st.pushes.map(async p => plyPush(c, p, { tag: 'full' }, null, span)));
      const [o0, ...more] = rs.map(r => ({ outcome: r.outcome, error: r.error, detail: r.detail }));
      return typeof o0 === 'object' ? { outcomes: [o0, ...more] } : { outcomes: [{ outcome: 'landed', error: null, detail: 'no push' }] };
    }
  }
}

async function cleanup(deps: RunDeps, c: Ctx, name: RepoName, parent: Span): Promise<Cleanup> {
  const span = deps.tracer.start('bench.cleanup', { parent, attrs: { 'artifacts.repo': name } });
  c.recorder.setPhase({ tag: 'cleanup' }, span);
  const errors: string[] = [];
  let listed = 0;
  let revoked = 0;
  try {
    const repo = await deps.repos.get(name);
    const tokens = await repo.listTokens();
    listed = tokens.tokens.length;
    for (const t of tokens.tokens) {
      const s = deps.tracer.start('bench.token.revoke', { parent: span, attrs: { 'artifacts.token.state': t.state } });
      if (t.state === 'active' && (await repo.revokeToken(t.id))) revoked++;
      s.end();
    }
  } catch (e) { errors.push(`revoke: ${errText(e)}`); }
  let status: number | null = null;
  let ray = 'no_response';
  const probe = deps.tracer.start('bench.token.probe', { parent: span });
  try {
    const before = c.recorder.exchanges.length;
    const res = await c.recorder.fetchFor('judge')(`${c.remote}/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${c.token}`, 'git-protocol': 'version=2' } });
    await res.arrayBuffer();
    status = res.status;
    const x = c.recorder.exchanges[before];
    ray = typeof x === 'object' ? renderRay(x.cfRay) : ray;
  } catch (e) { errors.push(`probe: ${errText(e)}`); }
  probe.set({ 'http.response.status_code': status === null ? -1 : status, 'cf.ray': ray }).end();
  let deleted = false;
  try { deleted = await deps.repos.delete(name); } catch (e) { errors.push(`delete: ${errText(e)}`); }
  let gone = false;
  try { await deps.repos.get(name); } catch (e) { gone = /NOT_FOUND|not found/i.test(errText(e)) || (typeof e === 'object' && e !== null && 'code' in e && e.code === 'NOT_FOUND'); }
  const refused = status !== null && REVOKED.has(status);
  span.set({ 'bench.tokens.listed': listed, 'bench.tokens.revoked': revoked, 'bench.revoked.status': status === null ? -1 : status, 'bench.repo.deleted': deleted, 'bench.repo.gone': gone });
  if (refused && deleted && gone) span.ok(); else span.error(new Error(`cleanup incomplete: refused=${refused} deleted=${deleted} gone=${gone}`));
  span.end();
  return { tokensListed: listed, tokensRevoked: revoked, revokedStatus: status, revokedRay: ray, refused, deleted, gone, errors };
}

const NO_CLEANUP: Cleanup = { tokensListed: 0, tokensRevoked: 0, revokedStatus: null, revokedRay: 'no_response', refused: false, deleted: false, gone: false, errors: ['the repository was never created'] };

export async function runLive(deps: RunDeps, scenario: Scenario, seed: RunSeed, name: RepoName): Promise<RunResult> {
  const t0 = Date.now();
  const root = deps.tracer.start('bench.run', { parent: deps.parent, attrs: { 'probe.scenario': scenario.id, 'bench.seed': seed, 'artifacts.repo': name } });
  const fail = (stage: 'seed' | 'step' | 'judge', message: string): RunVerdict => ({ tag: 'harness', stage, message });
  const built = await deps.tracer.span('bench.seed.build', { parent: root }, async s => { const r = await buildSeed(scenario.seed); s.set({ 'bench.objects': r.ok ? r.value.objects.size : 0 }); return r; });
  if (!built.ok) {
    root.error(new Error(built.error)).end();
    return { steps: [], end: null, names: {}, exchanges: [], verdict: fail('seed', built.error), cleanup: NO_CLEANUP, remote: '' };
  }
  const store = built.value;
  const created = deps.tracer.start('bench.repo.create', { parent: root, attrs: { 'artifacts.repo': name } });
  let made: { readonly remote: string; readonly token: string };
  try {
    made = await deps.repos.create(name);
    await deps.created(name);
    created.ok().end();
  } catch (e) {
    created.error(e).end();
    root.error(e).end();
    return { steps: [], end: null, names: store.byOid, exchanges: [], verdict: fail('seed', `create: ${errText(e)}`), cleanup: NO_CLEANUP, remote: '' };
  }
  const token = made.token;
  const recorder = createRecorder({ upstream: deps.upstream, now: () => Date.now() - t0, scrub: (s: string) => s.split(token).join('[token]'), tracer: deps.tracer, keepBodies: deps.keepBodies });
  const c: Ctx = { store, scenario, recorder, remote: made.remote, token, tracer: deps.tracer };
  const steps: StepObservation[] = [];
  let verdict: RunVerdict = fail('step', 'not run');
  let end: EndState | null = null;
  try {
    const seeded = await seedRepo(c, root);
    if (!seeded.ok) verdict = fail('seed', seeded.error);
    else {
      for (const [i, step] of scenario.steps.entries()) {
        const span = deps.tracer.start('bench.step', { parent: root, attrs: { 'probe.step': i, 'probe.step.kind': step.tag } });
        recorder.setPhase({ tag: 'step', index: i }, span);
        const before = recorder.exchanges.length;
        const o = await runStep(c, i, steps, span);
        const xs = recorder.exchanges.slice(before);
        span.set({ 'probe.outcomes': o.outcomes.map(x => x.outcome).join(','), 'probe.errors': o.outcomes.map(x => String(x.error)).join(','), 'probe.exchanges': xs.length, 'probe.cf_rays': xs.map(x => renderRay(x.cfRay)).join(',') }).end();
        steps.push(o);
      }
      const js = deps.tracer.start('bench.judge', { parent: root });
      recorder.setPhase({ tag: 'judge' }, js);
      const g = client(c, 'judge', js, null);
      const judged = g.ok ? await readEnd(g.value) : err(g.error.detail);
      if (judged.ok) {
        end = judged.value.end;
        js.set({ 'probe.refs': Object.keys(end.refs).length, 'probe.objects': end.objects.length }).ok().end();
        const obs: Observation = { steps, end };
        verdict = verdictOf(scenario, obs, store.byOid, recorder.exchanges);
      } else {
        js.error(new Error(judged.error)).end();
        verdict = fail('judge', judged.error);
      }
    }
  } catch (e) {
    verdict = fail('step', errText(e));
  }
  const cleaned = await cleanup(deps, c, name, root);
  root.set({ 'bench.verdict': verdict.tag, 'bench.exchanges': recorder.exchanges.length, 'bench.cleanup.ok': cleaned.refused && cleaned.deleted && cleaned.gone });
  if (verdict.tag === 'harness') root.error(new Error(verdict.message)); else root.ok();
  root.end();
  return { steps, end, names: store.byOid, exchanges: recorder.exchanges, verdict, cleanup: cleaned, remote: made.remote };
}
