import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { none, some } from '../src/option.ts'
import { parsePolicy, type RolloutPolicy } from '../scripts/cd/policy.ts'
import { classifyProbe, judgeProbeWindow, type ProbeJudge, type ProbeOutcome } from '../scripts/cd/probe.ts'
import { runProbeSchedule, type ProbeClock } from '../scripts/cd/probe-schedule.ts'
import { runRamp, type Observation } from '../scripts/cd/ramp.ts'
import type { VersionStats } from '../scripts/cd/telemetry.ts'

const OLD = '4f3d7acf'
const NEW = '19ee3cab'

function policy(): RolloutPolicy {
  const raw = JSON.parse(readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')) as Record<string, unknown>
  raw.steps = [{ percent: 100, dwellMs: 40_000 }]
  return parsePolicy(JSON.stringify(raw)).policy
}

function judge(): ProbeJudge {
  const rollout = policy()
  return {
    maxLossRate: rollout.probe.maxLossRate,
    respondedMin: rollout.burn.minSamples,
    minSamples: rollout.probe.minSamples,
    stallLatencyMs: rollout.probe.stallLatencyMs,
    fivexxHard: rollout.gates.fivexx === 'hard',
  }
}

function clock(): ProbeClock & { read(): number } {
  let at = 0
  return {
    now: () => at,
    sleep: async ms => {
      at += ms
    },
    read: () => at,
  }
}

function answered(id: string, version: string, latencyMs: number, status = 200): ProbeOutcome {
  return classifyProbe(id, { kind: 'response', status, ray: some('ray'), latencyMs, version: some(version) })
}

function incident(): ProbeOutcome[] {
  const outcomes: ProbeOutcome[] = []
  for (let index = 0; index < 59; index += 1) {
    outcomes.push(answered(`old-${index}`, OLD, 69_830))
    outcomes.push(answered(`new-${index}`, NEW, 69_830))
  }
  for (let index = 0; index < 10; index += 1) outcomes.push({ kind: 'lost', id: `lost-${index}`, reason: 'network' })
  return outcomes
}

function clean(): ProbeOutcome[] {
  const outcomes: ProbeOutcome[] = []
  for (let index = 0; index < 100; index += 1) {
    outcomes.push(answered(`old-${index}`, OLD, 50))
    outcomes.push(answered(`new-${index}`, NEW, 50))
  }
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
    wallMs: requests === 0 ? [] : [10, 10, 10, 10, 10],
    cpuMs: requests === 0 ? [] : [10],
    fetchMs: requests === 0 ? [] : [10],
    v1: [],
    internal: [],
  }
}

function at100(): Observation {
  const next = stats(200)
  return { kind: 'sample', next, previous: stats(0), aggregate: next }
}

test('a policy timeout is timed_out and a transport error stays network', () => {
  const timed = classifyProbe('t', { kind: 'timeout' })
  const network = classifyProbe('n', { kind: 'thrown', name: 'TypeError', message: 'fetch failed' })
  assert.equal(timed.kind, 'lost')
  if (timed.kind === 'lost') assert.equal(timed.reason, 'timed_out')
  assert.equal(network.kind, 'lost')
  if (network.kind === 'lost') assert.equal(network.reason, 'network')
  const aborted = classifyProbe('a', { kind: 'thrown', name: 'AbortError', message: 'The operation was aborted' })
  assert.equal(aborted.kind, 'lost')
  if (aborted.kind === 'lost') assert.equal(aborted.reason, 'aborted')
})

test('at the in-flight bound the next tick is shed and the dwell stays on the wall clock', async () => {
  const ticks = clock()
  let stopped = 0
  const outcomes = await runProbeSchedule({
    clock: ticks,
    dwellMs: 120,
    periodMs: 40,
    maxInFlight: 2,
    batch: 2,
    issue: seq => ({ id: `probe-${seq}`, promise: new Promise<ProbeOutcome>(() => {}) }),
    shed: seq => ({ kind: 'shed', id: `shed-${seq}` }),
    stop: () => {
      stopped += 1
    },
  })
  assert.equal(ticks.read(), 120)
  assert.equal(stopped, 1)
  const shed = outcomes.filter(item => item.kind === 'shed')
  const timed = outcomes.filter(item => item.kind === 'lost')
  assert.equal(shed.length, 4)
  assert.equal(timed.length, 2)
  for (const item of timed) {
    if (item.kind !== 'lost') throw new Error('expected a lost probe')
    assert.equal(item.reason, 'timed_out')
  }
})

