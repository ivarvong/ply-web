// Ramp-only (Ivar, 2026-11-08: "Ramp should be the only option."): 0% canary → pinned smoke → telemetry → the stepped
// ramp in cd.policy.json → live checks during the 100% step. The direct promote (one write to 100%) is gone; every
// judgement fix made for it is checked here under the checked-in ramp.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { none, some } from '../src/option.ts'
import { parsePolicy, type RolloutPolicy } from '../scripts/cd/policy.ts'
import { liveVerdict } from '../scripts/cd/pipeline-plan.ts'
import { planCanary } from '../scripts/cd/deploy-plan.ts'
import type { ProbeOutcome } from '../scripts/cd/probe.ts'
import { ALL_INVOCATIONS, INGEST_LANDED, observeAfterIngest, runRamp, type Observation, type RampIo } from '../scripts/cd/ramp.ts'
import type { VersionStats } from '../scripts/cd/telemetry.ts'

function checked(): RolloutPolicy {
  return parsePolicy(readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')).policy
}

function stats(over: Partial<VersionStats> = {}): VersionStats {
  const row: VersionStats = {
    requests: 0,
    invocations: 0,
    exceptions: 0,
    errors: 0,
    fivexx: 0,
    errorLogs: 0,
    wallMs: [],
    cpuMs: [],
    fetchMs: [],
    v1: [],
    internal: [],
    ...over,
  }
  return { ...row, invocations: 'invocations' in over ? Number(over.invocations) : row.requests }
}

function window(next: Partial<VersionStats>, previous: Partial<VersionStats> = {}): Observation {
  const newer = stats({ wallMs: [10, 10, 10], ...next })
  const older = stats(previous)
  return {
    kind: 'sample',
    next: newer,
    previous: older,
    aggregate: stats({
      requests: newer.requests + older.requests,
      invocations: newer.invocations + older.invocations,
      exceptions: newer.exceptions + older.exceptions,
      errors: newer.errors + older.errors,
      fivexx: newer.fivexx + older.fivexx,
      errorLogs: newer.errorLogs + older.errorLogs,
      wallMs: [...newer.wallMs, ...older.wallMs],
    }),
    landed: newer.invocations + older.invocations,
  }
}

function probes(ok: number, lost = 0): ProbeOutcome[] {
  const out: ProbeOutcome[] = []
  for (let i = 0; i < ok; i++) out.push({ kind: 'responded', id: `ok-${i}`, status: 200, ray: none(), latencyMs: 40, version: some('new') })
  for (let i = 0; i < lost; i++) out.push({ kind: 'lost', id: `lost-${i}`, reason: 'aborted' })
  return out
}

type Trace = { splits: number[]; rolled: number; applied: number[]; observed: number; slept: number[] }

function io(observe: () => Observation, outcomes: ProbeOutcome[], clock = { t: 0 }): { io: RampIo; trace: Trace } {
  const trace: Trace = { splits: [], rolled: 0, applied: [], observed: 0, slept: [] }
  return {
    trace,
    io: {
      now: () => clock.t,
      sleep: async ms => { trace.slept.push(ms); clock.t += ms },
      dwell: async ms => { clock.t += ms; return { outcomes } },
      applySplit: async percent => { trace.splits.push(percent); return null },
      onApplied: percent => { trace.applied.push(percent) },
      observe: async () => { trace.observed += 1; return observe() },
      rollback: async () => { trace.rolled += 1; return null },
    },
  }
}


function raw(): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')) as Record<string, unknown>
}

/** A window whose split matches `percent` of `total`, with optional extras on either side. */
function at(percent: number, total: number, next: Partial<VersionStats> = {}, previous: Partial<VersionStats> = {}): Observation {
  const newer = Math.round(total * percent / 100)
  return window({ requests: newer, ...next }, { requests: total - newer, ...previous })
}

test('the checked-in policy ramps: more than one step, the last 100, probe loss deferred to telemetry, ingest polled', () => {
  const policy = checked()
  assert.ok(policy.steps.length >= 2)
  const percents = policy.steps.map(step => step.percent)
  assert.equal(percents[percents.length - 1], 100)
  assert.ok(Number(percents[0]) < 100)
  assert.equal(policy.probe.onHarnessFault, 'telemetry')
  assert.ok(policy.ingestPollMs > 0)
  assert.equal('promote' in policy, false)
})

