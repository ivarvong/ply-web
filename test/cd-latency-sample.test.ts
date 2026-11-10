// ply-web#73: a ramp step's latency figures come from its own probes, not from the live smoke that runs inside the 100%
// step's dwell. Counts, errors, 5xx and burn still read every invocation. Replayed on the measured window of CD run
// 2026-11-10T14-56-52-021Z (480225db): the step reported p99 696 ms; its probes alone were 14 ms.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { none, some } from '../src/option.ts'
import { parsePolicy, type RolloutPolicy } from '../scripts/cd/policy.ts'
import type { ProbeOutcome } from '../scripts/cd/probe.ts'
import { ALL_INVOCATIONS, latencySampleOf, observeAfterIngest, runRamp, type LatencySample, type Observation, type RampIo } from '../scripts/cd/ramp.ts'
import { scopedStats } from '../scripts/cd/stage-ramp.ts'
import { percentile, rayKey } from '../scripts/cd/telemetry.ts'

const VERSION = '480225db-d222-405a-a4ca-382bb7b9f4da'
type Row = readonly [string, number, number, string]
type Fixture = { readonly recorded: { readonly nextRequests: number; readonly nextWallP99: number; readonly nextCpuP99: number }; readonly probeRays: readonly string[]; readonly rows: readonly Row[] }
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/ramp-100-2026-11-10.json', import.meta.url), 'utf8')) as Fixture

/** A Workers Observability invocation event, in the shape `statsFromEvents` reads (the fields the real one carries). */
function invocation(ray: string, wall: number, cpu: number, opts: { readonly outcome: string; readonly status: number } = { outcome: 'ok', status: 200 }): Record<string, unknown> {
  return {
    $metadata: { id: `ev-${ray}`, requestId: `req-${ray}`, rayId: ray, type: 'cf-worker-event', service: 'ply', statusCode: opts.status },
    $workers: { eventType: 'fetch', outcome: opts.outcome, wallTimeMs: wall, cpuTimeMs: cpu, scriptVersion: { id: VERSION }, event: { response: { status: opts.status } } },
  }
}
const responded = (ray: string): ProbeOutcome => ({ kind: 'responded', id: `p-${ray}`, status: 200, ray: some(`${ray}-IAD`), latencyMs: 20, version: some(VERSION) })

test('latencySampleOf: the responded probes\' rays; lost, shed and ray-less probes are not in it; none at all is every invocation', () => {
  const outcomes: ProbeOutcome[] = [
    responded('a585f4159ae599a2'),
    { kind: 'responded', id: 'no-ray', status: 200, ray: none(), latencyMs: 20, version: some(VERSION) },
    { kind: 'lost', id: 'lost', reason: 'timed_out' },
    { kind: 'shed', id: 'shed' },
    responded('a585f4159ae599a3'),
  ]
  assert.deepEqual(latencySampleOf(outcomes), { kind: 'probes', rays: ['a585f4159ae599a2-IAD', 'a585f4159ae599a3-IAD'] })
  assert.deepEqual(latencySampleOf([{ kind: 'lost', id: 'x', reason: 'network' }]), ALL_INVOCATIONS)
  assert.deepEqual(latencySampleOf([]), ALL_INVOCATIONS)
})

test('rayKey joins a response header ray with the event ray: colo suffix and case do not matter; a non-ray is itself', () => {
  assert.equal(rayKey('A585F4159AE599A2-IAD'), 'a585f4159ae599a2')
  assert.equal(rayKey('a585f4159ae599a2'), 'a585f4159ae599a2')
  assert.equal(rayKey('not-a-ray'), 'not-a-ray')
})

