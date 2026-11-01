import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parsePolicy, type RolloutPolicy } from '../scripts/cd/policy.ts'
import { applyRamp, decideRampStep, progressLine, rampStart, runRamp, type Observation } from '../scripts/cd/ramp.ts'
import type { VersionStats } from '../scripts/cd/telemetry.ts'
import { MIN_SAMPLES } from '../scripts/cd/slo.ts'

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
  return {
    requests: 20,
    exceptions: 0,
    errors: 0,
    fivexx: 0,
    errorLogs: 0,
    wallMs: [80, 90, 100, 110, 120],
    cpuMs: [10, 12, 14],
    fetchMs: [40, 50, 60],
    v1: [],
    ...over,
  }
}

function sample(next: Partial<VersionStats> = {}, previous: Partial<VersionStats> = {}): Observation {
  return { kind: 'sample', next: stats(next), previous: stats(previous) }
}

const twoSteps = policy([{ percent: 50, dwellMs: 1 }, { percent: 100, dwellMs: 1 }])

test('a short clean sample advances', () => {
  const decision = decideRampStep(sample({ requests: 2, wallMs: [80, 81] }, { requests: 3, wallMs: [70, 71, 72] }), twoSteps)
  assert.equal(decision.outcome, 'advance')
  const start = rampStart()
  const next = applyRamp(start, decision, 7)
  assert.deepEqual(next, { kind: 'ramping', step: 1 })
  const last = applyRamp({ kind: 'ramping', step: 6 }, decision, 7)
  assert.equal(last.kind, 'complete')
})

test('unavailable telemetry is a harness fault and does not roll back', async () => {
  const decision = decideRampStep({ kind: 'unavailable', reason: 'telemetry unavailable: cf o11y down' }, twoSteps)
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
  if (result.state.kind === 'stopped') assert.equal(result.state.fault, 'harness_fault')
  assert.equal(rolled, 0)
  assert.match(result.lines[0] ?? '', /decision=harness_fault/)
})

test('one exception on the new version rolls back before the sample minimum', () => {
  const decision = decideRampStep(sample({ requests: 1, exceptions: 1, errors: 1, wallMs: [40] }, { requests: 40 }), twoSteps)
  assert.equal(decision.outcome, 'rollback')
  assert.equal(decision.reason, '1 exception on the new version')
})

test('a large wall shift stays an advance under the checked-in policy', () => {
  const over = decideRampStep(sample({ wallMs: [210, 210, 210, 210, 210, 210] }, { wallMs: [80, 80, 80, 80, 80, 80] }), twoSteps)
  assert.equal(over.outcome, 'advance')
})

test('applyRamp ignores decisions after rollback', () => {
  const rolled = { kind: 'rolled-back' as const, reason: 'breach' }
  assert.equal(applyRamp(rolled, decideRampStep(sample(), twoSteps), 7), rolled)
})

test('progress line labels latency informational and names a carried baseline', () => {
  const line = progressLine({
    step: 1,
    steps: 7,
    percent: 1,
    next: stats({ requests: 3, wallMs: [88] }),
    previous: stats({ requests: 4, wallMs: [74] }),
    decision: decideRampStep(sample({ requests: 3, wallMs: [88, 88, 88] }, { requests: 4, wallMs: [74, 74, 74, 74] }), twoSteps),
    latency: 'informational',
  })
  assert.match(line, /^ramp step=1\/7 percent=1 previous=99 /)
  assert.match(line, /latency=informational/)
  assert.match(line, /decision=advance/)
  const carried = progressLine({
    step: 7,
    steps: 7,
    percent: 100,
    next: stats({ requests: 120, wallMs: [114, 114, 114, 114, 114] }),
    previous: stats({ requests: 28, wallMs: [84, 84, 84, 84, 84] }),
    decision: { outcome: 'advance', reason: 'ok', rules: [{ name: 'fast_burn', value: 14.4 }], burns: { availability: null, read_latency: null, write_latency: null, correctness: null } },
    latency: 'informational',
    carried: true,
  })
  assert.equal(
    carried,
    'ramp step=7/7 percent=100 previous=0 samples=120/28 error_rate=0.0000/0.0000 p99_wall_ms=114/84 p99_cpu_ms=12/12 latency=informational decision=advance previous_sample=carried',
  )
})

test('at 100% the old side is the last wall sample that met the quantile floor', async () => {
  const enough = stats({ requests: 8, wallMs: [84, 84, 84, 84, 84] })
  const quiet = stats({ requests: 0, wallMs: [], cpuMs: [], fetchMs: [] })
  let step = 0
  const result = await runRamp(twoSteps, {
    now: () => 0,
    sleep: async () => {},
    applySplit: async () => null,
    observe: async () => {
      step += 1
      if (step === 1) return { kind: 'sample', next: stats({ requests: 8, wallMs: [80, 80, 80, 80, 80] }), previous: enough }
      return { kind: 'sample', next: stats({ requests: 8, wallMs: [90, 90, 90, 90, 90] }), previous: quiet }
    },
    rollback: async () => null,
  })
  assert.equal(result.state.kind, 'complete')
  assert.match(result.lines[1] ?? '', /previous_sample=carried/)
  assert.match(result.lines[1] ?? '', /samples=8\/8/)
})

test('a harness fault during the dwell stops and does not roll back', async () => {
  let rolled = 0
  const result = await runRamp(policy([{ percent: 1, dwellMs: 1 }, { percent: 100, dwellMs: 1 }]), {
    now: () => 0,
    sleep: async () => {},
    dwell: async () => ({ probeFailures: 0, harnessFaults: 1 }),
    applySplit: async () => null,
    observe: async () => sample(),
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.equal(result.state.kind, 'stopped')
  if (result.state.kind === 'stopped') {
    assert.equal(result.state.fault, 'harness_fault')
    assert.equal(result.state.reason, 'harness fault during probes')
  }
  assert.equal(rolled, 0)
  assert.equal(result.lines.length, 0)
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
    observe: async () => sample({
      wallMs: Array.from({ length: MIN_SAMPLES }, () => 10),
    }, {
      wallMs: Array.from({ length: MIN_SAMPLES }, () => 10),
    }),
    rollback: async () => null,
  })
  assert.equal(result.state.kind, 'complete')
  assert.deepEqual(slept, [40, 20_000])
  const warmed: number[] = []
  await runRamp(policy([{ percent: 100, dwellMs: 40 }], 5_000), {
    now: () => 0,
    sleep: async ms => { warmed.push(ms) },
    applySplit: async () => null,
    observe: async () => sample(),
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
      observe: async () => sample({ wallMs: Array.from({ length: MIN_SAMPLES }, () => 10) }, { wallMs: Array.from({ length: MIN_SAMPLES }, () => 10) }),
      onDecision: async () => {},
      rollback: async () => null,
    },
  ))
})
