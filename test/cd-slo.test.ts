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
  routedShare,
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
  const row = {
    requests: 0,
    invocations: 0,
    exceptions: 0,
    errors: 0,
    fivexx: 0,
    errorLogs: 0,
    wallMs: [] as readonly number[],
    v1: [] as readonly V1Request[],
    ...over,
  }
  return { ...row, invocations: over.invocations ?? row.requests }
}

function judge(next: StepInput, previous: StepInput, policy: RolloutPolicy, targetPercent = 50, aggregate?: StepInput) {
  return judgeStep({
    next,
    previous,
    aggregate: aggregate ?? side({
      requests: next.requests + previous.requests,
      invocations: next.invocations + previous.invocations,
      exceptions: next.exceptions + previous.exceptions,
      errors: next.errors + previous.errors,
      fivexx: next.fivexx + previous.fivexx,
      errorLogs: next.errorLogs + previous.errorLogs,
      wallMs: [...next.wallMs, ...previous.wallMs],
      v1: [...next.v1, ...previous.v1],
    }),
    targetPercent,
    policy,
  })
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

test('a short clean sample is insufficient evidence and a fast burn rolls back', () => {
  const policy = checkedPolicy()
  const quiet = judge(side({ requests: 3, wallMs: walls(3, 80) }), side({ requests: 4, wallMs: walls(4, 70) }), policy)
  assert.equal(quiet.outcome, 'insufficient_data')
  assert.equal(quiet.rules[0]?.name, 'min_new_requests')
  const burned = judge(
    side({
      requests: MIN_SAMPLES,
      wallMs: walls(MIN_SAMPLES, 80),
      v1: walls(MIN_SAMPLES, 1500).map(wallMs => request({ wallMs })),
    }),
    side({ requests: MIN_SAMPLES, wallMs: walls(MIN_SAMPLES, 80) }),
    policy,
  )
  assert.equal(burned.outcome, 'rollback')
  assert.equal(burned.rules[0]?.name, 'fast_burn')
  assert.equal(burned.rules[0]?.value, FAST_BURN)
  assert.match(burned.reason, /read_latency burn/)
  assert.match(burned.reason, /on the new version/)
})

test('any exception, 5xx, error log, or non-ok outcome rolls back before the sample floor', () => {
  const policy = checkedPolicy()
  const exception = judge(side({ requests: 1, exceptions: 1, errors: 1 }), side({ requests: 40 }), policy)
  assert.deepEqual(exception.outcome, 'rollback')
  assert.equal(exception.reason, '1 exception on the new version')
  const fivexx = judge(side({ requests: 1, fivexx: 1 }), side({ requests: 1 }), policy)
  assert.match(fivexx.reason, /5xx/)
  assert.equal(fivexx.outcome, 'rollback')
  const logged = judge(side({ requests: 1, errorLogs: 1 }), side({ requests: 4 }), policy)
  assert.equal(logged.outcome, 'rollback')
  assert.equal(logged.reason, '1 error log on the new version')
  const old = judge(side({ requests: MIN_SAMPLES }), side({ requests: MIN_SAMPLES, fivexx: 1 }), policy)
  assert.equal(old.outcome, 'rollback')
  assert.equal(old.reason, '1 5xx response on the old version')
  const across = judge(
    side({ requests: MIN_SAMPLES }),
    side({ requests: MIN_SAMPLES }),
    policy,
    50,
    side({ requests: MIN_SAMPLES * 2, fivexx: 1 }),
  )
  assert.equal(across.outcome, 'rollback')
  assert.equal(across.reason, '1 5xx response across the worker')
})

test('the checked-in policy does not roll back on wall time', () => {
  const policy = checkedPolicy()
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/cd/ramp-5pct-walls.json', import.meta.url), 'utf8')) as {
    next: number[]
    previous: number[]
  }
  const recorded = judge(
    side({ requests: fixture.next.length, wallMs: fixture.next }),
    side({ requests: fixture.previous.length, wallMs: fixture.previous }),
    policy,
  )
  assert.notEqual(recorded.outcome, 'rollback')
  const wide = judge(side({ requests: 161, wallMs: walls(161, 27) }), side({ requests: 161, wallMs: walls(161, 12) }), policy)
  assert.equal(wide.outcome, 'advance')
  const gross = judge(
    side({ requests: MIN_SAMPLES, wallMs: walls(MIN_SAMPLES, 210) }),
    side({ requests: MIN_SAMPLES, wallMs: walls(MIN_SAMPLES, 80) }),
    policy,
  )
  assert.equal(gross.outcome, 'advance')
})

