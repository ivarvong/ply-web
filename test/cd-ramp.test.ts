import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyRamp, decideRampStep, progressLine, rampStart, runRamp, type Observation } from '../scripts/cd/ramp.ts'
import type { VersionStats } from '../scripts/cd/telemetry.ts'
import { MIN_SAMPLES } from '../scripts/cd/slo.ts'

function stats(over: Partial<VersionStats> = {}): VersionStats {
  return {
    requests: 20,
    exceptions: 0,
    errors: 0,
    fivexx: 0,
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

const schedule = { percents: [50, 100], dwellMs: 1, probeRps: 0 }

test('a short clean sample is insufficient_data and still advances', () => {
  const decision = decideRampStep(sample({ requests: 2, wallMs: [80, 81] }, { requests: 3, wallMs: [70, 71, 72] }))
  assert.equal(decision.outcome, 'insufficient_data')
  const start = rampStart()
  const next = applyRamp(start, decision, 7)
  assert.deepEqual(next, { kind: 'ramping', step: 1 })
  const last = applyRamp({ kind: 'ramping', step: 6 }, decision, 7)
  assert.equal(last.kind, 'complete')
})

test('unavailable telemetry rolls back and is never a pass', () => {
  const decision = decideRampStep({ kind: 'unavailable', reason: 'telemetry unavailable: cf o11y down' })
  assert.equal(decision.outcome, 'rollback')
  assert.match(decision.reason, /telemetry unavailable/)
})

test('one exception on the new version rolls back before the sample minimum', () => {
  const decision = decideRampStep(sample({ requests: 1, exceptions: 1, errors: 1, wallMs: [40] }, { requests: 40 }))
  assert.equal(decision.outcome, 'rollback')
  assert.equal(decision.reason, '1 exception on the new version')
})

test('a wall p99 ratio above 2 on a short sample rolls back', () => {
  const over = decideRampStep(sample({ wallMs: [210, 210, 210, 210, 210, 210] }, { wallMs: [80, 80, 80, 80, 80, 80] }))
  assert.equal(over.outcome, 'rollback')
  assert.equal(over.reason, 'wall p99 ratio 2.625 > 2')
})

test('applyRamp ignores decisions after rollback', () => {
  const rolled = { kind: 'rolled-back' as const, reason: 'breach' }
  assert.equal(applyRamp(rolled, decideRampStep(sample()), 7), rolled)
})

test('progress line names insufficient_data and a carried baseline', () => {
  const line = progressLine({
    step: 1,
    steps: 7,
    percent: 1,
    next: stats({ requests: 3, wallMs: [88] }),
    previous: stats({ requests: 4, wallMs: [74] }),
    decision: decideRampStep(sample({ requests: 3, wallMs: [88, 88, 88] }, { requests: 4, wallMs: [74, 74, 74, 74] })),
  })
  assert.match(line, /^ramp step=1\/7 percent=1 previous=99 /)
  assert.match(line, /decision=insufficient_data/)
  const carried = progressLine({
    step: 7,
    steps: 7,
    percent: 100,
    next: stats({ requests: 120, wallMs: [114, 114, 114, 114, 114] }),
    previous: stats({ requests: 28, wallMs: [84, 84, 84, 84, 84] }),
    decision: { outcome: 'advance', reason: 'ok', rules: [{ name: 'fast_burn', value: 14.4 }], burns: { availability: null, read_latency: null, write_latency: null, correctness: null } },
    carried: true,
  })
  assert.equal(
    carried,
    'ramp step=7/7 percent=100 previous=0 samples=120/28 error_rate=0.0000/0.0000 p99_wall_ms=114/84 decision=advance previous_sample=carried',
  )
})

test('at 100% the old side is the last wall sample that met the quantile floor', async () => {
  const enough = stats({ requests: 8, wallMs: [84, 84, 84, 84, 84] })
  const quiet = stats({ requests: 0, wallMs: [], cpuMs: [], fetchMs: [] })
  let step = 0
  const result = await runRamp(schedule, {
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

test('a decision callback without an observation ref throws', async () => {
  await assert.rejects(runRamp(
    { percents: [100], dwellMs: 1, probeRps: 0 },
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
