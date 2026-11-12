// ply-web#145: how a settled unjudged ramp state reaches verdict.json (rolledBack, fault, reason).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HarnessTraffic } from '../scripts/cd/ramp.ts'
import { rampStageResult, unjudgedFail } from '../scripts/cd/stage-ramp.ts'
import type { RampState } from '../scripts/cd/ramp.ts'

const traffic = (value: 'rolled_back' | 'held' | 'settle_failed') => value as HarnessTraffic

test('a rolled-back harness_unhealthy step is a rolledBack fail with fault harness_unhealthy', () => {
  const reason = 'harness unhealthy: client stall; rolled back to previous'
  assert.deepEqual(unjudgedFail({ kind: 'held', reason, outcome: 'harness_unhealthy', traffic: traffic('rolled_back') }), {
    kind: 'fail',
    stage: 'ramp',
    reason,
    rolledBack: true,
    fault: 'harness_unhealthy',
  })
})

test('a held insufficient_samples step is not rolledBack and keeps its outcome as the fault', () => {
  const reason = 'stall; held at 75%'
  assert.deepEqual(unjudgedFail({ kind: 'held', reason, outcome: 'insufficient_samples', traffic: traffic('held') }), {
    kind: 'fail',
    stage: 'ramp',
    reason,
    rolledBack: false,
    fault: 'insufficient_samples',
  })
})

test('a failed settle is not rolledBack, and the reason is the state reason with no repeated error', () => {
  const reason = 'harness unhealthy: x; rollback to previous failed: boom 503; still at 100%'
  const result = unjudgedFail({ kind: 'held', reason, outcome: 'harness_unhealthy', traffic: traffic('settle_failed') })
  assert.deepEqual(result, { kind: 'fail', stage: 'ramp', reason, rolledBack: false, fault: 'harness_unhealthy' })
})

test('a rolled-back harness_fault stop is a rolledBack fail with fault harness_fault', () => {
  const reason = 'telemetry unavailable: 502; rolled back to previous'
  assert.deepEqual(unjudgedFail({ kind: 'stopped', reason, fault: 'harness_fault', traffic: traffic('rolled_back') }), {
    kind: 'fail',
    stage: 'ramp',
    reason,
    rolledBack: true,
    fault: 'harness_fault',
  })
})

// rampStageResult: every arm of the RampLoopResult -> StageResult mapping stageRamp returns (PR #151 round 3).
// Expected values are written out from the issue's contract, not computed from the code under test.
const V = 'new-version'
const P = 'prev-version'
const loop = (state: RampState, rollbackError: string | null = null) => ({ state, lines: ['l1', 'l2'], rollbackError })

test('rampStageResult: complete passes with version, previous and lines', () => {
  assert.deepEqual(rampStageResult(loop({ kind: 'complete' }), V, P), {
    kind: 'pass',
    stage: 'ramp',
    value: { version: V, previous: P, lines: ['l1', 'l2'] },
  })
})

test('rampStageResult: a policy hold (no traffic) is a worker fail, not rolledBack', () => {
  assert.deepEqual(rampStageResult(loop({ kind: 'held', reason: 'split mismatch; held', outcome: 'hold' }), V, P), {
    kind: 'fail',
    stage: 'ramp',
    reason: 'split mismatch; held',
    rolledBack: false,
    fault: 'worker',
  })
  assert.deepEqual(rampStageResult(loop({ kind: 'held', reason: 'thin data; held', outcome: 'insufficient_data' }), V, P), {
    kind: 'fail',
    stage: 'ramp',
    reason: 'thin data; held',
    rolledBack: false,
    fault: 'worker',
  })
})

test('rampStageResult: an unjudged rolled-back harness_unhealthy hold is rolledBack with fault harness_unhealthy', () => {
  const state: RampState = { kind: 'held', reason: 'client stall; rolled back', outcome: 'harness_unhealthy', traffic: traffic('rolled_back') }
  assert.deepEqual(rampStageResult(loop(state), V, P), {
    kind: 'fail',
    stage: 'ramp',
    reason: 'client stall; rolled back',
    rolledBack: true,
    fault: 'harness_unhealthy',
  })
})

test('rampStageResult: an unjudged held insufficient_samples hold is not rolledBack with fault insufficient_samples', () => {
  const state: RampState = { kind: 'held', reason: 'few samples; held at 25%', outcome: 'insufficient_samples', traffic: traffic('held') }
  assert.deepEqual(rampStageResult(loop(state), V, P), {
    kind: 'fail',
    stage: 'ramp',
    reason: 'few samples; held at 25%',
    rolledBack: false,
    fault: 'insufficient_samples',
  })
})

test('rampStageResult: a rolled-back harness_fault stop is rolledBack with fault harness_fault', () => {
  const state: RampState = { kind: 'stopped', reason: 'telemetry 502; rolled back', fault: 'harness_fault', traffic: traffic('rolled_back') }
  assert.deepEqual(rampStageResult(loop(state), V, P), {
    kind: 'fail',
    stage: 'ramp',
    reason: 'telemetry 502; rolled back',
    rolledBack: true,
    fault: 'harness_fault',
  })
})

test('rampStageResult: a harness_fault stop whose settle failed is not rolledBack', () => {
  const state: RampState = { kind: 'stopped', reason: 'telemetry 502; rollback failed', fault: 'harness_fault', traffic: traffic('settle_failed') }
  assert.deepEqual(rampStageResult(loop(state), V, P), {
    kind: 'fail',
    stage: 'ramp',
    reason: 'telemetry 502; rollback failed',
    rolledBack: false,
    fault: 'harness_fault',
  })
})

test('rampStageResult: a state_conflict stop is not rolledBack with fault state_conflict', () => {
  assert.deepEqual(rampStageResult(loop({ kind: 'stopped', reason: 'split changed under us', fault: 'state_conflict' }), V, P), {
    kind: 'fail',
    stage: 'ramp',
    reason: 'split changed under us',
    rolledBack: false,
    fault: 'state_conflict',
  })
})

test('rampStageResult: a rollback that landed is a rolledBack worker fail', () => {
  assert.deepEqual(rampStageResult(loop({ kind: 'rolled-back', reason: '5xx at 10%' }), V, P), {
    kind: 'fail',
    stage: 'ramp',
    reason: '5xx at 10%',
    rolledBack: true,
    fault: 'worker',
  })
})

test('rampStageResult: a rollback whose write failed names previous and the error and is not rolledBack', () => {
  assert.deepEqual(rampStageResult(loop({ kind: 'rolled-back', reason: '5xx at 10%' }, 'cf 503'), V, P), {
    kind: 'fail',
    stage: 'ramp',
    reason: '5xx at 10%; rollback to prev-version failed: cf 503',
    rolledBack: false,
    fault: 'worker',
  })
})

test('rampStageResult: a loop that ended still ramping reads "ramp stopped" and is rolledBack', () => {
  assert.deepEqual(rampStageResult(loop({ kind: 'ramping', step: 1 }), V, P), {
    kind: 'fail',
    stage: 'ramp',
    reason: 'ramp stopped',
    rolledBack: true,
    fault: 'worker',
  })
})
