import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parsePolicy, type RolloutPolicy } from '../scripts/cd/policy.ts'
import {
  AVAILABILITY,
  burnRate,
  countCorrectness,
  countSlo,
  errorBudget,
  FAST_BURN,
  judgeStep,
  MIN_SAMPLES,
  READ_LATENCY,
  type StepInput,
  type V1Request,
} from '../scripts/cd/slo.ts'

function request(over: Partial<V1Request> = {}): V1Request {
  return {
    method: 'GET',
    path: '/v1/discover',
    status: 200,
    exception: false,
    wallMs: 100,
    expected4xx: false,
    ...over,
  }
}

function side(over: Partial<StepInput> = {}): StepInput {
  return { requests: 0, exceptions: 0, errors: 0, fivexx: 0, errorLogs: 0, wallMs: [], v1: [], ...over }
}

function checkedPolicy(patch?: (raw: Record<string, unknown>) => void): RolloutPolicy {
  const raw = JSON.parse(readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')) as Record<string, unknown>
  patch?.(raw)
  return parsePolicy(JSON.stringify(raw)).policy
}

function walls(n: number, value: number): number[] {
  return Array.from({ length: n }, () => value)
}

test('burn rate is the bad fraction divided by the error budget', () => {
  assert.ok(Math.abs(errorBudget(AVAILABILITY.target) - 0.001) < 1e-12)
  assert.ok(Math.abs((burnRate(1, 1000, AVAILABILITY.target) ?? 0) - 1) < 1e-9)
  assert.equal(burnRate(0, 10, READ_LATENCY.target), 0)
  assert.equal(burnRate(0, 0, READ_LATENCY.target), null)
  assert.ok((burnRate(3, 20, READ_LATENCY.target) ?? 0) > FAST_BURN)
  assert.ok((burnRate(2, 20, READ_LATENCY.target) ?? 0) < FAST_BURN)
})

test('expected 4xx leave the availability denominator and a slow read is a latency miss', () => {
  const requests = [
    request({ status: 404, expected4xx: true }),
    request({ status: 500 }),
    request({ status: 200 }),
    request({ method: 'POST', path: '/v1/edit', wallMs: 3000 }),
    request({ wallMs: 1500 }),
  ]
  const availability = countSlo(AVAILABILITY, requests)
  assert.equal(availability.total, 4)
  assert.equal(availability.bad, 1)
  const reads = countSlo(READ_LATENCY, requests)
  assert.equal(reads.bad, 1)
  assert.equal(reads.good, 3)
  const correctness = countCorrectness(199, 1)
  assert.ok(Math.abs((correctness.burn ?? 0) - 1) < 1e-9)
})

test('a short clean sample advances and a fast burn rolls back', () => {
  const policy = checkedPolicy()
  const quiet = judgeStep({
    next: side({ requests: 3, wallMs: walls(3, 80) }),
    previous: side({ requests: 4, wallMs: walls(4, 70) }),
    probeFailures: 0,
    policy,
  })
  assert.equal(quiet.outcome, 'advance')
  assert.equal(quiet.rules[0]?.name, 'fast_burn')
  const burned = judgeStep({
    next: side({
      requests: MIN_SAMPLES,
      wallMs: walls(MIN_SAMPLES, 80),
      v1: walls(MIN_SAMPLES, 1500).map(wallMs => request({ wallMs })),
    }),
    previous: side({ requests: MIN_SAMPLES, wallMs: walls(MIN_SAMPLES, 80) }),
    probeFailures: 0,
    policy,
  })
  assert.equal(burned.outcome, 'rollback')
  assert.equal(burned.rules[0]?.name, 'fast_burn')
  assert.equal(burned.rules[0]?.value, FAST_BURN)
  assert.match(burned.reason, /read_latency burn/)
})

test('any exception, 5xx, error log, or non-ok outcome rolls back before the sample floor', () => {
  const policy = checkedPolicy()
  const exception = judgeStep({
    next: side({ requests: 1, exceptions: 1, errors: 1 }),
    previous: side({ requests: 40 }),
    probeFailures: 0,
    policy,
  })
  assert.deepEqual(exception.outcome, 'rollback')
  assert.equal(exception.reason, '1 exception on the new version')
  const fivexx = judgeStep({
    next: side({ requests: 1, fivexx: 1 }),
    previous: side({ requests: 1, fivexx: 9 }),
    probeFailures: 0,
    policy,
  })
  assert.match(fivexx.reason, /5xx/)
  assert.equal(fivexx.outcome, 'rollback')
  const logged = judgeStep({
    next: side({ requests: 1, errorLogs: 1 }),
    previous: side({ requests: 4 }),
    probeFailures: 0,
    policy,
  })
  assert.equal(logged.outcome, 'rollback')
  assert.equal(logged.reason, '1 error log on the new version')
})

test('the checked-in policy does not roll back on wall time', () => {
  const policy = checkedPolicy()
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/cd/ramp-5pct-walls.json', import.meta.url), 'utf8')) as {
    next: number[]
    previous: number[]
  }
  const recorded = judgeStep({
    next: side({ requests: fixture.next.length, wallMs: fixture.next }),
    previous: side({ requests: fixture.previous.length, wallMs: fixture.previous }),
    probeFailures: 0,
    policy,
  })
  assert.equal(recorded.outcome, 'advance')
  assert.equal(recorded.rules[0]?.name, 'fast_burn')
  const wide = judgeStep({
    next: side({ requests: 161, wallMs: walls(161, 27) }),
    previous: side({ requests: 161, wallMs: walls(161, 12) }),
    probeFailures: 0,
    policy,
  })
  assert.equal(wide.outcome, 'advance')
  const gross = judgeStep({
    next: side({ requests: MIN_SAMPLES, wallMs: walls(MIN_SAMPLES, 210) }),
    previous: side({ requests: MIN_SAMPLES, wallMs: walls(MIN_SAMPLES, 80) }),
    probeFailures: 0,
    policy,
  })
  assert.equal(gross.outcome, 'advance')
})

