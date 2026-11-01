import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { none, some } from '../src/option.ts'
import { parsePolicy, type RolloutPolicy } from '../scripts/cd/policy.ts'
import { accountProbeLoss, classifyProbe, judgeProbeWindow, type ProbeJudge, type ProbeOutcome } from '../scripts/cd/probe.ts'
import { runRamp, type Observation } from '../scripts/cd/ramp.ts'
import type { VersionStats } from '../scripts/cd/telemetry.ts'

function policy(over: { readonly onHarnessFault: 'rollback' | 'hold'; readonly maxLossRate: number; readonly minSamples: number } | null = null): RolloutPolicy {
  const raw = JSON.parse(readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')) as {
    steps: { percent: number; dwellMs: number }[]
    probe: { maxLossRate: number; onHarnessFault: string }
    burn: { minSamples: number }
  }
  raw.steps = [{ percent: 75, dwellMs: 1 }, { percent: 100, dwellMs: 1 }]
  if (over) {
    raw.probe.maxLossRate = over.maxLossRate
    raw.probe.onHarnessFault = over.onHarnessFault
    raw.burn.minSamples = over.minSamples
  }
  return parsePolicy(JSON.stringify(raw)).policy
}

function judgeOf(maxLossRate: number, respondedMin: number, minSamples: number): ProbeJudge {
  return { maxLossRate, respondedMin, minSamples, stallLatencyMs: 1_000, fivexxHard: true }
}

function responded(id: string, status = 200): ProbeOutcome {
  return classifyProbe(id, { kind: 'response', status, ray: some('ray'), latencyMs: 50, version: none() })
}

function aborted(id: string): ProbeOutcome {
  return classifyProbe(id, { kind: 'thrown', name: 'AbortError', message: 'The operation was aborted' })
}

function fill(count: number, status = 200): ProbeOutcome[] {
  const outcomes: ProbeOutcome[] = []
  for (let index = 0; index < count; index++) outcomes.push(responded(`ok-${index}`, status))
  return outcomes
}

function stats(requests: number): VersionStats {
  return {
    requests,
    invocations: requests,
    exceptions: 0,
    errors: 0,
    fivexx: 0,
    errorLogs: 0,
    wallMs: [10, 10, 10, 10, 10],
    cpuMs: [10],
    fetchMs: [10],
    v1: [],
    internal: [],
  }
}

function windowFor(percent: number): Observation {
  if (percent >= 100) {
    const next = stats(200)
    const previous = stats(0)
    return { kind: 'sample', next, previous: { ...previous, wallMs: [], cpuMs: [], fetchMs: [] }, aggregate: next }
  }
  const next = stats(150)
  const previous = stats(50)
  return { kind: 'sample', next, previous, aggregate: stats(200) }
}

test('a client abort with no status and no ray is a loss, and a 500 is a responded server error', () => {
  const lost = aborted('1 GET https://ply.ivar.workers.dev/')
  assert.equal(lost.kind, 'lost')
  if (lost.kind === 'lost') assert.equal(lost.reason, 'aborted')
  const timed = classifyProbe('timed', { kind: 'timeout' })
  assert.deepEqual(timed, { kind: 'lost', id: 'timed', reason: 'timed_out' })
  const named = classifyProbe('named', { kind: 'thrown', name: 'TimeoutError', message: 'The operation was aborted due to timeout' })
  assert.deepEqual(named, { kind: 'lost', id: 'named', reason: 'timed_out' })
  const network = classifyProbe('net', { kind: 'thrown', name: 'TypeError', message: 'fetch failed' })
  assert.deepEqual(network, { kind: 'lost', id: 'net', reason: 'network' })
  const empty = classifyProbe('empty', { kind: 'response', status: 0, ray: some('ray'), latencyMs: 50, version: none() })
  assert.equal(empty.kind, 'lost')
  const server = classifyProbe('srv', { kind: 'response', status: 500, ray: some('ray'), latencyMs: 50, version: none() })
  assert.equal(server.kind, 'responded')
  const loss = accountProbeLoss([lost, server, ...fill(1)], 1 / 790)
  assert.equal(loss.count, 1)
  assert.equal(loss.responded, 2)
  assert.equal(loss.serverErrors, 1)
  assert.deepEqual(loss.ids, ['1 GET https://ply.ivar.workers.dev/'])
  assert.equal(loss.exceeded, true)
})

