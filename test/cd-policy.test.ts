import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { FAST_BURN, MIN_SAMPLES } from '../scripts/cd/slo.ts'
import { applyGates, type SmokeJudge } from '../scripts/cd/telemetry.ts'
import { DEFAULT_POLICY_PATH, loadPolicy, parsePolicy, splitPolicy } from '../scripts/cd/policy.ts'

function text(): string {
  return readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')
}

function raw(): Record<string, unknown> {
  return JSON.parse(text()) as Record<string, unknown>
}

test('the checked-in policy is the correctness ramp', () => {
  const loaded = loadPolicy(DEFAULT_POLICY_PATH)
  assert.equal(loaded.sha256, parsePolicy(text()).sha256)
  assert.equal(loaded.policy.gates.latency.mode, 'informational')
  assert.equal(loaded.policy.gates.smoke, 'hard')
  assert.equal(loaded.policy.gates.fivexx, 'hard')
  assert.equal(loaded.policy.gates.exceptions, 'hard')
  assert.equal(loaded.policy.gates.errorLogs, 'hard')
  assert.equal(loaded.policy.gates.nonOk, 'hard')
  assert.equal(loaded.policy.gates.burn, 'hard')
  assert.equal(loaded.policy.ingestWaitMs, 20_000)
  assert.equal(loaded.policy.warmupMs, 0)
  assert.equal(loaded.policy.probe.rps, 25)
  assert.deepEqual(loaded.policy.probe.calls.map(call => call.path), ['/', '/v1/discover'])
  assert.deepEqual(loaded.policy.steps.map(step => step.percent), [10, 25, 50, 75, 100])
  assert.equal(loaded.policy.burn.fastBurn, FAST_BURN)
  assert.equal(loaded.policy.burn.minSamples, MIN_SAMPLES)
  assert.equal(loaded.policy.split.z, 3)
  assert.equal(loaded.policy.split.minNewRequests, MIN_SAMPLES)
  assert.equal(loaded.policy.split.onMismatch, 'rollback')
  assert.equal(loaded.policy.split.onInsufficient, 'hold')
  assert.equal(loaded.policy.steps.every(step => step.dwellMs === 40_000), true)
})

test('a policy that cannot be run is rejected', () => {
  const decreasing = raw()
  const steps = decreasing.steps as { percent: number; dwellMs: number }[]
  steps[1] = { percent: 1, dwellMs: 40_000 }
  assert.throws(() => parsePolicy(JSON.stringify(decreasing)), /strictly increasing/)
  const early = raw()
  ;(early.steps as { percent: number }[]).pop()
  assert.throws(() => parsePolicy(JSON.stringify(early)), /last step must be 100/)
  const gate = raw()
  gate.gates = { ...(gate.gates as Record<string, unknown>), latency: { mode: 'gate' } }
  assert.throws(() => parsePolicy(JSON.stringify(gate)), /latency=gate needs minSamples, p99Ratio, and effectFloorMs/)
  const extra = raw()
  extra.region = 'iad'
  assert.throws(() => parsePolicy(JSON.stringify(extra)), /unknown field/)
  assert.throws(() => parsePolicy('{'), /not JSON/)
  const mismatch = raw()
  mismatch.split = { ...(mismatch.split as Record<string, unknown>), onMismatch: 'advance' }
  assert.throws(() => parsePolicy(JSON.stringify(mismatch)), /hold or rollback/)
  const thin = raw()
  thin.split = { ...(thin.split as Record<string, unknown>), minNewRequests: 0 }
  assert.throws(() => parsePolicy(JSON.stringify(thin)), /minNewRequests/)
  const zee = raw()
  zee.split = { ...(zee.split as Record<string, unknown>), z: 0 }
  assert.throws(() => parsePolicy(JSON.stringify(zee)), /split\.z/)
})

test('the checked-in probe can see a correctness regression on the smallest step', () => {
  const loaded = loadPolicy(DEFAULT_POLICY_PATH).policy
  const dwellS = loaded.steps[0]?.dwellMs ?? 0
  const requests = loaded.probe.rps * loaded.probe.calls.length * (dwellS / 1000)
  const open = loaded.steps.map(step => step.percent).filter(percent => percent < 100)
  const smallest = Math.min(...open)
  const expectedNew = requests * (smallest / 100)
  assert.equal(requests, 2000)
  assert.equal(smallest, 10)
  assert.equal(expectedNew, 200)
  assert.ok(expectedNew >= loaded.split.minNewRequests)
  const atFloor = 1 - 0.05 ** (1 / loaded.split.minNewRequests)
  const atExpected = 1 - 0.05 ** (1 / expectedNew)
  assert.ok(Math.abs(atFloor - 0.0295) < 0.001)
  assert.ok(Math.abs(atExpected - 0.0149) < 0.001)
})

test('latency=gate with thresholds is a policy, and warm-up may be omitted', () => {
  const body = raw()
  body.gates = {
    ...(body.gates as Record<string, unknown>),
    latency: { mode: 'gate', minSamples: 20, p99Ratio: 2, effectFloorMs: 10 },
  }
  delete body.warmupMs
  const loaded = parsePolicy(JSON.stringify(body))
  assert.equal(loaded.policy.gates.latency.mode, 'gate')
  assert.equal(loaded.policy.warmupMs, 0)
  if (loaded.policy.gates.latency.mode === 'gate') assert.equal(loaded.policy.gates.latency.p99Ratio, 2)
})

test('--policy is taken off the command line', () => {
  assert.deepEqual(splitPolicy(['--policy', 'other.json', 'cd', '--no-bump']), {
    argv: ['cd', '--no-bump'],
    policyPath: 'other.json',
  })
  assert.deepEqual(splitPolicy(['cd']), { argv: ['cd'], policyPath: null })
  const missing = splitPolicy(['--policy'])
  assert.equal('error' in missing, true)
  const twice = splitPolicy(['--policy', 'a.json', '--policy', 'b.json'])
  assert.equal('error' in twice, true)
})

test('informational latency does not fail smoke telemetry', () => {
  const verdict = {
    pass: true,
    total: 1,
    matched: 1,
    allowance: 2,
    lost: [],
    unconfirmed: [],
    otherVersion: [],
    reasons: [],
    line: 'telemetry: 1/1 matched',
  }
  const judge: SmokeJudge = {
    kind: 'worker',
    line: 'telemetry: 1/1 matched; latency',
    failures: [{ kind: 'latency', metric: 'wall', p: 'p99', value: 30_000, ceiling: 25_000 }],
    verdict,
  }
  const gates = loadPolicy(DEFAULT_POLICY_PATH).policy.gates
  const applied = applyGates(judge, gates)
  assert.equal(applied.kind, 'pass')
  if (applied.kind === 'pass') assert.match(applied.line, /informational:/)
  const gated = applyGates(judge, {
    ...gates,
    latency: { mode: 'gate', minSamples: 20, p99Ratio: 2, effectFloorMs: 10 },
  })
  assert.equal(gated.kind, 'worker')
})