test('latency=gate rolls back only when the policy thresholds clear', () => {
  const policy = checkedPolicy(raw => {
    raw.gates = {
      ...(raw.gates as Record<string, unknown>),
      latency: { mode: 'gate', minSamples: MIN_SAMPLES, p99Ratio: 2, effectFloorMs: 10 },
    }
  })
  const clear = judgeStep({
    next: side({ requests: MIN_SAMPLES, wallMs: walls(MIN_SAMPLES, 80) }),
    previous: side({ requests: MIN_SAMPLES, wallMs: walls(MIN_SAMPLES, 20) }),
    probeFailures: 0,
    policy,
  })
  assert.equal(clear.outcome, 'rollback')
  assert.match(clear.reason, /wall p99 ratio 4.000 > 2/)
  assert.match(clear.reason, /\+60ms > 10ms/)
  const short = judgeStep({
    next: side({ requests: 6, wallMs: walls(6, 210) }),
    previous: side({ requests: 6, wallMs: walls(6, 80) }),
    probeFailures: 0,
    policy,
  })
  assert.equal(short.outcome, 'advance')
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/cd/ramp-5pct-walls.json', import.meta.url), 'utf8')) as {
    next: number[]
    previous: number[]
  }
  const recorded = judgeStep({
    next: side({ requests: fixture.next.length, wallMs: fixture.next }),
    previous: side({ requests: fixture.previous.length, wallMs: fixture.previous }),
    probeFailures: 0,
    policy,
  })
  assert.equal(recorded.outcome, 'advance')
})

test('an informational signal is recorded and does not roll back', () => {
  const policy = checkedPolicy(raw => {
    raw.gates = { ...(raw.gates as Record<string, unknown>), fivexx: 'informational' }
  })
  const step = judgeStep({
    next: side({ requests: 2, fivexx: 1 }),
    previous: side({ requests: 2 }),
    probeFailures: 0,
    policy,
  })
  assert.equal(step.outcome, 'advance')
  assert.match(step.reason, /informational: 1 5xx response/)
})