test('the measured 1/790 abort is under the checked-in rate and is not a server error', () => {
  const outcomes = [...fill(789), aborted('790 GET https://ply.ivar.workers.dev/')]
  const loss = accountProbeLoss(outcomes, 1 / 790)
  assert.equal(loss.total, 790)
  assert.equal(loss.count, 1)
  assert.equal(loss.rate, 1 / 790)
  assert.equal(loss.exceeded, false)
  assert.equal(loss.responded, 789)
  assert.equal(loss.serverErrors, 0)
  const window = judgeProbeWindow(outcomes, judgeOf(1 / 790, 100, 1_000))
  assert.equal(window.kind, 'ok')
})

test('one more loss than the measured rate is a harness fault once the denominator is large enough', () => {
  const under = judgeProbeWindow([...fill(788), aborted('a'), aborted('b')], judgeOf(1 / 790, 100, 1_000))
  assert.notEqual(under.kind, 'harness_fault')
  const outcomes = [...fill(998), aborted('a'), aborted('b')]
  const window = judgeProbeWindow(outcomes, judgeOf(1 / 790, 100, 1_000))
  assert.equal(window.kind, 'harness_fault')
  if (window.kind === 'harness_fault') {
    assert.equal(window.loss.count, 2)
    assert.equal(window.loss.exceeded, true)
    assert.match(window.reason, /exceeds probe.maxLossRate/)
  }
})

test('losses that leave fewer responded probes than the minimum are insufficient samples, not a pass', () => {
  const outcomes = [...fill(40), aborted('lost')]
  const window = judgeProbeWindow(outcomes, judgeOf(0.5, 100, 1_000))
  assert.equal(window.kind, 'insufficient_samples')
  if (window.kind === 'insufficient_samples') {
    assert.equal(window.loss.responded, 40)
    assert.equal(window.loss.exceeded, false)
    assert.match(window.reason, /40 responded probes < 100/)
  }
})

test('a loss above the rate at 100% rolls back to previous and does not judge the step as a pass', async () => {
  let rolled = 0
  const splits: number[] = []
  const result = await runRamp(policy(), {
    now: () => 0,
    sleep: async () => {},
    dwell: async (_ms, percent) => ({
      outcomes: percent === 100 ? [...fill(998), aborted('a'), aborted('b')] : fill(200),
    }),
    applySplit: async percent => {
      splits.push(percent)
      return null
    },
    observe: async (_from, _to, percent) => windowFor(percent),
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.deepEqual(splits, [75, 100])
  assert.equal(rolled, 1)
  assert.equal(result.state.kind, 'stopped')
  if (result.state.kind === 'stopped' && result.state.fault === 'harness_fault') assert.equal(result.state.traffic, 'rolled_back')
  const failed = result.steps[1]
  if (!failed) throw new Error('missing 100% step')
  assert.equal(failed.probeLoss.count, 2)
  assert.equal(failed.outcome, 'harness_fault')
})

test('hold keeps the last fully passed split instead of rolling back to previous', async () => {
  const splits: number[] = []
  let rolled = 0
  const result = await runRamp(policy({ onHarnessFault: 'hold', maxLossRate: 1 / 790, minSamples: 100 }), {
    now: () => 0,
    sleep: async () => {},
    dwell: async (_ms, percent) => ({
      outcomes: percent === 100 ? [...fill(998), aborted('a'), aborted('b')] : fill(200),
    }),
    applySplit: async percent => {
      splits.push(percent)
      return null
    },
    observe: async (_from, _to, percent) => windowFor(percent),
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.equal(rolled, 0)
  assert.deepEqual(splits, [75, 100, 75])
  if (result.state.kind === 'stopped' && result.state.fault === 'harness_fault') assert.equal(result.state.traffic, 'held')
})

test('a step under the minimum sample does not advance', async () => {
  let rolled = 0
  const result = await runRamp(policy({ onHarnessFault: 'rollback', maxLossRate: 0.5, minSamples: 100 }), {
    now: () => 0,
    sleep: async () => {},
    dwell: async () => ({ outcomes: [...fill(40), aborted('lost')] }),
    applySplit: async () => null,
    observe: async (_from, _to, percent) => windowFor(percent),
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.equal(rolled, 0)
  assert.equal(result.state.kind, 'held')
  if (result.state.kind === 'held') assert.equal(result.state.outcome, 'insufficient_samples')
  const recorded = result.steps[0]
  if (!recorded) throw new Error('missing step')
  assert.equal(recorded.outcome, 'insufficient_samples')
})