test('the policy engine rejects a policy that does not ramp', () => {
  const single = { ...raw(), steps: [{ percent: 100, dwellMs: 60000 }] }
  assert.throws(() => parsePolicy(JSON.stringify(single)), /steps: must ramp/)
  const empty = { ...raw(), steps: [] }
  assert.throws(() => parsePolicy(JSON.stringify(empty)), /steps: must be a non-empty list/)
  const missing = raw()
  delete missing.steps
  assert.throws(() => parsePolicy(JSON.stringify(missing)), /steps/)
  const zero = { ...raw(), steps: [{ percent: 0, dwellMs: 1 }, { percent: 100, dwellMs: 1 }] }
  assert.throws(() => parsePolicy(JSON.stringify(zero)), /steps\[0\]\.percent/)
  const promote = { ...raw(), promote: { watchMs: 60000, ingestWaitMs: 30000, ingestPollMs: 3000 } }
  assert.throws(() => parsePolicy(JSON.stringify(promote)), /promote: was removed 2026-11-08/)
  // Two steps is the least that ramps.
  const two = { ...raw(), steps: [{ percent: 50, dwellMs: 1 }, { percent: 100, dwellMs: 1 }] }
  assert.deepEqual(parsePolicy(JSON.stringify(two)).policy.steps.map(step => step.percent), [50, 100])
})

test('a clean ramp writes every step in order, calls onApplied per step, and completes', async () => {
  const policy = checked()
  let percent = 0
  const { io: rio, trace } = io(() => at(percent, 2000), probes(2000))
  const apply = rio.applySplit
  rio.applySplit = async p => { percent = p; return apply(p) }
  const result = await runRamp(policy, rio)
  assert.equal(result.state.kind, 'complete')
  assert.deepEqual(trace.splits, policy.steps.map(step => step.percent))
  assert.deepEqual(trace.applied, policy.steps.map(step => step.percent))
  assert.equal(trace.rolled, 0)
})

test('a new-version 5xx rolls back at the first step and at the 100% step (the live watch)', async () => {
  const policy = checked()
  for (const bad of [Number(policy.steps.map(step => step.percent)[0]), 100]) {
    let percent = 0
    const { io: rio, trace } = io(() => at(percent, 2000, percent === bad ? { fivexx: 3, errors: 3 } : {}), probes(2000))
    const apply = rio.applySplit
    rio.applySplit = async p => { percent = p; return apply(p) }
    const result = await runRamp(policy, rio)
    assert.equal(result.state.kind, 'rolled-back', `5xx at ${bad}%`)
    if (result.state.kind === 'rolled-back') assert.equal(result.state.reason, '3 5xx responses on the new version')
    assert.equal(trace.rolled, 1)
    assert.equal(trace.splits[trace.splits.length - 1], bad)
  }
})

test('a new-version exception mid-ramp rolls back', async () => {
  let percent = 0
  const { io: rio, trace } = io(() => at(percent, 2000, percent === 50 ? { exceptions: 1 } : {}), probes(2000))
  const apply = rio.applySplit
  rio.applySplit = async p => { percent = p; return apply(p) }
  const result = await runRamp(checked(), rio)
  assert.equal(result.state.kind, 'rolled-back')
  assert.equal(trace.rolled, 1)
})

test('old-version errors do not fail the new release at any step', async () => {
  // Run 2026-11-06T20-57-44-803Z: "1 5xx response on the old version" rolled back a clean new version.
  let percent = 0
  const { io: rio, trace } = io(() => at(percent, 2000, {}, percent < 100 ? { fivexx: 3, exceptions: 1, errorLogs: 2, errors: 3 } : {}), probes(2000))
  const apply = rio.applySplit
  rio.applySplit = async p => { percent = p; return apply(p) }
  const result = await runRamp(checked(), rio)
  assert.equal(result.state.kind, 'complete')
  assert.equal(trace.rolled, 0)
  assert.match(result.lines.join('\n'), /on the old version/)
})

test('old-version stragglers at the 100% step are split propagation, informational', async () => {
  // Runs 2026-11-06T20-01-37-842Z and 20-11-49-685Z: 98.84% and 98.74% at 100% rolled back clean versions.
  let percent = 0
  const { io: rio, trace } = io(() => percent === 100 ? window({ requests: 1964 }, { requests: 25, fivexx: 1, errors: 1 }) : at(percent, 2000), probes(2000))
  const apply = rio.applySplit
  rio.applySplit = async p => { percent = p; return apply(p) }
  const result = await runRamp(checked(), rio)
  assert.equal(result.state.kind, 'complete')
  assert.equal(trace.rolled, 0)
  assert.match(result.lines.join('\n'), /split propagation/)
})

test('probe-tail loss is the harness under the ramp: recorded, judged on telemetry, not rolled back', async () => {
  // Runs 2026-11-06T17-32-11-293Z (6/2000) and 18-44-58-475Z (5/2000) rolled back clean versions on this alone.
  let percent = 0
  const { io: rio, trace } = io(() => at(percent, 2000), probes(1990, 10))
  const apply = rio.applySplit
  rio.applySplit = async p => { percent = p; return apply(p) }
  const result = await runRamp(checked(), rio)
  assert.equal(result.state.kind, 'complete')
  assert.equal(trace.rolled, 0)
  assert.ok(result.steps.every(step => step.probeLoss.count === 10))
  // With onHarnessFault rollback (the pre-2026-11-08 file) the same window stopped the ramp.
  const strict = { ...checked(), probe: { ...checked().probe, onHarnessFault: 'rollback' as const } }
  const old = io(() => at(10, 2000), probes(1990, 10))
  assert.equal((await runRamp(strict, old.io)).state.kind, 'stopped')
})

