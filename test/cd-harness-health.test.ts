// Both 2026-11-10 harness faults, replayed: the pin straggler (run 2026-11-10T20-48-18-470Z, flags-rules served by
// 480225db 9.9 s after the 0% write) and the 53.7 s client stall (run 2026-11-10T20-54-06-051Z, 58 probes issued).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { some } from '../src/option.ts'
import { ClientHealth, gapStall, NO_STALLS, type Stall, type StallSource } from '../scripts/cd/client-health.ts'
import { parsePolicy, type RolloutPolicy } from '../scripts/cd/policy.ts'
import { classifyProbe, judgeProbeWindow, type ProbeJudge, type ProbeOutcome } from '../scripts/cd/probe.ts'
import { runProbeSchedule, type ProbeClock } from '../scripts/cd/probe-schedule.ts'
import { runRamp, type Observation } from '../scripts/cd/ramp.ts'
import { confirmRoute, coloOf, stragglers, sustainedFrom, type RouteIo, type RouteSample } from '../scripts/cd/route-confirm.ts'
import { harnessEvent, reissuable } from '../scripts/cd/stage-smoke.ts'
import type { VersionStats } from '../scripts/cd/telemetry.ts'

const OLD = '480225db'
const NEW = 'c8403e57'

// ---- client health ----

test('gapStall: a 100 ms tick is healthy, a wall or monotonic jump over the bound is a stall', () => {
  assert.equal(gapStall(0, 0, 100, 100, 1000), null)
  assert.equal(gapStall(0, 0, 1000, 1000, 1000), null)
  assert.deepEqual(gapStall(10, 0, 53_743, 100, 1000), { from: 10, to: 53_743, ms: 53_733 })
  // the guest monotonic clock jumps while the wall clock was stepped back by NTP: still a stall
  assert.deepEqual(gapStall(0, 0, 50, 5000, 1000), { from: 0, to: 5000, ms: 5000 })
})

test('ClientHealth records a stall and answers during / stalledMs by overlap', () => {
  let wall = 1_000
  let mono = 0
  const health = new ClientHealth({ wall: () => wall, mono: () => mono }, 1000, 100)
  wall += 100
  mono += 100
  assert.equal(health.check(), null)
  wall += 53_733
  mono += 53_733
  const stall = health.check()
  assert.deepEqual(stall, { from: 1_100, to: 54_833, ms: 53_733 })
  assert.equal(health.during(0, 1_000).length, 0)
  assert.equal(health.during(50_000, 60_000).length, 1)
  assert.equal(health.stalledMs(50_000, 60_000), 4_833)
  assert.equal(health.stalledMs(0, 100_000), 53_733)
  assert.equal(health.stalls().length, 1)
})

// ---- pin / route confirmation ----

function sample(at: number, round: number, version: string | null, status = 200): RouteSample {
  return { at, round, status, version, colo: 'IAD' }
}

test('sustainedFrom restarts at the round after a straggler', () => {
  const samples = [sample(1000, 1, NEW), sample(2000, 2, OLD), sample(2050, 2, NEW), sample(3000, 3, NEW), sample(4000, 4, NEW)]
  assert.equal(sustainedFrom(samples, NEW), 3000)
  assert.equal(sustainedFrom([...samples, sample(5000, 5, NEW, 0)], NEW), null)
  assert.equal(stragglers(samples, NEW).length, 1)
  assert.equal(coloOf('a587ec564e0da476-IAD'), 'IAD')
  assert.equal(coloOf(null), null)
})

/** A fake edge: requests before `cutoverMs` after the write sometimes reach a machine without the new deployment. */
function edge(cutoverMs: number, version: (at: number, n: number) => string | null, status = 200): RouteIo & { calls: number } {
  let now = 0
  let n = 0
  const io = {
    calls: 0,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
    },
    get: async () => {
      n += 1
      io.calls += 1
      now += 1
      return { status, version: version(now, n), ray: `ray${n}-${n % 2 === 0 ? 'IAD' : 'EWR'}` }
    },
  }
  void cutoverMs
  return io
}

const TUNABLES = { batch: 10, intervalMs: 1000, sustainMs: 10_000, maxMs: 120_000, requestMs: 2000 }