test('scopedStats: latency from the probes only; requests, exceptions, errors and 5xx from every invocation', () => {
  const probes = ['a000000000000001', 'a000000000000002', 'a000000000000003']
  const events = [
    invocation(probes[0], 5, 2), invocation(probes[1], 7, 3), invocation(probes[2].toUpperCase(), 9, 4),
    invocation('b000000000000001', 6580, 14),                                                // a smoke write waiting on Artifacts
    invocation('b000000000000002', 1200, 30, { outcome: 'exception', status: 500 }),         // a smoke request that broke
    invocation('c000000000000001', 836, 162),                                                // a visual-smoke page
  ]
  const sample: LatencySample = { kind: 'probes', rays: probes.map(ray => `${ray}-EWR`) }
  const scoped = scopedStats(events, sample)
  assert.deepEqual([...scoped.stats.wallMs].sort((a, b) => a - b), [5, 7, 9])
  assert.deepEqual([...scoped.stats.cpuMs].sort((a, b) => a - b), [2, 3, 4])
  assert.equal(scoped.excluded, 3)
  assert.equal(scoped.landed, 3, 'the probes that reached the telemetry')
  const whole = scopedStats(events, ALL_INVOCATIONS)
  assert.equal(whole.excluded, 0)
  assert.equal(whole.landed, 6)
  assert.equal(whole.stats.wallMs.length, 6)
  // the gates read the same counts either way: a smoke failure is still the new version's failure
  for (const key of ['requests', 'invocations', 'exceptions', 'errors', 'fivexx', 'errorLogs'] as const) {
    assert.equal(scoped.stats[key], whole.stats[key], key)
  }
  assert.equal(scoped.stats.invocations, 6)
  assert.equal(scoped.stats.exceptions, 1)
  // probes that never reached the telemetry leave an empty latency sample, not a borrowed one
  const lost = scopedStats(events, { kind: 'probes', rays: ['d000000000000001-IAD'] })
  assert.deepEqual(lost.stats.wallMs, [])
  assert.equal(lost.stats.invocations, 6)
})

test('replay, run 2026-11-10T14-56-52-021Z 100% step: every invocation p99 812 ms; the probes\' p99 14 ms', () => {
  const events = FIXTURE.rows.map(([ray, wall, cpu]) => invocation(ray, wall, cpu))
  const all = scopedStats(events, ALL_INVOCATIONS)
  const probes = scopedStats(events, { kind: 'probes', rays: FIXTURE.probeRays })
  const report = {
    rows: FIXTURE.rows.length,
    probeRays: FIXTURE.probeRays.length,
    recordedAtRun: FIXTURE.recorded,
    allWallP99: percentile(all.stats.wallMs, 0.99),
    allCpuP99: percentile(all.stats.cpuMs, 0.99),
    probeSamples: probes.stats.wallMs.length,
    probeWallP99: percentile(probes.stats.wallMs, 0.99),
    probeCpuP99: percentile(probes.stats.cpuMs, 0.99),
    excluded: probes.excluded,
  }
  console.log(JSON.stringify(report))
  assert.equal(FIXTURE.rows.length, 2091)
  assert.equal(FIXTURE.probeRays.length, 2001)
  // the run's own figure (696 ms, from the 2,024 events ingested when it queried) is the same contamination
  assert.equal(FIXTURE.recorded.nextWallP99, 696)
  assert.equal(report.allWallP99, 779)
  assert.equal(report.probeSamples, 1962)
  assert.equal(report.probeWallP99, 14)
  assert.equal(report.probeCpuP99, 7)
  assert.equal(report.excluded, 129, '74 live-smoke requests and 55 visual-smoke pages')
  assert.equal(probes.landed, 1962)
  // the ingest wait's stop rule (98% of the 2,000 responded probes) against the run's own snapshot: 2,024 events met
  // it on the window's total, though only part of them were probes; counted on the sample it waits for the probes
  assert.ok(FIXTURE.recorded.nextRequests >= 2000 * 0.98)
  assert.ok(probes.landed >= 2000 * 0.98)
  // the excluded ones are the slow ones: every invocation over 100 ms is a smoke or visual request
  const slowProbe = probes.stats.wallMs.filter(ms => ms > 100)
  assert.deepEqual(slowProbe, [])
  // every probe invocation in the window is in the sample (the 39 missing of 2,001 never reached the query)
  assert.ok(probes.stats.invocations === all.stats.invocations)
})

