import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { none } from '../src/option.ts'
import { parsePolicy, type RolloutPolicy } from '../scripts/cd/policy.ts'
import type { ProbeOutcome } from '../scripts/cd/probe.ts'
import { applyRamp, decideRampStep, progressLine, rampStart, runRamp, type Observation } from '../scripts/cd/ramp.ts'
import type { VersionStats } from '../scripts/cd/telemetry.ts'
import { routedShare } from '../scripts/cd/slo.ts'

function policy(steps?: { percent: number; dwellMs: number }[], warmupMs = 0): RolloutPolicy {
  const raw = JSON.parse(readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')) as {
    steps: { percent: number; dwellMs: number }[]
    warmupMs: number
  }
  if (steps) raw.steps = steps
  raw.warmupMs = warmupMs
  return parsePolicy(JSON.stringify(raw)).policy
}

function stats(over: Partial<VersionStats> = {}): VersionStats {
  const row: VersionStats = {
    requests: 20,
    invocations: 0,
    exceptions: 0,
    errors: 0,
    fivexx: 0,
    errorLogs: 0,
    wallMs: [80, 90, 100, 110, 120],
    cpuMs: [10, 12, 14],
    fetchMs: [40, 50, 60],
    v1: [],
    internal: [],
    ...over,
  }
  return { ...row, invocations: over.invocations ?? row.requests }
}

function sample(next: Partial<VersionStats> = {}, previous: Partial<VersionStats> = {}): Observation {
  const newer = stats(next)
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
      cpuMs: [...newer.cpuMs, ...older.cpuMs],
      fetchMs: [...newer.fetchMs, ...older.fetchMs],
      v1: [...newer.v1, ...older.v1],
    }),
  }
}

function atPercent(percent: number): Observation {
  if (percent >= 100) {
    return sample(
      { requests: 200, invocations: 200, wallMs: [10, 10, 10, 10, 10] },
      { requests: 0, invocations: 0, wallMs: [], cpuMs: [], fetchMs: [] },
    )
  }
  return sample(
    { requests: 200, invocations: 200, wallMs: [10, 10, 10, 10, 10] },
    { requests: 200, invocations: 200, wallMs: [10, 10, 10, 10, 10] },
  )
}

const twoSteps = policy([{ percent: 50, dwellMs: 1 }, { percent: 100, dwellMs: 1 }])

test('a short clean sample is insufficient evidence and holds', () => {
  const decision = decideRampStep(
    sample({ requests: 2, invocations: 2, wallMs: [80, 81] }, { requests: 3, invocations: 3, wallMs: [70, 71, 72] }),
    twoSteps,
    50,
  )
  assert.equal(decision.outcome, 'insufficient_data')
  assert.equal(applyRamp(rampStart(), decision, 5).kind, 'held')
  const ready = decideRampStep(atPercent(50), twoSteps, 50)
  assert.equal(ready.outcome, 'advance')
  assert.deepEqual(applyRamp(rampStart(), ready, 5), { kind: 'ramping', step: 1 })
  assert.equal(applyRamp({ kind: 'ramping', step: 4 }, ready, 5).kind, 'complete')
})

