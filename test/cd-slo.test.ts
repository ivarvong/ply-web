import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AVAILABILITY,
  burnRate,
  compareLatency,
  countCorrectness,
  countSlo,
  errorBudget,
  FAST_BURN,
  judgeStep,
  mannWhitneyGreater,
  MIN_SAMPLES,
  QUANTILE_P99_RATIO,
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
  return { requests: 0, exceptions: 0, errors: 0, fivexx: 0, wallMs: [], v1: [], ...over }
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

test('Mann-Whitney rank sums match the textbook samples', () => {
  const faster = mannWhitneyGreater([1, 2, 3], [4, 5, 6], 0.01)
  assert.equal(faster?.rankSum, 6)
  assert.equal(faster?.slower, false)
  const slower = mannWhitneyGreater([4, 5, 6], [1, 2, 3], 0.01)
  assert.equal(slower?.rankSum, 15)
  assert.ok((slower?.z ?? 0) > 0)
  const separated = mannWhitneyGreater(walls(MIN_SAMPLES, 500), walls(MIN_SAMPLES, 50), 0.01)
  assert.equal(separated?.slower, true)
})

test('a short clean sample is insufficient_data and a fast burn rolls back', () => {
  const quiet = judgeStep({
    next: side({ requests: 3, wallMs: walls(3, 80) }),
    previous: side({ requests: 4, wallMs: walls(4, 70) }),
    probeFailures: 0,
  })
  assert.equal(quiet.outcome, 'insufficient_data')
  assert.equal(quiet.rules[0]?.name, 'min_samples')
  const burned = judgeStep({
    next: side({
      requests: MIN_SAMPLES,
      wallMs: walls(MIN_SAMPLES, 80),
      v1: walls(MIN_SAMPLES, 1500).map(wallMs => request({ wallMs })),
    }),
    previous: side({ requests: MIN_SAMPLES, wallMs: walls(MIN_SAMPLES, 80) }),
    probeFailures: 0,
  })
  assert.equal(burned.outcome, 'rollback')
  assert.equal(burned.rules[0]?.name, 'fast_burn')
  assert.equal(burned.rules[0]?.value, FAST_BURN)
  assert.match(burned.reason, /read_latency burn/)
})

test('any exception or 5xx on the new version rolls back before the sample floor', () => {
  const exception = judgeStep({
    next: side({ requests: 1, exceptions: 1, errors: 1 }),
    previous: side({ requests: 40 }),
    probeFailures: 0,
  })
  assert.deepEqual(exception.outcome, 'rollback')
  assert.equal(exception.reason, '1 exception on the new version')
  const fivexx = judgeStep({
    next: side({ requests: 1, fivexx: 1 }),
    previous: side({ requests: 1, fivexx: 9 }),
    probeFailures: 0,
  })
  assert.match(fivexx.reason, /5xx/)
  assert.equal(fivexx.outcome, 'rollback')
})

test('quantile comparison is used below the Mann-Whitney floor', () => {
  const over = compareLatency(walls(6, 210), walls(6, 80))
  assert.equal(over.kind, 'slower')
  assert.equal(over.reason, `wall p99 ratio 2.625 > ${QUANTILE_P99_RATIO}`)
  const atMax = compareLatency(walls(6, 160), walls(6, 80))
  assert.equal(atMax.kind, 'not_slower')
  const short = compareLatency(walls(4, 10), walls(4, 10))
  assert.equal(short.kind, 'insufficient_data')
})

test('a clean compared sample advances', () => {
  const ok = judgeStep({
    next: side({ requests: 6, wallMs: walls(6, 90), v1: walls(6, 90).map(wallMs => request({ wallMs })) }),
    previous: side({ requests: 6, wallMs: walls(6, 80) }),
    probeFailures: 0,
  })
  assert.equal(ok.outcome, 'advance')
})
