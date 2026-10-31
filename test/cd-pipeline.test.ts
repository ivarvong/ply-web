import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArgs } from '../scripts/cd/main.ts'
import { nextPhase, pipelineStart, type PipelineState } from '../scripts/cd/pipeline-plan.ts'

function run(state: PipelineState, outcome: 'pass' | 'fail' | 'rolled-back') {
  return nextPhase(state, outcome).phase
}

test('a pinned smoke failure halts and leaves the canary at 0%', () => {
  const smoke = nextPhase(pipelineStart(), 'pass')
  const deployed = nextPhase(smoke, 'pass')
  assert.equal(deployed.phase, 'smoke-canary')
  const stopped = nextPhase(deployed, 'fail')
  assert.equal(stopped.phase, 'halt')
  assert.equal(stopped.smoke, 'fail')
})

test('telemetry does not ramp when the pinned smoke failed', () => {
  const state: PipelineState = { phase: 'telemetry-canary', smoke: 'fail' }
  assert.equal(run(state, 'pass'), 'halt')
  assert.equal(run({ phase: 'telemetry-canary', smoke: 'pass' }, 'pass'), 'ramp')
  assert.equal(run({ phase: 'telemetry-canary', smoke: 'pass' }, 'fail'), 'halt')
})

test('a ramp rollback does not roll back again, and a live failure does', () => {
  assert.equal(run({ phase: 'ramp', smoke: 'pass' }, 'rolled-back'), 'halt')
  assert.equal(run({ phase: 'ramp', smoke: 'pass' }, 'fail'), 'halt')
  assert.equal(run({ phase: 'ramp', smoke: 'pass' }, 'pass'), 'smoke-live')
  assert.equal(run({ phase: 'smoke-live', smoke: 'pass' }, 'fail'), 'rollback')
  assert.equal(run({ phase: 'telemetry-live', smoke: 'pass' }, 'fail'), 'rollback')
  assert.equal(run({ phase: 'telemetry-live', smoke: 'pass' }, 'pass'), 'done')
  assert.equal(run({ phase: 'rollback', smoke: 'pass' }, 'pass'), 'halt')
  assert.equal(run({ phase: 'rollback', smoke: 'pass' }, 'fail'), 'halt')
})

test('usage and a bad version exit as argument errors', () => {
  assert.equal(parseArgs(['help']).kind, 'usage')
  assert.equal(parseArgs(['cd', '--sha', 'abc']).kind, 'error')
  assert.equal(parseArgs(['smoke']).kind, 'error')
  const version = '8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e'
  assert.deepEqual(parseArgs(['smoke', '--version', version]), { kind: 'smoke', version, expectVersion: null })
  assert.equal(parseArgs(['telemetry', '--version', version, '--since', '2026-10-31T21:05:00Z']).kind, 'telemetry')
})
