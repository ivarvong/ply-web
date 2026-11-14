// What a run found, as one value: a pass, or each difference from the stated expectation classified as exactly one of
// client_bug, server_bug, expected_incompatibility or unresolved, carrying the step's outcome and error class as
// ply's own evaluator renders them (ply/probes soloDiffs, allowFor, classify) and the exchanges that decided it.
//
// ply's classify can only say `unresolved` for a one-corner run (stock git and the reference did not run). The
// workbench has one more witness, the wire, read by its own parser (src/bench/wire.ts), so two cases are decided here:
//   client_bug  ply's outcome for a push contradicts the report-status the server sent on that same exchange
//               (an answer that reached ply whole: no response fault applied)
//   server_bug  the server's report-status said a ref was updated, and the refs read back afterwards do not show it
//               (the last update of that ref in the run, so no later write explains it)
// Anything else stays as classify left it; an allow entry ply keeps for the scenario makes it expected_incompatibility.
import { ALLOW, allowFor, classify, soloDiffs, type Difference, type ErrorClass, type Names, type Observation, type Outcome, type Scenario, type StepExpect } from 'ply/probes';
import { renderRay } from '../rays.ts';
import type { Exchange } from './recorder.ts';
import { reportVerdict, type Report } from './wire.ts';

const ZERO = '0'.repeat(40);

export type Evidence = { readonly exchange: number; readonly cfRay: string; readonly says: string };
// The step a difference is about, when it is about one: what ply concluded and what the scenario states.
export type StepAt = { readonly index: number; readonly outcome: Outcome; readonly error: ErrorClass; readonly expected: StepExpect | null };

type Base = { readonly difference: Difference; readonly step: StepAt | null; readonly evidence: readonly Evidence[] };
export type Failure =
  | (Base & { readonly tag: 'client_bug'; readonly why: string })
  | (Base & { readonly tag: 'server_bug'; readonly why: string })
  | (Base & { readonly tag: 'expected_incompatibility'; readonly reason: string })
  | (Base & { readonly tag: 'unresolved'; readonly why: string });
export type FailureTag = Failure['tag'];
export const FAILURE_TAGS: readonly FailureTag[] = ['client_bug', 'server_bug', 'expected_incompatibility', 'unresolved'];

export type RunVerdict =
  | { readonly tag: 'pass'; readonly compared: number }
  | { readonly tag: 'fail'; readonly failures: readonly [Failure, ...Failure[]] }
  // the run could not observe the scenario (a seed push refused, a judge read failed): nothing to classify
  | { readonly tag: 'harness'; readonly stage: 'seed' | 'step' | 'judge'; readonly message: string };

const ev = (x: Exchange, says: string): Evidence => ({ exchange: x.i, cfRay: renderRay(x.cfRay), says });
const responseFault = (x: Exchange): boolean => x.applied !== null && x.applied.tag !== 'race' && x.applied.tag !== 'stall-request';
const reportText = (r: Report): string => {
  if (r.tag === 'none') return `no report-status (${r.why})`;
  const refs = r.refs.map(s => (s.tag === 'ok' ? `ok ${s.ref}` : `ng ${s.ref} ${s.reason}`)).join('; ');
  return `unpack ${r.unpack.tag === 'ok' ? 'ok' : `error ${r.unpack.reason}`}; ${refs}`;
};

// The outcome the server's own report-status implies for ply's classes, or null when it implies none (no report).
export function reportOutcome(r: Report): Outcome | null {
  switch (reportVerdict(r)) {
    case 'all-ok': return 'landed';
    case 'some-ok': return 'partial';
    case 'none-ok': return null; // conflict or rejected: the reason decides, ply's classifier reads it
    case 'no-report': return null;
  }
}

// Exchanges of a step on the main channel that carried a receive-pack answer ply read whole.
const stepPushes = (xs: readonly Exchange[], step: number): Exchange[] => xs.filter(x => x.channel === 'main' && x.phase.tag === 'step' && x.phase.index === step && x.wire.tag === 'receive-pack' && x.answer.tag === 'http' && x.answer.status === 200 && !responseFault(x));

