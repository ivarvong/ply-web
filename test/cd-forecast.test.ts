// Prediction vs observation per ramp step (scripts/cd/forecast.ts, issue #73), and its wiring in runRamp.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  compareStep,
  detectableErrorRate,
  detectableWallMs,
  mean,
  observedBasis,
  observeStep,
  predictStep,
  probeBasis,
  variance,
} from '../scripts/cd/forecast.ts'
import { parsePolicy, type RolloutPolicy } from '../scripts/cd/policy.ts'
import { runRamp, type Observation } from '../scripts/cd/ramp.ts'
import type { VersionStats } from '../scripts/cd/telemetry.ts'

function policy(steps: { percent: number; dwellMs: number }[]): RolloutPolicy {
  const raw = JSON.parse(readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')) as Record<string, unknown>
  raw.steps = steps
  return parsePolicy(JSON.stringify(raw)).policy
}

function stats(over: Partial<VersionStats> = {}): VersionStats {
  const row: VersionStats = { requests: 0, invocations: 0, exceptions: 0, errors: 0, fivexx: 0, errorLogs: 0, wallMs: [], cpuMs: [], fetchMs: [], v1: [], internal: [], ...over }
  return { ...row, invocations: 'invocations' in over ? row.invocations : row.requests }
}

function sample(next: Partial<VersionStats>, previous: Partial<VersionStats>): Extract<Observation, { kind: 'sample' }> {
  const newer = stats(next)
  const older = stats(previous)
  return { kind: 'sample', next: newer, previous: older, aggregate: stats({ requests: newer.requests + older.requests, wallMs: [...newer.wallMs, ...older.wallMs] }) }
}

test('mean and sample variance', () => {
  assert.equal(mean([]), null)
  assert.equal(mean([1, 2, 3]), 2)
  assert.equal(variance([5]), null)
  assert.equal(variance([2, 4, 4, 4, 5, 5, 7, 9]), 32 / 7)
})

test('detectable effects: the rule of three at zero errors; z standard errors with a baseline; none without samples', () => {
  assert.equal(detectableErrorRate(0, 100, 0, 3), null)
  assert.equal(detectableErrorRate(300, 0, 0, 3), 0.01)
  assert.equal(detectableErrorRate(300, 700, 0, 3), 0.01)
  // p = 0.05, n = 1000/1000, z = 3: 3 * sqrt(0.0475 * 0.002) = 0.02924
  assert.ok(Math.abs(Number(detectableErrorRate(1000, 1000, 0.05, 3)) - 0.029240) < 1e-5)
  assert.equal(detectableWallMs(100, 100, null, 3), null)
  assert.equal(detectableWallMs(100, 0, 400, 3), null)
  // s = 20ms, n = 100/100, z = 3: 3 * 20 * sqrt(0.02) = 8.485
  assert.ok(Math.abs(Number(detectableWallMs(100, 100, 400, 3)) - 8.4853) < 1e-3)
})

test('the first step is predicted from the probe rate; later steps from the step before', () => {
  const p = policy([{ percent: 10, dwellMs: 40_000 }, { percent: 100, dwellMs: 40_000 }])
  const first = probeBasis(p)
  assert.equal(first.ratePerSecond, p.probe.rps * p.probe.calls.length)
  const predicted = predictStep(first, 10, 40_000, 3)
  // 25 rps x 2 calls x 40 s = 2000 requests, 10% new.
  assert.deepEqual([predicted.newRequests, predicted.oldRequests, predicted.detectableWallMs], [200, 1800, null])
  assert.equal(predicted.detectableErrorRate, 3 / 200)
  const seen = sample({ requests: 200, wallMs: [90, 110] }, { requests: 1800, fivexx: 18, wallMs: [80, 120] })
  const basis = observedBasis(1, 10, seen, 40_000)
  assert.equal(basis.source, 'step 1 (10%)')
  assert.equal(basis.ratePerSecond, 50)
  assert.equal(basis.errorRate, 18 / 2000)
  assert.equal(basis.wallVariance, variance([90, 110, 80, 120]))
  assert.equal(basis.wallShare, 4 / 2000)
})

test('a step that sees the predicted traffic and variance has no drift; the line shows both', () => {
  // One wall sample per hundred requests: the prediction counts wall samples, not requests, for the wall-time effect.
  const basis = { source: 'step 1 (10%)', ratePerSecond: 50, errorRate: 0, wallVariance: 400, wallShare: 0.01 }
  const predicted = predictStep(basis, 25, 40_000, 3)
  assert.deepEqual([predicted.newRequests, predicted.oldRequests], [500, 1500])
  const walls = (n: number) => Array.from({ length: n }, (_, i) => 100 + (i % 2) * 40)
  const observed = observeStep(sample({ requests: 520, wallMs: walls(5) }, { requests: 1480, wallMs: walls(15) }), 3)
  const check = compareStep({ step: 2, percent: 25, basis, predicted, observed: observed.resolution, wallDeltaMs: observed.wallDeltaMs })
  assert.deepEqual(check.drift, [])
  assert.ok(check.wallDeltaMs !== null && Math.abs(check.wallDeltaMs) < 5)
  assert.match(check.line, /^forecast step=2 percent=25 predicted\(step 1 \(10%\)\) new=500 old=1500 detectable_error_rate=0\.0060 detectable_wall_ms=31\.0 \| observed new=520 old=1480 detectable_error_rate=0\.0058 detectable_wall_ms=\d+\.\d wall_delta_ms=-?\d+\.\d drift=none$/)
})

test('traffic far from the prediction, or a step that resolves far less than predicted, is drift', () => {
  const basis = { source: 'step 1 (10%)', ratePerSecond: 50, errorRate: 0, wallVariance: 100, wallShare: 1 }
  const predicted = predictStep(basis, 50, 40_000, 3)
  const thin = observeStep(sample({ requests: 300, wallMs: [10, 400, 20, 900] }, { requests: 1000, wallMs: [15, 600, 30] }), 3)
  const check = compareStep({ step: 3, percent: 50, basis, predicted, observed: thin.resolution, wallDeltaMs: thin.wallDeltaMs })
  assert.deepEqual(check.drift.map(d => d.split(' ').slice(0, 2).join(' ')), ['new-version requests', 'detectable error', 'detectable wall'])
  assert.match(check.line, / drift="new-version requests 300 vs predicted 1000; /)
  // No basis: the observation is still logged, with nothing to drift from.
  const none = compareStep({ step: 1, percent: 10, basis: null, predicted: null, observed: thin.resolution, wallDeltaMs: null })
  assert.deepEqual(none.drift, [])
  assert.match(none.line, /^forecast step=1 percent=10 predicted=none \| observed new=300 old=1000 .* drift=none$/)
})

test('runRamp records each step\'s forecast, predicting step n from step n-1', async () => {
  let calls = 0
  const result = await runRamp(policy([{ percent: 50, dwellMs: 1000 }, { percent: 100, dwellMs: 1000 }]), {
    now: () => 0,
    sleep: async () => {},
    applySplit: async () => null,
    observe: async () => {
      calls += 1
      if (calls === 1) return sample({ requests: 100, wallMs: [80, 90, 100, 110, 120] }, { requests: 100, wallMs: [80, 90, 100, 110, 120] })
      return sample({ requests: 1000, wallMs: [80, 90, 100, 110, 120] }, { requests: 0 })
    },
    rollback: async () => null,
  })
  assert.equal(result.state.kind, 'complete')
  const [first, second] = result.steps.map(step => {
    assert.ok(step.forecast, `step ${step.percent} has a forecast`)
    return step.forecast
  })
  // No dwell (no probe): the first step has nothing to predict from.
  assert.equal(first.predicted, null)
  assert.equal(first.observed.newRequests, 100)
  // 200 requests in 1 s at step 1 predicts 200 new at 100%; 1000 is five times that.
  assert.equal(second.basis, 'step 1 (50%)')
  assert.ok(second.predicted)
  assert.equal(second.predicted.newRequests, 200)
  assert.deepEqual(second.drift, ['new-version requests 1000 vs predicted 200'])
})