test('probe-tail loss beside a new-version 5xx still rolls back', async () => {
  const { io: rio, trace } = io(() => at(10, 2000, { fivexx: 2, errors: 2 }), probes(1990, 10))
  const result = await runRamp(checked(), rio)
  assert.equal(result.state.kind, 'rolled-back')
  assert.equal(trace.rolled, 1)
})

test('a lost telemetry query with no probe sample is a harness fault, distinct from a rollback for cause', async () => {
  const policy = { ...checked(), probe: { ...checked().probe, rps: 0 } }
  const trace = { rolled: 0 }
  const result = await runRamp(policy, {
    now: () => 0,
    sleep: async () => {},
    applySplit: async () => null,
    observe: async () => ({ kind: 'unavailable', reason: 'telemetry unavailable: timeout' }),
    rollback: async () => { trace.rolled += 1; return null },
  })
  assert.equal(result.state.kind, 'stopped')
  if (result.state.kind === 'stopped') assert.equal(result.state.fault, 'harness_fault')
  // Above 0% nothing is left to judge, so traffic goes back to previous, but the verdict stays harness_fault.
  assert.equal(trace.rolled, 1)
})

test('live checks at 100%: a Worker failure (smoke, telemetry, the rate gate, visual) rolls back; a harness fault alone halts', () => {
  assert.equal(liveVerdict([{ kind: 'pass' }, { kind: 'pass' }, { kind: 'pass' }]), 'done')
  // stageTelemetry returns a worker fail for a rate-gate degradation (mode, fail_open, dropped flushes) on the live window.
  assert.equal(liveVerdict([{ kind: 'pass' }, { kind: 'fail', fault: 'worker' }, { kind: 'pass' }]), 'rollback')
  // Too few rate checks ingested, no Chrome, a lost query: unevaluable, not evidence against the version.
  assert.equal(liveVerdict([{ kind: 'pass' }, { kind: 'fail', fault: 'harness_fault' }]), 'halt')
  assert.equal(liveVerdict([{ kind: 'fail', fault: 'harness_fault' }, { kind: 'fail', fault: 'worker' }]), 'rollback')
})

test('the polled ingest wait stops as soon as the probes have landed, and gives up at the ceiling', async () => {
  const policy = checked()
  const loss = { total: 1000, count: 0, rate: 0, maxLossRate: 0.01, exceeded: false, responded: 1000, serverErrors: 0, ids: [], timedOut: 0, aborted: 0, network: 0, shed: 0, stalled: 0 }
  let landed = 0
  const fast = io(() => { landed += 400; return window({ requests: Math.min(landed, 1000) }) }, probes(1000))
  const observed = await observeAfterIngest(policy, fast.io, 0, 0, 100, loss, ALL_INVOCATIONS)
  assert.equal(observed.kind, 'sample')
  if (observed.kind === 'sample') assert.ok(observed.aggregate.invocations >= 1000 * INGEST_LANDED)
  assert.equal(fast.trace.observed, 3)
  const slow = io(() => window({ requests: 10 }), probes(1000))
  await observeAfterIngest(policy, slow.io, 0, 0, 100, loss, ALL_INVOCATIONS)
  assert.equal(slow.trace.slept.reduce((a, b) => a + b, 0), policy.ingestWaitMs)
})

test('deploy-canary refuses a 0% version it did not create unless --replace-canary names it', () => {
  const live = '11111111-1111-4111-8111-111111111111'
  const foreign = 'b494b751-0000-4000-8000-000000000000'
  const next = '22222222-2222-4222-8222-222222222222'
  const split = [{ versionId: live, percentage: 100 }, { versionId: foreign, percentage: 0 }]
  const refused = planCanary(split, next)
  assert.equal(refused.kind, 'conflict')
  if (refused.kind === 'conflict') assert.match(refused.reason, /--replace-canary b494b751-0000-4000-8000-000000000000/)
  assert.equal(planCanary(split, next, '33333333-3333-4333-8333-333333333333').kind, 'conflict')
  assert.deepEqual(planCanary(split, next, foreign), { kind: 'ok', live, dropped: foreign })
  // Our own version already at 0% (a resumed release) is not a replacement.
  assert.deepEqual(planCanary([{ versionId: live, percentage: 100 }, { versionId: next, percentage: 0 }], next), { kind: 'ok', live, dropped: null })
  assert.deepEqual(planCanary([{ versionId: live, percentage: 100 }], next), { kind: 'ok', live, dropped: null })
})
