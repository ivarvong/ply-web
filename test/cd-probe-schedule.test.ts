import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { none, some } from '../src/option.ts'
import { parsePolicy, type RolloutPolicy } from '../scripts/cd/policy.ts'
import { classifyProbe, judgeProbeWindow, type ProbeJudge, type ProbeOutcome } from '../scripts/cd/probe.ts'
import { runProbeSchedule, type ProbeClock } from '../scripts/cd/probe-schedule.ts'
import { NO_STALLS } from '../scripts/cd/client-health.ts'
import { runRamp, type Observation } from '../scripts/cd/ramp.ts'
import type { VersionStats } from '../scripts/cd/telemetry.ts'

const OLD = '4f3d7acf'
const NEW = '19ee3cab'

function policy(): RolloutPolicy {
  const raw = JSON.parse(readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')) as Record<string, unknown>
  raw.ingestPollMs = 0
  const parsed = parsePolicy(JSON.stringify(raw)).policy
  // A lone 100 step is not a loadable policy (ramp-only, 2026-11-08); the engine runs one here to isolate a single window.
  // Frozen test clocks need the fixed ingest sleep, and these windows were written against onHarnessFault rollback.
  return { ...parsed, steps: [{ percent: 100, dwellMs: 40_000 }], probe: { ...parsed.probe, onHarnessFault: 'rollback' } }
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
  return { kind: 'sample', next, previous: stats(0), aggregate: next, landed: next.invocations }
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
    graceMs: 0,
    health: NO_STALLS,
    extension: { maxMs: 0, minReal: 0 },
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
    graceMs: 0,
    health: NO_STALLS,
    extension: { maxMs: 0, minReal: 0 },
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
    graceMs: 0,
    health: NO_STALLS,
    extension: { maxMs: 0, minReal: 0 },
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

test('a probe in flight at the deadline answers within the grace and is not lost', async () => {
  // The last tick (t=80) is unanswered at the deadline (t=120); it answers once the grace wait has begun.
  let at = 0
  const late: (() => void)[] = []
  const ticks: ProbeClock = {
    now: () => at,
    sleep: async ms => {
      if (at >= 120) { for (const release of late.splice(0)) release(); await Promise.resolve(); return }
      at += ms
    },
  }
  let stopped = 0
  const outcomes = await runProbeSchedule({
    clock: ticks,
    dwellMs: 120,
    periodMs: 40,
    maxInFlight: 10,
    batch: 2,
    graceMs: 2000,
    health: NO_STALLS,
    extension: { maxMs: 0, minReal: 0 },
    issue: seq => {
      const answer: ProbeOutcome = { kind: 'responded', id: `probe-${seq}`, status: 200, ray: none(), latencyMs: 40, version: none() }
      if (seq <= 4) return { id: `probe-${seq}`, promise: Promise.resolve(answer) }
      return { id: `probe-${seq}`, promise: new Promise<ProbeOutcome>(resolve => { late.push(() => resolve(answer)) }) }
    },
    shed: seq => ({ kind: 'shed', id: `shed-${seq}` }),
    stop: () => {
      stopped += 1
    },
  })
  assert.equal(stopped, 1)
  assert.equal(outcomes.filter(item => item.kind === 'lost').length, 0)
  assert.equal(outcomes.filter(item => item.kind === 'responded').length, 6)
})

test('a probe still hung after the grace is timed_out and the dwell ends at deadline + grace', async () => {
  const ticks = clock()
  const outcomes = await runProbeSchedule({
    clock: ticks,
    dwellMs: 120,
    periodMs: 40,
    maxInFlight: 10,
    batch: 2,
    graceMs: 2000,
    health: NO_STALLS,
    extension: { maxMs: 0, minReal: 0 },
    issue: seq => ({ id: `probe-${seq}`, promise: new Promise<ProbeOutcome>(() => {}) }),
    shed: seq => ({ kind: 'shed', id: `shed-${seq}` }),
    stop: () => {},
  })
  assert.equal(ticks.read(), 2120)
  assert.equal(outcomes.filter(item => item.kind === 'lost').length, 6)
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
  // the policy's warm-up (the split reaching every edge) comes first, outside the judged window
  assert.deepEqual(waits, [...(rollout.warmupMs > 0 ? [rollout.warmupMs] : []), rollout.probe.windowBackoffMs, rollout.ingestWaitMs])
})

// ply-web#145: insufficient_samples is unjudged, so the step's traffic is settled through onHarnessFault (this file's policy: rollback).
test('a stall that is still there after the bounded re-runs is unjudged and rolls back to previous', async () => {
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
  assert.equal(rollout.probe.onHarnessFault, 'rollback')
  assert.equal(rolled, 1)
  assert.equal(result.state.kind, 'held')
  if (result.state.kind === 'held') {
    assert.equal(result.state.outcome, 'insufficient_samples')
    assert.equal('traffic' in result.state ? result.state.traffic : null, 'rolled_back')
    assert.match(result.state.reason, /harness\/network stall/)
    assert.doesNotMatch(result.state.reason, /not rolling back|prod untouched/)
    assert.match(result.state.reason, /0 server errors/)
    assert.match(result.state.reason, /rolled back to previous$/)
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

// ---- ply-web#145 review round 2: settle paths pinned (hand-derived expectations from the issue's acceptance criteria) ----

/** A sample whose routed share matches `percent`: 200 invocations split by the step's percentage. */
function atPercent(percent: number): Observation {
  const next = stats(2 * percent)
  const previous = stats(200 - 2 * percent)
  return { kind: 'sample', next, previous, aggregate: stats(200), landed: 200 }
}

function unhealthyWindow(): ProbeOutcome[] {
  const outcomes: ProbeOutcome[] = []
  for (let index = 0; index < 53; index += 1) outcomes.push(answered(`ok-${index}`, NEW, 50))
  outcomes.push({ kind: 'stalled', id: 'client-stall 0-53733 53733ms' })
  return outcomes
}

/** 75% passes on a clean window, then the 100% step gets `bad` on every attempt; onHarnessFault is `hold`. */
async function holdAfterPass(bad: () => ProbeOutcome[], rollback: () => Promise<null | string> = async () => null) {
  const base = policy()
  const rollout: RolloutPolicy = {
    ...base,
    steps: [{ percent: 75, dwellMs: 40_000 }, { percent: 100, dwellMs: 40_000 }],
    probe: { ...base.probe, onHarnessFault: 'hold' },
  }
  const counts = { rolled: 0, splits: [] as number[] }
  let current = 0
  const result = await runRamp(rollout, {
    now: () => 0,
    sleep: async () => {},
    dwell: async () => ({ outcomes: current === 75 ? clean() : bad() }),
    applySplit: async percent => {
      counts.splits.push(percent)
      current = percent
      return null
    },
    observe: async (_from, _to, percent) => atPercent(percent),
    rollback: async () => {
      counts.rolled += 1
      return rollback()
    },
  })
  return { result, counts }
}

for (const [name, bad, outcome] of [
  ['harness_unhealthy', unhealthyWindow, 'harness_unhealthy'],
  ['insufficient_samples', incident, 'insufficient_samples'],
] as const) {
  test(`hold: ${name} at 100% after 75% passed writes the split back to 75% and does not roll back`, async () => {
    const { result, counts } = await holdAfterPass(bad)
    assert.deepEqual(counts.splits, [75, 100, 75])
    assert.equal(counts.rolled, 0)
    assert.equal(result.rollbackError, null)
    assert.equal(result.state.kind, 'held')
    if (result.state.kind === 'held') {
      assert.equal(result.state.outcome, outcome)
      assert.equal('traffic' in result.state ? result.state.traffic : null, 'held')
      assert.match(result.state.reason, /; held at 75%$/)
      assert.doesNotMatch(result.state.reason, /prod untouched/)
    }
  })
}

test('a failed rollback of an unjudged 100% step says traffic is still at 100%, not that it rolled back', async () => {
  const rollout = { ...policy(), steps: [{ percent: 100, dwellMs: 40_000 }] }
  assert.equal(rollout.probe.onHarnessFault, 'rollback')
  const result = await runRamp(rollout, {
    now: () => 0,
    sleep: async () => {},
    dwell: async () => ({ outcomes: unhealthyWindow() }),
    applySplit: async () => null,
    observe: async () => at100(),
    rollback: async () => 'boom 503',
  })
  assert.equal(result.rollbackError, 'boom 503')
  assert.equal(result.state.kind, 'held')
  if (result.state.kind === 'held') {
    assert.equal('traffic' in result.state ? result.state.traffic : null, 'settle_failed')
    assert.doesNotMatch(result.state.reason, /rolled back to previous/)
    assert.match(result.state.reason, /; rollback to previous failed: boom 503; still at 100%$/)
  }
})

test('a failed hold write says the split is still at the stopped step', async () => {
  const base = policy()
  const rollout: RolloutPolicy = {
    ...base,
    steps: [{ percent: 75, dwellMs: 40_000 }, { percent: 100, dwellMs: 40_000 }],
    probe: { ...base.probe, onHarnessFault: 'hold' },
  }
  let current = 0
  let writes = 0
  const result = await runRamp(rollout, {
    now: () => 0,
    sleep: async () => {},
    dwell: async () => ({ outcomes: current === 75 ? clean() : unhealthyWindow() }),
    applySplit: async percent => {
      writes += 1
      if (writes === 3) return 'split 500'
      current = percent
      return null
    },
    observe: async (_from, _to, percent) => atPercent(percent),
    rollback: async () => null,
  })
  assert.equal(result.rollbackError, 'split 500')
  assert.equal(result.state.kind === 'held' && 'traffic' in result.state ? result.state.traffic : null, 'settle_failed')
  if (result.state.kind === 'held') assert.match(result.state.reason, /; hold at 75% failed: split 500; still at 100%$/)
})

// the ramp's at-0% branch: nothing to settle, and the reason says so
test('an unjudged step at 0% holds at 0% without a rollback', async () => {
  const rollout = { ...policy(), steps: [{ percent: 0, dwellMs: 40_000 }] }
  let rolled = 0
  const result = await runRamp(rollout, {
    now: () => 0,
    sleep: async () => {},
    dwell: async () => ({ outcomes: unhealthyWindow() }),
    applySplit: async () => null,
    observe: async () => atPercent(0),
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.equal(rolled, 0)
  assert.equal(result.state.kind === 'held' && 'traffic' in result.state ? result.state.traffic : null, 'held')
  if (result.state.kind === 'held') assert.match(result.state.reason, /; held at 0%$/)
})