function clientContradiction(s: Scenario, obs: Observation, xs: readonly Exchange[], step: number): Evidence[] {
  const st = s.steps[step];
  const seen = obs.steps[step];
  if (typeof st !== 'object' || typeof seen !== 'object' || st.tag !== 'push') return [];
  const first = seen.outcomes[0];
  const out: Evidence[] = [];
  for (const x of stepPushes(xs, step)) {
    if (x.wire.tag !== 'receive-pack') continue;
    const implied = reportOutcome(x.wire.report);
    const v = reportVerdict(x.wire.report);
    if (implied !== null && implied !== first.outcome) out.push(ev(x, `the server reported ${reportText(x.wire.report)}; ply concluded ${first.outcome}`));
    if (v === 'none-ok' && first.outcome === 'landed') out.push(ev(x, `the server refused every command (${reportText(x.wire.report)}); ply concluded landed`));
  }
  return out;
}

// The server said ok for ref R at new id X in the last write of R the run made, and the end state disagrees.
function serverContradiction(obs: Observation, xs: readonly Exchange[]): Evidence[] {
  const last = new Map<string, { readonly x: Exchange; readonly to: string }>();
  for (const x of xs) {
    if (x.wire.tag !== 'receive-pack' || x.phase.tag === 'judge' || x.phase.tag === 'cleanup') continue;
    const report = x.wire.report;
    for (const c of x.wire.request.commands) {
      const okd = report.tag === 'report' && report.refs.some(r => r.tag === 'ok' && r.ref === c.ref);
      // a write the server did not confirm makes the ref's end state unknown to the wire: forget the earlier one
      if (okd && x.answer.tag === 'http') last.set(c.ref, { x, to: String(c.new) }); else last.delete(c.ref);
    }
  }
  const out: Evidence[] = [];
  for (const [ref, { x, to }] of last) {
    const held = Object.hasOwn(obs.end.refs, ref) ? String(obs.end.refs[ref]) : ZERO;
    if (held !== to) out.push(ev(x, `the server reported ok ${ref} -> ${to === ZERO ? '(deleted)' : to}; the refs read back hold ${held === ZERO ? '(absent)' : held}`));
  }
  return out;
}

// The first step whose outcome (or error) is not the stated one: a concurrent step by its sorted outcomes.
const stepOf = (d: Difference, s: Scenario, obs: Observation): StepAt | null => {
  if (d.field !== 'outcome' && d.field !== 'error') return null;
  for (const [i, e] of s.expect.entries()) {
    const seen = obs.steps[i];
    if (typeof seen !== 'object') continue;
    const o = seen.outcomes[0];
    if (e.tag === 'one' && (e.ply.outcome !== o.outcome || e.ply.error !== o.error)) return { index: i, outcome: o.outcome, error: o.error, expected: e.ply };
    if (e.tag === 'many' && [...e.ply].sort().join(',') !== seen.outcomes.map(x => x.outcome).sort().join(',')) return { index: i, outcome: o.outcome, error: o.error, expected: null };
  }
  return null;
};

export function verdictOf(s: Scenario, obs: Observation, names: Names, xs: readonly Exchange[]): RunVerdict {
  const diffs = soloDiffs(s, obs, names);
  const serverSide = serverContradiction(obs, xs);
  const failures: Failure[] = diffs.map(d => {
    const step = stepOf(d, s, obs);
    const allowed = allowFor(ALLOW, d);
    if (allowed.tag === 'some') return { tag: 'expected_incompatibility', difference: d, step, evidence: [], reason: allowed.value.reason };
    // a step difference is checked on its own step; an end-state or claim difference on every step
    const client = step === null ? (d.field === 'expectation' || d.field === 'claims' ? s.steps.flatMap((_, i) => clientContradiction(s, obs, xs, i)) : []) : clientContradiction(s, obs, xs, step.index);
    if (client.length > 0) return { tag: 'client_bug', difference: d, step, evidence: client, why: 'ply\'s outcome contradicts the report-status the server sent on the same exchange' };
    if ((d.field === 'expectation' || d.field === 'claims') && serverSide.length > 0) return { tag: 'server_bug', difference: d, step, evidence: serverSide, why: 'the server confirmed an update its refs do not hold' };
    const c = classify(s, d, diffs);
    const pushes = step === null ? [] : stepPushes(xs, step.index).map(x => ev(x, x.wire.tag === 'receive-pack' ? reportText(x.wire.report) : ''));
    switch (c.class) {
      case 'client-bug': return { tag: 'client_bug', difference: d, step, evidence: pushes, why: c.why };
      case 'server-bug': return { tag: 'server_bug', difference: d, step, evidence: pushes, why: c.why };
      case 'unresolved': return { tag: 'unresolved', difference: d, step, evidence: pushes, why: c.why };
    }
  });
  const [first, ...rest] = failures;
  return typeof first === 'object' ? { tag: 'fail', failures: [first, ...rest] } : { tag: 'pass', compared: s.expect.length };
}