function policy(): RolloutPolicy {
  return parsePolicy(readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')).policy
}

/** A healthy window routed exactly at `percent` (2,000 invocations). */
function sampleObservation(percent: number): Observation {
  const of = (n: number) => ({ requests: n, invocations: n, exceptions: 0, errors: 0, fivexx: 0, errorLogs: 0, wallMs: Array.from({ length: n }, () => 10), cpuMs: Array.from({ length: n }, () => 3), fetchMs: [], v1: [], internal: [] })
  const newer = Math.round(2000 * percent / 100)
  return { kind: 'sample', next: of(newer), previous: of(2000 - newer), aggregate: of(2000), landed: 2000 }
}

test('runRamp hands each step\'s observation the rays of that step\'s responded probes, and the line names the sample', async () => {
  const seen: Array<{ readonly percent: number; readonly sample: LatencySample }> = []
  let clock = 0
  let round = 0
  const io: RampIo = {
    now: () => clock,
    sleep: async ms => { clock += ms },
    dwell: async ms => {
      clock += ms
      round += 1
      const outcomes: ProbeOutcome[] = Array.from({ length: 2000 }, (_, i) => responded(`${round.toString(16).padStart(4, '0')}${i.toString(16).padStart(12, '0')}`))
      outcomes.push({ kind: 'lost', id: 'lost', reason: 'timed_out' })
      return { outcomes }
    },
    applySplit: async () => null,
    observe: async (_from, _to, percent, sample) => { seen.push({ percent, sample }); return sampleObservation(percent) },
    rollback: async () => null,
  }
  const ramp = await runRamp(policy(), io)
  assert.equal(ramp.state.kind, 'complete', JSON.stringify(ramp.state))
  const percents = policy().steps.map(step => step.percent)
  assert.deepEqual([...new Set(seen.map(s => s.percent))], percents)
  for (const s of seen) {
    assert.equal(s.sample.kind, 'probes')
    if (s.sample.kind === 'probes') {
      assert.equal(s.sample.rays.length, 2000, 'the responded probes, not the lost one')
      const step = percents.indexOf(s.percent) + 1
      assert.ok(s.sample.rays.every(ray => ray.startsWith(step.toString(16).padStart(4, '0'))), 'this step\'s probes only')
    }
  }
  for (const line of ramp.lines) assert.match(line, /latency_sample=probes/)
})

test('runRamp with no dwell (no probes) reads latency from every invocation and says so', async () => {
  const seen: LatencySample[] = []
  let clock = 0
  const io: RampIo = {
    now: () => clock,
    sleep: async ms => { clock += ms },
    applySplit: async () => null,
    observe: async (_from, _to, percent, sample) => { seen.push(sample); return sampleObservation(percent) },
    rollback: async () => null,
  }
  const ramp = await runRamp(policy(), io)
  assert.equal(ramp.state.kind, 'complete', JSON.stringify(ramp.state))
  assert.equal(seen.length, policy().steps.length)
  assert.ok(seen.every(sample => sample.kind === 'all'))
  for (const line of ramp.lines) assert.match(line, /latency_sample=all/)
})

test('the polled ingest wait counts the sample\'s probes, not the live checks\' requests beside them', async () => {
  const loss = { total: 2000, count: 0, rate: 0, maxLossRate: 0.01, exceeded: false, responded: 2000, serverErrors: 0, ids: [], timedOut: 0, aborted: 0, network: 0, shed: 0 }
  // each poll: 2,100 events in the window (smoke and visual included) but only 1,500 probes have landed, then 1,990
  let polls = 0
  let clock = 0
  const io = {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms },
    observe: async (): Promise<Observation> => {
      const base = sampleObservation(100)
      const n = polls < 2 ? 1500 : 1990
      polls += 1
      return base.kind === 'sample' ? { ...base, aggregate: { ...base.aggregate, invocations: 2100, requests: 2100 }, landed: n } : base
    },
  }
  const observed = await observeAfterIngest(policy(), io, 0, 0, 100, loss, { kind: 'probes', rays: ['a585f4159ae599a2-IAD'] })
  assert.equal(polls, 3, 'it kept waiting while 2,100 events held only 1,500 probes')
  assert.equal(observed.kind === 'sample' ? observed.landed : -1, 1990)
})