test('replay 20-48-18: the old five-in-a-row check passed at +5 s, the straggler at +9.9 s; the sustained check confirms only after it', async () => {
  // one old answer in a hundred until +9.9 s, exactly the shape the 2026-11-10 run saw
  const io = edge(9_900, (at, n) => (at <= 9_900 && n % 37 === 0 ? OLD : NEW))
  const verdict = await confirmRoute({ url: 'https://x/', version: NEW, headers: {}, since: 0 }, io, TUNABLES)
  assert.equal(verdict.kind, 'confirmed')
  if (verdict.kind !== 'confirmed') return
  const late = stragglers(verdict.samples, NEW)
  assert.ok(late.length > 0)
  const lastLate = Math.max(...late.map(item => item.at))
  assert.ok(verdict.sustainedFrom > lastLate, `sustained window ${verdict.sustainedFrom} must start after the last straggler ${lastLate}`)
  assert.ok(verdict.at - verdict.sustainedFrom >= TUNABLES.sustainMs)
  assert.ok(verdict.samples.length >= 100)
})

test('a version that never settles is routing (harness), not a product failure', async () => {
  const io = edge(Infinity, (_at, n) => (n % 50 === 0 ? OLD : NEW))
  const verdict = await confirmRoute({ url: 'https://x/', version: NEW, headers: {}, since: 0 }, io, TUNABLES)
  assert.equal(verdict.kind, 'routing')
  if (verdict.kind === 'routing') assert.match(verdict.reason, /^routing: /)
})

test('answers with no x-ply-version at all are the Worker', async () => {
  const io = edge(0, () => null)
  const verdict = await confirmRoute({ url: 'https://x/', version: NEW, headers: {}, since: 0 }, io, TUNABLES)
  assert.equal(verdict.kind, 'worker')
})

test('lost answers never confirm a route', async () => {
  const io = edge(0, () => null, 0)
  const verdict = await confirmRoute({ url: 'https://x/', version: NEW, headers: {}, since: 0 }, io, TUNABLES)
  assert.equal(verdict.kind, 'routing')
})

// ---- smoke row attribution ----

function stalls(list: readonly Stall[]): StallSource {
  const overlap = (stall: Stall, from: number, to: number) => Math.max(0, Math.min(stall.to, to) - Math.max(stall.from, from))
  return {
    check: () => null,
    during: (from, to) => list.filter(stall => overlap(stall, from, to) > 0),
    stalledMs: (from, to) => list.reduce((sum, stall) => sum + overlap(stall, from, to), 0),
  }
}

test('a smoke row served by another version is a routing event, never a pass or a product failure', () => {
  const event = harnessEvent({ started: 0, ended: 50, served: OLD, status: 200 }, NEW, NO_STALLS)
  assert.equal(event && event.kind, 'wrong_version')
  assert.equal(harnessEvent({ started: 0, ended: 50, served: NEW, status: 200 }, NEW, NO_STALLS), null)
  // no header at all is the Worker's to answer for (judged by the row), not routing
  assert.equal(harnessEvent({ started: 0, ended: 50, served: null, status: 200 }, NEW, NO_STALLS), null)
  // the 2026-11-10 replay: flags-rules answered by 480225db
  const replay = harnessEvent({ started: 9_800, ended: 9_900, served: OLD, status: 200 }, NEW, NO_STALLS)
  assert.ok(replay && replay.kind === 'wrong_version' && replay.served === OLD)
})

test('a lost smoke row across a client stall is a client_stall event; without a stall it stays a loss', () => {
  const source = stalls([{ from: 1_000, to: 54_733, ms: 53_733 }])
  const event = harnessEvent({ started: 500, ended: 55_000, served: null, status: 0 }, NEW, source)
  assert.ok(event && event.kind === 'client_stall' && event.stalledMs === 53_733)
  assert.equal(harnessEvent({ started: 60_000, ended: 62_000, served: null, status: 0 }, NEW, source), null)
})

test('only GETs are re-issued; a write restarts the lifecycle', () => {
  assert.equal(reissuable({ method: 'GET' }), true)
  assert.equal(reissuable({ method: 'POST' }), false)
  assert.equal(reissuable({ method: 'DELETE' }), false)
})

// ---- probe schedule extension ----

