// ply-web#145: how a settled unjudged ramp state reaches verdict.json (rolledBack, fault, reason).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HarnessTraffic } from '../scripts/cd/ramp.ts'
import { unjudgedFail } from '../scripts/cd/stage-ramp.ts'

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
