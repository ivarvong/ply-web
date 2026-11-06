// The direct promote (default `npm run cd`): 0% canary → pinned smoke → telemetry → 100% → live watch.
// The watch is runRamp over promotePolicy(policy): one step at 100%, probes deferring to telemetry, polled ingest.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { none, some } from '../src/option.ts'
import { parsePolicy, promotePolicy, type RolloutPolicy } from '../scripts/cd/policy.ts'
import type { ProbeOutcome } from '../scripts/cd/probe.ts'
import { INGEST_LANDED, observeAfterIngest, runRamp, type Observation, type RampIo } from '../scripts/cd/ramp.ts'
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

test('promotePolicy is one 100% step for promote.watchMs, no warm-up, polled ingest, probes deferring to telemetry', () => {
  const base = checked()
  const fast = promotePolicy(base)
  assert.deepEqual(fast.steps, [{ percent: 100, dwellMs: base.promote.watchMs }])
  assert.equal(fast.warmupMs, 0)
  assert.equal(fast.ingestWaitMs, base.promote.ingestWaitMs)
  assert.equal(fast.ingestPollMs, base.promote.ingestPollMs)
  assert.equal(fast.probe.onHarnessFault, 'telemetry')
  // The gates are the checked-in ones: the fast path does not loosen what counts as a regression.
  assert.deepEqual(fast.gates, base.gates)
  assert.deepEqual(fast.burn, base.burn)
  // --ramp keeps the stepped schedule.
  assert.deepEqual(base.steps.map(step => step.percent), [10, 25, 50, 75, 100])
})

test('a clean watch promotes once, calls onApplied at 100%, and completes', async () => {
  const { io: rio, trace } = io(() => window({ requests: 3000 }), probes(3000))
  const result = await runRamp(promotePolicy(checked()), rio)
  assert.equal(result.state.kind, 'complete')
  assert.deepEqual(trace.splits, [100])
  assert.deepEqual(trace.applied, [100])
  assert.equal(trace.rolled, 0)
})

test('a new-version 5xx spike during the live watch rolls back to the previous version', async () => {
  const { io: rio, trace } = io(() => window({ requests: 3000, fivexx: 40, errors: 40 }), probes(3000))
  const result = await runRamp(promotePolicy(checked()), rio)
  assert.equal(result.state.kind, 'rolled-back')
  if (result.state.kind === 'rolled-back') assert.equal(result.state.reason, '40 5xx responses on the new version')
  assert.equal(trace.rolled, 1)
})

test('a new-version exception during the live watch rolls back', async () => {
  const { io: rio, trace } = io(() => window({ requests: 3000, exceptions: 1 }), probes(3000))
  const result = await runRamp(promotePolicy(checked()), rio)
  assert.equal(result.state.kind, 'rolled-back')
  assert.equal(trace.rolled, 1)
})

test('errors on the old version (stragglers while the split propagates) do not fail the new release', async () => {
  // Run 2026-11-06T20-57-44-803Z: "1 5xx response on the old version" rolled back a clean new version.
  const { io: rio, trace } = io(() => window({ requests: 2950 }, { requests: 50, fivexx: 3, exceptions: 1, errorLogs: 2, errors: 3 }), probes(3000))
  const result = await runRamp(promotePolicy(checked()), rio)
  assert.equal(result.state.kind, 'complete')
  assert.equal(trace.rolled, 0)
  assert.match(result.lines.join('\n'), /on the old version/)
})

test('a routed share under 100% at the 100% step is split propagation, not a rollback', () => {
  // Runs 2026-11-06T20-01-37-842Z and 20-11-49-685Z: 98.84% and 98.74% at 100% rolled back clean versions.
  return (async () => {
    const { io: rio, trace } = io(() => window({ requests: 1964 }, { requests: 25 }), probes(2000))
    const result = await runRamp(promotePolicy(checked()), rio)
    assert.equal(result.state.kind, 'complete')
    assert.equal(trace.rolled, 0)
    assert.match(result.lines.join('\n'), /split propagation/)
  })()
})

test('probe-tail loss is a harness artifact: recorded, judged on telemetry, not rolled back', async () => {
  // 10/3000 lost is over the calibrated 1/790, which rolled back the ramp's 100% step.
  const { io: rio, trace } = io(() => window({ requests: 3000 }), probes(2990, 10))
  const result = await runRamp(promotePolicy(checked()), rio)
  assert.equal(result.state.kind, 'complete')
  assert.equal(trace.rolled, 0)
  assert.deepEqual(result.steps.map(step => step.probeLoss.count), [10])
  // Under --ramp the same window is still a harness fault that rolls back.
  const ramp = io(() => window({ requests: 3000 }), probes(2990, 10))
  const stepped = await runRamp({ ...checked(), steps: [{ percent: 100, dwellMs: 1 }] }, ramp.io)
  assert.equal(stepped.state.kind, 'stopped')
})

test('probe-tail loss beside a new-version 5xx still rolls back', async () => {
  const { io: rio, trace } = io(() => window({ requests: 3000, fivexx: 2 }), probes(2990, 10))
  const result = await runRamp(promotePolicy(checked()), rio)
  assert.equal(result.state.kind, 'rolled-back')
  assert.equal(trace.rolled, 1)
})

test('the ingest wait polls: it stops as soon as the probes have landed, not after the ceiling', async () => {
  const policy = promotePolicy(checked())
  const answered = probes(1000)
  let landed = 0
  const clock = { t: 0 }
  const { io: rio, trace } = io(() => {
    landed += 400
    return window({ requests: Math.min(landed, 1000) })
  }, answered, clock)
  const loss = { total: 1000, count: 0, rate: 0, maxLossRate: 0.01, exceeded: false, responded: 1000, serverErrors: 0, ids: [], timedOut: 0, aborted: 0, network: 0, shed: 0 }
  const observed = await observeAfterIngest(policy, rio, 0, 0, 100, loss)
  assert.equal(observed.kind, 'sample')
  if (observed.kind === 'sample') assert.ok(observed.aggregate.invocations >= 1000 * INGEST_LANDED)
  assert.equal(trace.observed, 3)
  assert.deepEqual(trace.slept, [policy.ingestPollMs, policy.ingestPollMs, policy.ingestPollMs])
})

test('the polled ingest wait gives up at the ceiling and judges what landed', async () => {
  const policy = promotePolicy(checked())
  const clock = { t: 0 }
  const { io: rio, trace } = io(() => window({ requests: 10 }), probes(1000), clock)
  const loss = { total: 1000, count: 0, rate: 0, maxLossRate: 0.01, exceeded: false, responded: 1000, serverErrors: 0, ids: [], timedOut: 0, aborted: 0, network: 0, shed: 0 }
  await observeAfterIngest(policy, rio, 0, 0, 100, loss)
  assert.equal(trace.slept.reduce((a, b) => a + b, 0), policy.ingestWaitMs)
  assert.equal(trace.observed, Math.ceil(policy.ingestWaitMs / policy.ingestPollMs))
})

test('without ingestPollMs the ramp keeps its fixed ingest sleep', async () => {
  const policy = { ...checked(), warmupMs: 0, steps: [{ percent: 100, dwellMs: 40 }] }
  const slept: number[] = []
  await runRamp(policy, {
    now: () => 0,
    sleep: async ms => { slept.push(ms) },
    applySplit: async () => null,
    observe: async () => window({ requests: 200 }),
    rollback: async () => null,
  })
  assert.deepEqual(slept, [40, policy.ingestWaitMs])
})