function policy(): RolloutPolicy {
  const raw = JSON.parse(readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')) as Record<string, unknown>
  raw.ingestPollMs = 0
  const parsed = parsePolicy(JSON.stringify(raw)).policy
  return { ...parsed, steps: [{ percent: 100, dwellMs: 40_000 }] }
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

function answered(id: string, version: string, latencyMs: number, status = 200): ProbeOutcome {
  return classifyProbe(id, { kind: 'response', status, ray: some('ray'), latencyMs, version: some(version) })
}

/**
 * A process that freezes for `pauseMs` at `pauseAt`: the clock jumps, the monitor (driven by the same clock) sees it,
 * and the probes in flight across it never answer. Probes issued otherwise answer after `latencyMs`.
 */
function frozenBox(pauseAt: number, pauseMs: number, latencyMs: number) {
  let at = 0
  let paused = false
  const seen: Stall[] = []
  let last = 0
  const health: StallSource = {
    check: () => {
      if (at - last > 1000) {
        const stall = { from: last, to: at, ms: at - last }
        seen.push(stall)
        last = at
        return stall
      }
      last = at
      return null
    },
    during: (from, to) => seen.filter(stall => Math.min(stall.to, to) - Math.max(stall.from, from) > 0),
    stalledMs: (from, to) => seen.reduce((sum, stall) => sum + Math.max(0, Math.min(stall.to, to) - Math.max(stall.from, from)), 0),
  }
  const waiting: { due: number; resolve: () => void }[] = []
  const clock: ProbeClock = {
    now: () => at,
    sleep: async ms => {
      // the monitor ticks every 100 ms while the process runs; a freeze is one jump it sees afterwards
      let left = ms
      while (left > 0) {
        if (!paused && at + Math.min(left, 100) > pauseAt) {
          paused = true
          at += pauseMs
        }
        const step = Math.min(left, 100)
        at += step
        left -= step
        health.check()
      }
      for (const item of waiting.splice(0)) {
        if (item.due <= at) item.resolve()
        else waiting.push(item)
      }
      await Promise.resolve()
    },
  }
  const issue = (seq: number) => {
    const issuedAt = at
    const crosses = !paused && issuedAt + latencyMs > pauseAt
    const promise = new Promise<ProbeOutcome>(resolve => {
      // its client timeout fires as soon as the process runs again: a timed_out loss, unless the stall is seen
      if (crosses) {
        waiting.push({ due: issuedAt + 2000, resolve: () => resolve({ kind: 'lost', id: `p-${seq}`, reason: 'timed_out' }) })
        return
      }
      waiting.push({ due: issuedAt + latencyMs, resolve: () => resolve(answered(`p-${seq}`, NEW, latencyMs)) })
    })
    return { id: `p-${seq}`, promise }
  }
  return { clock, health, issue, read: () => at, seen }
}

test('replay 20-54-06: a 53.7 s freeze mid-dwell extends the window to minSamples real samples and nothing is lost', async () => {
  const rollout = policy()
  const box = frozenBox(5_000, 53_733, 50)
  const outcomes = await runProbeSchedule({
    clock: box.clock,
    dwellMs: 40_000,
    periodMs: 1000 / rollout.probe.rps,
    maxInFlight: rollout.probe.maxInFlight,
    batch: 2,
    graceMs: rollout.probe.timeoutMs,
    health: box.health,
    extension: { maxMs: 120_000, minReal: rollout.probe.minSamples },
    issue: box.issue,
    shed: seq => ({ kind: 'shed', id: `shed-${seq}` }),
    stop: () => {},
  })
  const window = judgeProbeWindow(outcomes, judge())
  assert.equal(box.seen.length, 1)
  assert.ok(window.loss.stalled >= 1)
  assert.equal(window.loss.count, 0, 'probes in flight across the freeze are stalled, not lost')
  assert.equal(window.loss.shed, 0, 'missed ticks are skipped, not burst into sheds')
  assert.ok(window.loss.total >= rollout.probe.minSamples, `${window.loss.total} real samples`)
  assert.equal(window.kind, 'ok')
  // the dwell ran its 40 s of healthy time plus the freeze, not more than the cap
  assert.ok(box.read() >= 40_000 + 53_733 && box.read() <= 40_000 + 120_000 + rollout.probe.timeoutMs + 1000)
})

test('a freeze longer than the extension cap is harness_unhealthy, never a product verdict', async () => {
  const rollout = policy()
  const box = frozenBox(5_000, 400_000, 50)
  const outcomes = await runProbeSchedule({
    clock: box.clock,
    dwellMs: 40_000,
    periodMs: 1000 / rollout.probe.rps,
    maxInFlight: rollout.probe.maxInFlight,
    batch: 2,
    graceMs: rollout.probe.timeoutMs,
    health: box.health,
    extension: { maxMs: 120_000, minReal: rollout.probe.minSamples },
    issue: box.issue,
    shed: seq => ({ kind: 'shed', id: `shed-${seq}` }),
    stop: () => {},
  })
  const window = judgeProbeWindow(outcomes, judge())
  assert.equal(window.kind, 'harness_unhealthy')
  assert.match(window.kind === 'harness_unhealthy' ? window.reason : '', /^harness unhealthy, prod untouched/)
})

test('without a stall the dwell is not extended', async () => {
  const rollout = policy()
  const box = frozenBox(Infinity, 0, 50)
  await runProbeSchedule({
    clock: box.clock,
    dwellMs: 10_000,
    periodMs: 1000 / rollout.probe.rps,
    maxInFlight: rollout.probe.maxInFlight,
    batch: 2,
    graceMs: rollout.probe.timeoutMs,
    health: box.health,
    extension: { maxMs: 120_000, minReal: rollout.probe.minSamples },
    issue: box.issue,
    shed: seq => ({ kind: 'shed', id: `shed-${seq}` }),
    stop: () => {},
  })
  assert.equal(box.seen.length, 0)
  // the dwell plus at most the in-flight grace, never the 120 s extension
  assert.ok(box.read() <= 10_000 + rollout.probe.timeoutMs + 100, String(box.read()))
})

test('judge: stalled probes leave the denominator; a served 5xx still rolls back', () => {
  const outcomes: ProbeOutcome[] = []
  for (let index = 0; index < 53; index += 1) outcomes.push(answered(`ok-${index}`, NEW, 50))
  for (let index = 0; index < 5; index += 1) outcomes.push({ kind: 'stalled', id: `s-${index}` })
  const unhealthy = judgeProbeWindow(outcomes, judge())
  assert.equal(unhealthy.kind, 'harness_unhealthy')
  assert.equal(unhealthy.loss.total, 53)
  assert.equal(unhealthy.loss.count, 0)
  const withFive = [...outcomes, answered('five', NEW, 50, 500)]
  assert.equal(judgeProbeWindow(withFive, judge()).kind, 'rollback')
  const enough: ProbeOutcome[] = []
  for (let index = 0; index < judge().minSamples; index += 1) enough.push(answered(`ok-${index}`, NEW, 50))
  enough.push({ kind: 'stalled', id: 'client-stall' })
  assert.equal(judgeProbeWindow(enough, judge()).kind, 'ok')
})

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

test('runRamp: an unhealthy client holds the split where it is, with no rollback and no split write', async () => {
  const rollout = policy()
  let rolled = 0
  let splits = 0
  let dwells = 0
  const outcomes: ProbeOutcome[] = []
  for (let index = 0; index < 53; index += 1) outcomes.push(answered(`ok-${index}`, NEW, 50))
  outcomes.push({ kind: 'stalled', id: 'client-stall 0-53733 53733ms' })
  const result = await runRamp(rollout, {
    now: () => 0,
    sleep: async () => {},
    dwell: async () => {
      dwells += 1
      return { outcomes }
    },
    applySplit: async () => {
      splits += 1
      return null
    },
    observe: async (): Promise<Observation> => {
      const next = stats(200)
      return { kind: 'sample', next, previous: stats(0), aggregate: next, landed: 200 }
    },
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.equal(rolled, 0)
  assert.equal(splits, 1)
  assert.equal(dwells, 1)
  assert.equal(result.state.kind, 'held')
  if (result.state.kind === 'held') {
    assert.equal(result.state.outcome, 'harness_unhealthy')
    assert.match(result.state.reason, /^harness unhealthy, prod untouched/)
  }
})