test('unavailable telemetry above 0% is a harness fault and rolls back to previous', async () => {
  const decision = decideRampStep({ kind: 'unavailable', reason: 'telemetry unavailable: cf o11y down' }, twoSteps, 50)
  assert.equal(decision.outcome, 'harness_fault')
  assert.match(decision.reason, /telemetry unavailable/)
  assert.equal(decision.rules[0]?.name, 'telemetry_required')
  let rolled = 0
  const result = await runRamp(twoSteps, {
    now: () => 0,
    sleep: async () => {},
    applySplit: async () => null,
    observe: async () => ({ kind: 'unavailable', reason: 'telemetry unavailable: cf o11y down' }),
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.equal(result.state.kind, 'stopped')
  if (result.state.kind === 'stopped' && result.state.fault === 'harness_fault') assert.equal(result.state.traffic, 'rolled_back')
  assert.equal(rolled, 1)
  assert.match(result.lines[0] ?? '', /decision=harness_fault/)
})

test('one exception on the new version rolls back before the sample minimum', () => {
  const decision = decideRampStep(sample({ requests: 1, invocations: 1, exceptions: 1, errors: 1, wallMs: [40] }, { requests: 40, invocations: 40 }), twoSteps, 50)
  assert.equal(decision.outcome, 'rollback')
  assert.equal(decision.reason, '1 exception on the new version')
})

test('a large wall shift stays an advance under the checked-in policy', () => {
  const over = decideRampStep(sample(
    { requests: 200, invocations: 200, wallMs: [210, 210, 210, 210, 210, 210] },
    { requests: 200, invocations: 200, wallMs: [80, 80, 80, 80, 80, 80] },
  ), twoSteps, 50)
  assert.equal(over.outcome, 'advance')
})

test('a routed share outside the band rolls back', () => {
  const decision = decideRampStep(sample(
    { requests: 1000, invocations: 1000 },
    { requests: 1000, invocations: 1000 },
  ), twoSteps, 10)
  assert.equal(decision.outcome, 'rollback')
  assert.equal(decision.rules[0]?.name, 'routed_share')
})

test('applyRamp ignores decisions after rollback', () => {
  const rolled = { kind: 'rolled-back' as const, reason: 'breach' }
  assert.equal(applyRamp(rolled, decideRampStep(atPercent(50), twoSteps, 50), 5), rolled)
})

test('progress line labels latency informational and names a carried baseline', () => {
  const share = routedShare(200, 400, 50, 3)
  const advance = {
    outcome: 'advance' as const,
    reason: 'within burn 14.4',
    rules: [{ name: 'fast_burn' as const, value: 14.4 }] as [{ name: string; value: number }],
    burns: { availability: null, read_latency: null, write_latency: null, correctness: null },
  }
  const line = progressLine({
    step: 1,
    steps: 5,
    percent: 50,
    next: stats({ requests: 200, invocations: 200, wallMs: [88] }),
    previous: stats({ requests: 200, invocations: 200, wallMs: [74] }),
    carriedPrevious: null,
    share,
    decision: advance,
    latency: 'informational',
    probe: { kind: 'none' },
  })
  assert.match(line, /^ramp step=1\/5 percent=50 previous=50 /)
  assert.match(line, /routed_share=50.00 target=50 tolerance=42.50..57.50 agg=400/)
  assert.match(line, /latency=informational/)
  assert.match(line, /decision=advance/)
  const carried = progressLine({
    step: 5,
    steps: 5,
    percent: 100,
    next: stats({ requests: 120, invocations: 120, wallMs: [114, 114, 114, 114, 114] }),
    previous: stats({ requests: 0, invocations: 0, wallMs: [], cpuMs: [], fetchMs: [] }),
    carriedPrevious: stats({ requests: 28, invocations: 28, wallMs: [84, 84, 84, 84, 84] }),
    share: routedShare(120, 120, 100, 3),
    decision: advance,
    latency: 'informational',
    probe: { kind: 'none' },
  })
  assert.equal(
    carried,
    'ramp step=5/5 percent=100 previous=0 samples=120/0 error_rate=0.0000/- routed_share=100.00 target=100 tolerance=100.00..100.00 agg=120 p99_wall_ms=114/84 p99_cpu_ms=12/12 latency=informational decision=advance previous_sample=carried',
  )
})

test('at 100% the old side is the last wall sample that met the quantile floor', async () => {
  const enough = stats({ requests: 100, invocations: 100, wallMs: [84, 84, 84, 84, 84] })
  const quiet = stats({ requests: 0, invocations: 0, wallMs: [], cpuMs: [], fetchMs: [] })
  let step = 0
  const result = await runRamp(twoSteps, {
    now: () => 0,
    sleep: async () => {},
    applySplit: async () => null,
    observe: async () => {
      step += 1
      if (step === 1) return sample({ requests: 100, invocations: 100, wallMs: [80, 80, 80, 80, 80] }, enough)
      return sample({ requests: 100, invocations: 100, wallMs: [90, 90, 90, 90, 90] }, quiet)
    },
    rollback: async () => null,
  })
  assert.equal(result.state.kind, 'complete')
  assert.match(result.lines[1] ?? '', /previous_sample=carried/)
  assert.match(result.lines[1] ?? '', /samples=100\/0/)
  assert.match(result.lines[1] ?? '', /p99_wall_ms=90\/84/)
})

test('a harness fault during the dwell rolls back and records the loss', async () => {
  let rolled = 0
  let observed = 0
  const result = await runRamp(policy([{ percent: 100, dwellMs: 1 }]), {
    now: () => 0,
    sleep: async () => {},
    dwell: async () => {
      const outcomes: ProbeOutcome[] = []
      for (let index = 0; index < 998; index += 1) {
        outcomes.push({ kind: 'responded', id: `ok-${index}`, status: 200, ray: none(), latencyMs: 50, version: none() })
      }
      outcomes.push({ kind: 'lost', id: '1 GET https://ply.ivar.workers.dev/', reason: 'aborted' })
      outcomes.push({ kind: 'lost', id: '2 GET https://ply.ivar.workers.dev/', reason: 'aborted' })
      return { outcomes }
    },
    applySplit: async () => null,
    observe: async () => {
      observed += 1
      return sample()
    },
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.equal(result.state.kind, 'stopped')
  if (result.state.kind === 'stopped' && result.state.fault === 'harness_fault') {
    assert.equal(result.state.traffic, 'rolled_back')
    assert.match(result.state.reason, /probe loss 2\/1000/)
  }
  assert.equal(rolled, 1)
  assert.equal(observed, 0)
  const recorded = result.steps[0]
  if (!recorded) throw new Error('missing probe step')
  assert.equal(recorded.probeLoss.ids[0], '1 GET https://ply.ivar.workers.dev/')
  const recordedLine = result.lines[0]
  if (!recordedLine) throw new Error('missing probe line')
  assert.match(recordedLine, /probe_loss=2\/1000/)
  assert.match(recordedLine, /timed_out=0/)
  assert.match(recordedLine, /shed=0/)
})

test('a state conflict stops and does not roll back', async () => {
  let rolled = 0
  const result = await runRamp(twoSteps, {
    now: () => 0,
    sleep: async () => {},
    applySplit: async () => ({ kind: 'state_conflict', reason: 'deployment does not match the expected prior state' }),
    observe: async () => sample(),
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.deepEqual(result.state, {
    kind: 'stopped',
    reason: 'deployment does not match the expected prior state',
    fault: 'state_conflict',
  })
  assert.equal(rolled, 0)
})

test('the ramp waits out the policy ingest lag, and a warm-up, before it reads the step', async () => {
  const slept: number[] = []
  const result = await runRamp(policy([{ percent: 100, dwellMs: 40 }]), {
    now: () => 0,
    sleep: async ms => { slept.push(ms) },
    applySplit: async () => null,
    observe: async () => atPercent(100),
    rollback: async () => null,
  })
  assert.equal(result.state.kind, 'complete')
  assert.deepEqual(slept, [40, 20_000])
  const warmed: number[] = []
  await runRamp(policy([{ percent: 100, dwellMs: 40 }], 5_000), {
    now: () => 0,
    sleep: async ms => { warmed.push(ms) },
    applySplit: async () => null,
    observe: async () => atPercent(100),
    rollback: async () => null,
  })
  assert.deepEqual(warmed, [5_000, 40, 20_000])
})

test('a decision callback without an observation ref throws', async () => {
  await assert.rejects(runRamp(
    policy([{ percent: 100, dwellMs: 1 }]),
    {
      now: () => 0,
      sleep: async () => {},
      applySplit: async () => null,
      observe: async () => sample({ requests: 200, invocations: 200 }),
      onDecision: async () => {},
      rollback: async () => null,
    },
  ))
})