test('a client stall does not stretch a 40s dwell and the unfinished probes are timed_out', async () => {
  const ticks = clock()
  const outcomes = await runProbeSchedule({
    clock: ticks,
    dwellMs: 40_000,
    periodMs: 40,
    maxInFlight: 4,
    batch: 2,
    issue: seq => ({ id: `probe-${seq}`, promise: new Promise<ProbeOutcome>(() => {}) }),
    shed: seq => ({ kind: 'shed', id: `shed-${seq}` }),
    stop: () => {},
  })
  assert.equal(ticks.read(), 40_000)
  const shed = outcomes.filter(item => item.kind === 'shed')
  const timed = outcomes.filter(item => item.kind === 'lost')
  assert.equal(timed.length, 4)
  assert.ok(shed.length > 0)
  const window = judgeProbeWindow(outcomes, judge())
  assert.equal(window.kind, 'retry')
  if (window.kind === 'retry') {
    assert.equal(window.loss.serverErrors, 0)
    assert.equal(window.loss.timedOut, 4)
    assert.ok(window.loss.shed > 0)
  }
})

test('a fast probe is issued on the period and is not shed', async () => {
  const ticks = clock()
  const outcomes = await runProbeSchedule({
    clock: ticks,
    dwellMs: 200,
    periodMs: 40,
    maxInFlight: 10,
    batch: 2,
    issue: seq => ({
      id: `probe-${seq}`,
      promise: Promise.resolve({ kind: 'responded', id: `probe-${seq}`, status: 200, ray: none(), latencyMs: 40, version: none() }),
    }),
    shed: seq => ({ kind: 'shed', id: `shed-${seq}` }),
    stop: () => {},
  })
  assert.equal(ticks.read(), 200)
  assert.equal(outcomes.filter(item => item.kind === 'shed').length, 0)
  assert.equal(outcomes.filter(item => item.kind === 'responded').length, 10)
})

test('10/128 above the loss rate does not fail a window under probe.minSamples', () => {
  const rollout = policy()
  const outcomes: ProbeOutcome[] = []
  for (let index = 0; index < 118; index += 1) outcomes.push(answered(`ok-${index}`, OLD, 50))
  for (let index = 0; index < 10; index += 1) outcomes.push({ kind: 'lost', id: `lost-${index}`, reason: 'network' })
  const window = judgeProbeWindow(outcomes, judge())
  assert.equal(window.loss.total, 128)
  assert.equal(window.loss.count, 10)
  assert.equal(window.loss.exceeded, true)
  assert.ok(window.loss.total < rollout.probe.minSamples)
  assert.equal(window.kind, 'ok')
})

test('the same stall on both versions re-runs the dwell and does not roll back', async () => {
  const rollout = policy()
  let dwells = 0
  let rolled = 0
  const waits: number[] = []
  const result = await runRamp(rollout, {
    now: () => 0,
    sleep: async ms => {
      waits.push(ms)
    },
    dwell: async () => {
      dwells += 1
      return { outcomes: dwells === 1 ? incident() : clean() }
    },
    applySplit: async () => null,
    observe: async () => at100(),
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.equal(dwells, rollout.probe.windowAttempts)
  assert.equal(rolled, 0)
  assert.equal(result.state.kind, 'complete')
  assert.deepEqual(waits, [rollout.probe.windowBackoffMs, rollout.ingestWaitMs])
})

test('a stall that is still there after the bounded re-runs holds and does not roll back', async () => {
  const rollout = policy()
  let dwells = 0
  let rolled = 0
  const result = await runRamp(rollout, {
    now: () => 0,
    sleep: async () => {},
    dwell: async () => {
      dwells += 1
      return { outcomes: incident() }
    },
    applySplit: async () => null,
    observe: async () => at100(),
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.equal(dwells, rollout.probe.windowAttempts)
  assert.equal(rolled, 0)
  assert.equal(result.state.kind, 'held')
  if (result.state.kind === 'held') {
    assert.equal(result.state.outcome, 'insufficient_samples')
    assert.match(result.state.reason, /harness\/network stall/)
    assert.match(result.state.reason, /not rolling back/)
    assert.match(result.state.reason, /0 server errors/)
  }
})

test('a 5xx on a responded probe still rolls back inside a stall window', async () => {
  const stalled = incident()
  stalled[0] = answered('old-500', OLD, 69_830, 500)
  let dwells = 0
  let rolled = 0
  const result = await runRamp(policy(), {
    now: () => 0,
    sleep: async () => {},
    dwell: async () => {
      dwells += 1
      return { outcomes: stalled }
    },
    applySplit: async () => null,
    observe: async () => at100(),
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.equal(dwells, 1)
  assert.equal(rolled, 1)
  assert.equal(result.state.kind, 'rolled-back')
  if (result.state.kind === 'rolled-back') assert.match(result.state.reason, /1 5xx on responded probes/)
})

test('a stall on only one version still fails the loss-rate gate', () => {
  const outcomes: ProbeOutcome[] = []
  for (let index = 0; index < 500; index += 1) {
    outcomes.push(answered(`old-${index}`, OLD, 50))
    outcomes.push(answered(`new-${index}`, NEW, 69_830))
  }
  for (let index = 0; index < 10; index += 1) outcomes.push({ kind: 'lost', id: `lost-${index}`, reason: 'network' })
  const window = judgeProbeWindow(outcomes, judge())
  assert.equal(window.kind, 'harness_fault')
})