test('latency=gate rolls back only when the policy thresholds clear', () => {
  const policy = checkedPolicy(raw => {
    raw.gates = {
      ...(raw.gates as Record<string, unknown>),
      latency: { mode: 'gate', minSamples: MIN_SAMPLES, p99Ratio: 2, effectFloorMs: 10 },
    }
  })
  const clear = judge(
    side({ requests: MIN_SAMPLES, wallMs: walls(MIN_SAMPLES, 80) }),
    side({ requests: MIN_SAMPLES, wallMs: walls(MIN_SAMPLES, 20) }),
    policy,
  )
  assert.equal(clear.outcome, 'rollback')
  assert.match(clear.reason, /wall p99 ratio 4.000 > 2/)
  assert.match(clear.reason, /\+60ms > 10ms/)
  const short = judge(side({ requests: 6, wallMs: walls(6, 210) }), side({ requests: 6, wallMs: walls(6, 80) }), policy)
  assert.notEqual(short.outcome, 'rollback')
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/cd/ramp-5pct-walls.json', import.meta.url), 'utf8')) as {
    next: number[]
    previous: number[]
  }
  const recorded = judge(
    side({ requests: fixture.next.length, wallMs: fixture.next }),
    side({ requests: fixture.previous.length, wallMs: fixture.previous }),
    policy,
  )
  assert.notEqual(recorded.outcome, 'rollback')
})

test('an informational signal is recorded and does not roll back', () => {
  const policy = checkedPolicy(raw => {
    raw.gates = { ...(raw.gates as Record<string, unknown>), fivexx: 'informational' }
    raw.split = { ...(raw.split as Record<string, unknown>), minNewRequests: 1 }
  })
  const step = judge(side({ requests: 2, fivexx: 1 }), side({ requests: 2 }), policy)
  assert.equal(step.outcome, 'advance')
  assert.match(step.reason, /informational: 1 5xx response on the new version/)
})

test('the routed share matches a binomial band, and a thin sample is typed', () => {
  const policy = checkedPolicy()
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/cd/routed-share.json', import.meta.url), 'utf8')) as {
    targetPercent: number
    within: { newRequests: number; total: number }
    mismatch: { newRequests: number; total: number }
    thin: { newRequests: number; total: number }
  }
  const at = (counts: { newRequests: number; total: number }) => judge(
    side({ requests: counts.newRequests, invocations: counts.newRequests }),
    side({ requests: counts.total - counts.newRequests, invocations: counts.total - counts.newRequests }),
    policy,
    fixture.targetPercent,
    side({ requests: counts.total, invocations: counts.total }),
  )
  const within = at(fixture.within)
  assert.equal(within.outcome, 'advance')
  const missed = at(fixture.mismatch)
  assert.equal(missed.outcome, 'rollback')
  assert.equal(missed.rules[0]?.name, 'routed_share')
  assert.match(missed.reason, /outside/)
  const thin = at(fixture.thin)
  assert.equal(thin.outcome, 'insufficient_data')
  assert.match(thin.reason, /40 new-version requests < 100/)
  const band = routedShare(200, 2000, 10, 3)
  assert.equal(band.kind, 'match')
  assert.ok(Math.abs((band.low ?? 0) * 100 - 7.99) < 0.02)
  assert.ok(Math.abs((band.high ?? 0) * 100 - 12.01) < 0.02)
  const held = checkedPolicy(raw => {
    raw.split = { ...(raw.split as Record<string, unknown>), onMismatch: 'hold' }
  })
  assert.equal(judge(
    side({ requests: 1000, invocations: 1000 }),
    side({ requests: 1000, invocations: 1000 }),
    held,
    10,
    side({ requests: 2000, invocations: 2000 }),
  ).outcome, 'hold')
  const advanceThin = checkedPolicy(raw => {
    raw.split = { ...(raw.split as Record<string, unknown>), onInsufficient: 'advance' }
  })
  const moved = judge(
    side({ requests: 40, invocations: 40 }),
    side({ requests: 360, invocations: 360 }),
    advanceThin,
    10,
    side({ requests: 400, invocations: 400 }),
  )
  assert.equal(moved.outcome, 'advance')
  assert.match(moved.reason, /insufficient evidence/)
})
