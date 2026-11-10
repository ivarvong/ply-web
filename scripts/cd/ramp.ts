import { assertNever } from '../../src/never.ts'
import { none, some, type Option } from '../../src/option.ts'
import { compareStep, observedBasis, observeStep, predictStep, probeBasis, type ForecastBasis, type ForecastCheck } from './forecast.ts'
import { asRecord } from './json.ts'
import type { ObservationRef } from './log.ts'
import type { RolloutPolicy } from './policy.ts'
import { emptyProbeLoss, judgeProbeWindow, type ProbeJudge, type ProbeLoss, type ProbeOutcome, type ProbeWindow } from './probe.ts'
import { percentile, type VersionStats } from './telemetry.ts'
import { burnMap, CARRY_WALL_SAMPLES, judgeStep, routedShare, type RoutedShare, type StepVerdict } from './slo.ts'

export type { VersionStats } from './telemetry.ts'

/**
 * Which invocations a step's latency figures (wall and CPU p99, the forecast's wall delta) are read from. Counts, errors,
 * 5xx, burn and routed share always come from every invocation of the window; only latency is scoped.
 *
 * `probes`: the step's own responded probes, joined on cf-ray. The ramp's probes are the one traffic the harness controls
 * at every step, so the figure means the same thing at 10% and at 100%. At 100% the live smoke, the visual smoke and the
 * rate gate run inside the dwell (pipeline.ts `liveChecks`); their writes wait on Artifacts. Measured on run
 * 2026-11-10T14-56-52-021Z (480225db, the 100% step's query window 15:04:07.9Z to 15:05:47.9Z, re-queried read-only on
 * 2026-11-10): 2,091 external invocations of the new version, of which 1,962 probes (wall p99 14 ms, cpu p99 7), 74
 * live-smoke requests (p99 6,580 ms, the slowest POST /v1/branch) and 55 GET /view from the visual smoke (p99 836 ms).
 * The step reported p99 696 ms from all of them; its probes alone were 14 ms, beside 76/40/49/15 ms at 10..75%.
 * `all`: no probe answered with a ray (no dwell, or every probe lost): every invocation, and the line says so.
 */
export type LatencySample =
  | { readonly kind: 'probes'; readonly rays: readonly string[] }
  | { readonly kind: 'all'; readonly reason: 'no_probe_rays' }

export const ALL_INVOCATIONS: LatencySample = { kind: 'all', reason: 'no_probe_rays' }

/** The responded probes' cf-rays, or every invocation when there are none. */
export function latencySampleOf(outcomes: readonly ProbeOutcome[]): LatencySample {
  const rays: string[] = []
  for (const outcome of outcomes) {
    if (outcome.kind === 'responded' && outcome.ray.tag === 'some') rays.push(outcome.ray.value)
  }
  return rays.length > 0 ? { kind: 'probes', rays } : ALL_INVOCATIONS
}

export type Observation =
  | { readonly kind: 'unavailable'; readonly reason: string; readonly ref?: ObservationRef }
  | {
    readonly kind: 'sample'
    readonly next: VersionStats
    readonly previous: VersionStats
    readonly aggregate: VersionStats
    /**
     * The window's invocations of the latency sample (LatencySample): with `probes`, the probes that have reached the
     * telemetry; with `all`, every external invocation. The polled ingest wait counts these: at 100% the live checks'
     * own requests are in `aggregate`, and counting them stopped the wait on 2,024 events of which only about 1,950
     * were probes (run 2026-11-10T14-56-52-021Z; 2,091 had landed when re-queried).
     */
    readonly landed: number
    readonly ref?: ObservationRef
  }

/** A query the ramp could not run. This is not a rollback: no observed burn or error was seen. */
export type HarnessRamp = {
  readonly outcome: 'harness_fault'
  readonly reason: string
  readonly rules: StepVerdict['rules']
  readonly burns: StepVerdict['burns']
}

export type ProbeSampleDecision = {
  readonly outcome: 'insufficient_samples'
  readonly reason: string
  readonly rules: StepVerdict['rules']
  readonly burns: StepVerdict['burns']
}

export type RampDecision = StepVerdict | HarnessRamp | ProbeSampleDecision

export type HeldWrite = { readonly kind: 'state_conflict'; readonly reason: string }

export type HarnessTraffic = 'rolled_back' | 'held'

export type RampState =
  | { readonly kind: 'ramping'; readonly step: number }
  | { readonly kind: 'rolled-back'; readonly reason: string }
  | { readonly kind: 'stopped'; readonly reason: string; readonly fault: 'state_conflict' }
  | { readonly kind: 'stopped'; readonly reason: string; readonly fault: 'harness_fault'; readonly traffic: HarnessTraffic }
  | { readonly kind: 'held'; readonly reason: string; readonly outcome: 'hold' | 'insufficient_data' | 'insufficient_samples' }
  | { readonly kind: 'complete' }

export function rampStart(): RampState {
  return { kind: 'ramping', step: 0 }
}

/**
 * A query that never returned. Probes that already answered are the correctness signal:
 * a 5xx is a rollback when that gate is hard, and a clean probe window advances. The
 * missing series is named on the reason and is not treated as zero errors. With no
 * probe sample there is nothing to judge, so the step stays a harness fault.
 */
export function decideWithoutTelemetry(probes: ProbeLoss | null, policy: RolloutPolicy, reason: string): RampDecision {
  if (probes === null || probes.total === 0) {
    return {
      outcome: 'harness_fault',
      reason,
      rules: [{ name: 'telemetry_required', value: 1 }],
      burns: burnMap([]),
    }
  }
  if (probes.serverErrors > 0 && policy.gates.fivexx === 'hard') {
    return {
      outcome: 'rollback',
      reason: `${probes.serverErrors} 5xx on responded probes; telemetry query lost; ${reason}`,
      rules: [{ name: 'max_new_5xx', value: 0 }],
      burns: burnMap([]),
    }
  }
  return {
    outcome: 'advance',
    reason: `informational: telemetry query lost; ${probes.responded} responded probes, ${probes.serverErrors} server errors; ${reason}`,
    rules: [
      { name: 'telemetry.query.attempts', value: policy.telemetry.query.attempts },
      { name: 'probe_responded', value: probes.responded },
    ],
    burns: burnMap([]),
  }
}

/** One ramp step. A returned sample is judged as usual. A lost query uses the probe statuses. */
export function decideRampStep(
  obs: Observation,
  policy: RolloutPolicy,
  targetPercent: number,
  probes: ProbeLoss | null = null,
): RampDecision {
  if (obs.kind === 'unavailable') return decideWithoutTelemetry(probes, policy, obs.reason)
  return judgeStep({
    next: obs.next,
    previous: obs.previous,
    aggregate: obs.aggregate,
    targetPercent,
    policy,
  })
}

/** Advance on a clean step. A terminal state stays terminal. Traffic for a harness fault is settled by `runRamp`. */
export function applyRamp(state: RampState, decision: RampDecision, stepCount: number): RampState {
  if (state.kind !== 'ramping') return state
  if (decision.outcome === 'harness_fault') return { kind: 'stopped', reason: decision.reason, fault: 'harness_fault', traffic: 'held' }
  if (decision.outcome === 'rollback') return { kind: 'rolled-back', reason: decision.reason }
  if (decision.outcome === 'hold' || decision.outcome === 'insufficient_data' || decision.outcome === 'insufficient_samples') {
    return { kind: 'held', reason: decision.reason, outcome: decision.outcome }
  }
  const next = state.step + 1
  if (next >= stepCount) return { kind: 'complete' }
  return { kind: 'ramping', step: next }
}

function fixedRate(count: number, total: number): string {
  if (total <= 0) return '-'
  return (count / total).toFixed(4)
}

function p99(values: readonly number[] | undefined): string {
  if (!values) return '-'
  const value = percentile(values, 0.99)
  return value === null ? '-' : String(Math.round(value))
}

function points(fraction: number | null): string {
  if (fraction === null) return '-'
  return (fraction * 100).toFixed(2)
}

function tolerance(share: RoutedShare): string {
  if (share.low === null || share.high === null) return '-'
  return `${points(share.low)}..${points(share.high)}`
}

function entrypointList(rows: VersionStats['internal'] | undefined): string {
  if (!rows || rows.length === 0) return ''
  return rows.map(row => `${row.entrypoint}:${row.count}`).join(',')
}

/** Named-entrypoint fetches, display only. Empty when this window had none. */
function internalNote(next: VersionStats | null, previous: VersionStats | null): string {
  const newer = entrypointList(next?.internal)
  const older = entrypointList(previous?.internal)
  const nextField = newer === '' ? '' : ` internal_next=${newer}`
  const previousField = older === '' ? '' : ` internal_previous=${older}`
  return `${nextField}${previousField}`
}

/** One line an operator can paste. `step` is 1-based. Sample counts are external fetches in this window. Carried p99 is display only. */
export function progressLine(input: {
  readonly step: number
  readonly steps: number
  readonly percent: number
  readonly next: VersionStats | null
  readonly previous: VersionStats | null
  readonly carriedPrevious: VersionStats | null
  readonly share: RoutedShare
  readonly decision: RampDecision
  readonly latency: RolloutPolicy['gates']['latency']['mode']
  readonly probe: { readonly kind: 'none' } | { readonly kind: 'measured'; readonly loss: ProbeLoss }
  readonly sample: LatencySample
}): string {
  const previousPercent = input.percent >= 100 ? 0 : 100 - input.percent
  const samples = `${input.next?.requests ?? '-'}/${input.previous?.requests ?? '-'}`
  const errors = `${input.next ? fixedRate(input.next.errors, input.next.requests) : '-'}/${input.previous ? fixedRate(input.previous.errors, input.previous.requests) : '-'}`
  const oldWalls = input.carriedPrevious?.wallMs ?? input.previous?.wallMs
  const oldCpu = input.carriedPrevious?.cpuMs ?? input.previous?.cpuMs
  const walls = `${p99(input.next?.wallMs)}/${p99(oldWalls)}`
  const cpu = `${p99(input.next?.cpuMs)}/${p99(oldCpu)}`
  const latency = input.latency === 'off' ? '' : ` p99_wall_ms=${walls} p99_cpu_ms=${cpu} latency=${input.latency} latency_sample=${input.sample.kind}`
  const routed = `routed_share=${points(input.share.share)} target=${input.percent} tolerance=${tolerance(input.share)} agg=${input.share.n}`
  const internal = internalNote(input.next, input.previous)
  const probe = input.probe.kind === 'measured'
    ? ` probe_loss=${input.probe.loss.count}/${input.probe.loss.total} timed_out=${input.probe.loss.timedOut} shed=${input.probe.loss.shed}`
    : ''
  const head = `ramp step=${input.step}/${input.steps} percent=${input.percent} previous=${previousPercent} samples=${samples} error_rate=${errors} ${routed}${internal}${latency}${probe} decision=${input.decision.outcome}`
  const carried = input.carriedPrevious ? ' previous_sample=carried' : ''
  const informational = input.decision.outcome === 'advance' && input.decision.reason.includes('informational:')
  if (input.decision.outcome === 'advance' && !informational) return head + carried
  const reason = input.decision.reason.replace(/[\n\r"]/g, "'")
  return `${head}${carried} reason="${reason}"`
}

export function readPassVerdict(text: string, version: string): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return { ok: false, reason: 'verdict is not JSON' }
  }
  const rec = asRecord(value)
  if (!rec) return { ok: false, reason: 'verdict is not an object' }
  if (rec.version !== version) return { ok: false, reason: `verdict is for ${String(rec.version)}, not ${version}` }
  if (Array.isArray(rec.failures) && rec.failures.length > 0) return { ok: false, reason: 'verdict has failures' }
  if (rec.kind === 'pass' || rec.pass === true) return { ok: true }
  return { ok: false, reason: 'verdict is not a pass' }
}

export type RampIo = {
  now(): number
  sleep(ms: number): Promise<void>
  /** Probe during the dwell. When omitted, `sleep` is the whole dwell and no probe sample is judged. */
  dwell?(ms: number, percent: number): Promise<{ readonly outcomes: readonly ProbeOutcome[] }>
  applySplit(percent: number): Promise<null | string | HeldWrite>
  /** `sample` scopes the latency figures only (LatencySample); every count and gate reads the whole window. */
  observe(from: number, to: number, percent: number, sample: LatencySample): Promise<Observation>
  /** Called once a step's split is written (or already in place). The pipeline starts the live checks at 100% here. */
  onApplied?(percent: number): void
  /** Called with the observation ref. A missing ref is a bug: a decision without an observation. */
  onDecision?(ref: ObservationRef, decision: RampDecision, percent: number): Promise<void>
  rollback(): Promise<null | string | HeldWrite>
}

export type RampStepRecord = {
  readonly percent: number
  readonly burns: RampDecision['burns']
  readonly outcome: RampDecision['outcome']
  readonly line: string
  readonly probeLoss: ProbeLoss
  /** What the step predicted next to what it saw (scripts/cd/forecast.ts). Null when the step had no telemetry sample. */
  readonly forecast: ForecastCheck | null
}

export type RampLoopResult = {
  readonly state: RampState
  readonly lines: readonly string[]
  readonly rollbackError: string | null
  readonly steps: readonly RampStepRecord[]
}

/**
 * Step the policy. At 100% the previous version is no longer allocated, so the old
 * wall and CPU numbers are the last step whose old version had enough wall samples.
 */
function asConflict(value: null | string | HeldWrite): HeldWrite | null {
  if (value && typeof value === 'object') return value
  return null
}

const UNTESTED_SHARE: RoutedShare = { n: 0, newRequests: 0, share: null, low: null, high: null, kind: 'untested' }

type Settled = { readonly state: RampState; readonly rollbackError: string | null }

async function rollbackTraffic(io: RampIo, reason: string): Promise<Settled> {
  const rolled = await io.rollback()
  const conflict = asConflict(rolled)
  if (conflict) return { state: { kind: 'stopped', reason: conflict.reason, fault: 'state_conflict' }, rollbackError: null }
  return {
    state: { kind: 'stopped', reason, fault: 'harness_fault', traffic: 'rolled_back' },
    rollbackError: typeof rolled === 'string' ? rolled : null,
  }
}

/** A harness fault above 0% rolls back to `previous`, or holds the last fully passed split. */
async function settleHarnessFault(
  policy: RolloutPolicy,
  io: RampIo,
  percent: number,
  reason: string,
  lastPassed: Option<number>,
): Promise<Settled> {
  if (percent <= 0) return { state: { kind: 'stopped', reason, fault: 'harness_fault', traffic: 'held' }, rollbackError: null }
  switch (policy.probe.onHarnessFault) {
    case 'rollback':
    // A telemetry-unavailable fault under `telemetry` has nothing left to judge on: restore the previous version.
    case 'telemetry':
      return rollbackTraffic(io, reason)
    case 'hold': {
      if (lastPassed.tag === 'none' || lastPassed.value <= 0) return rollbackTraffic(io, reason)
      const held = await io.applySplit(lastPassed.value)
      const conflict = asConflict(held)
      if (conflict) return { state: { kind: 'stopped', reason: conflict.reason, fault: 'state_conflict' }, rollbackError: null }
      if (typeof held === 'string') {
        return {
          state: { kind: 'stopped', reason: `${reason}; hold at ${lastPassed.value}% failed: ${held}`, fault: 'harness_fault', traffic: 'held' },
          rollbackError: held,
        }
      }
      return { state: { kind: 'stopped', reason, fault: 'harness_fault', traffic: 'held' }, rollbackError: null }
    }
    default:
      return assertNever(policy.probe.onHarnessFault)
  }
}

function withProbeRules(decision: RampDecision, loss: ProbeLoss): RampDecision {
  return {
    ...decision,
    rules: [
      ...decision.rules,
      { name: 'probe_loss_count', value: loss.count },
      { name: 'probe_loss_rate', value: loss.rate },
      { name: 'probe_timed_out', value: loss.timedOut },
      { name: 'probe_shed', value: loss.shed },
    ],
  }
}

function probeJudge(policy: RolloutPolicy): ProbeJudge {
  return {
    maxLossRate: policy.probe.maxLossRate,
    respondedMin: policy.burn.minSamples,
    minSamples: policy.probe.minSamples,
    stallLatencyMs: policy.probe.stallLatencyMs,
    fivexxHard: policy.gates.fivexx === 'hard',
  }
}

function probeWindowDecision(policy: RolloutPolicy, window: ProbeWindow): RampDecision {
  switch (window.kind) {
    case 'harness_fault':
      return {
        outcome: 'harness_fault',
        reason: window.reason,
        rules: [{ name: 'probe_max_loss_rate', value: policy.probe.maxLossRate }],
        burns: burnMap([]),
      }
    case 'insufficient_samples':
      return {
        outcome: 'insufficient_samples',
        reason: window.reason,
        rules: [{ name: 'probe_min_samples', value: policy.probe.minSamples }],
        burns: burnMap([]),
      }
    case 'rollback':
      return {
        outcome: 'rollback',
        reason: window.reason,
        rules: [{ name: 'max_new_5xx', value: 0 }],
        burns: burnMap([]),
      }
    case 'retry':
      return {
        outcome: 'insufficient_samples',
        reason: window.reason,
        rules: [{ name: 'probe_window_attempts', value: policy.probe.windowAttempts }],
        burns: burnMap([]),
      }
    case 'ok':
      throw new Error('an ok probe window is not a fault')
    default:
      return assertNever(window)
  }
}

/** A stalled dwell is re-run up to `windowAttempts`. The last retry becomes a hold, not a rollback. */
async function probeWindows(
  policy: RolloutPolicy,
  io: RampIo,
  dwell: (ms: number, percent: number) => Promise<{ readonly outcomes: readonly ProbeOutcome[] }>,
  dwellMs: number,
  percent: number,
): Promise<{ readonly window: ProbeWindow; readonly sample: LatencySample }> {
  const judge = probeJudge(policy)
  let window: ProbeWindow = { kind: 'ok', loss: emptyProbeLoss(policy.probe.maxLossRate) }
  let retryReason = 'harness/network stall'
  const limit = policy.probe.windowAttempts
  // every attempt's probes are in the step's observed window (it opens before the first), so all of them are the sample
  const outcomes: ProbeOutcome[] = []
  let attempt = 0
  while (attempt < limit) {
    attempt += 1
    const probed = await dwell(dwellMs, percent)
    outcomes.push(...probed.outcomes)
    window = judgeProbeWindow(probed.outcomes, judge)
    if (window.kind !== 'retry') return { window, sample: latencySampleOf(outcomes) }
    retryReason = window.reason
    if (attempt < limit && policy.probe.windowBackoffMs > 0) await io.sleep(policy.probe.windowBackoffMs)
  }
  return {
    window: {
      kind: 'insufficient_samples',
      loss: window.loss,
      reason: `${retryReason}; ${limit} windows exhausted; ${window.loss.serverErrors} server errors, not rolling back`,
    },
    sample: latencySampleOf(outcomes),
  }
}

/**
 * Wait for the dwell's tail to be ingested, then observe. With `ingestPollMs` the window is
 * re-queried every period until the worker has logged as many invocations as probes answered
 * (they are the bulk of the window) or `ingestWaitMs` has passed; without it, one fixed sleep.
 * Without probes there is no count to wait for, so the full wait runs.
 */
export async function observeAfterIngest(
  policy: RolloutPolicy,
  io: Pick<RampIo, 'now' | 'sleep' | 'observe'>,
  from: number,
  to: number,
  percent: number,
  probes: ProbeLoss | null,
  sample: LatencySample,
): Promise<Observation> {
  if (policy.ingestPollMs <= 0 || probes === null || probes.responded === 0) {
    await io.sleep(policy.ingestWaitMs)
    return io.observe(from, to, percent, sample)
  }
  const deadline = io.now() + policy.ingestWaitMs
  for (;;) {
    await io.sleep(Math.min(policy.ingestPollMs, Math.max(0, deadline - io.now())))
    const observed = await io.observe(from, to, percent, sample)
    if (io.now() >= deadline) return observed
    if (observed.kind === 'sample' && observed.landed >= probes.responded * INGEST_LANDED) return observed
  }
}

/** Share of answered probes the worker must have logged before the polled ingest wait stops. Workers Observability drops a few. */
export const INGEST_LANDED = 0.98

export async function runRamp(policy: RolloutPolicy, io: RampIo): Promise<RampLoopResult> {
  const lines: string[] = []
  const steps: RampStepRecord[] = []
  let state = rampStart()
  let carried: VersionStats | null = null
  let rollbackError: string | null = null
  let lastPassed: Option<number> = none()
  // The first step is predicted from the probe rate alone; each later one from the step before it.
  let basis: ForecastBasis | null = io.dwell ? probeBasis(policy) : null
  const cap = policy.steps.length
  for (let guard = 0; guard < cap && state.kind === 'ramping'; guard++) {
    const index = state.step
    const step = policy.steps[index]
    if (!step) {
      state = { kind: 'rolled-back', reason: `schedule has no step ${index}` }
      break
    }
    const percent = step.percent
    const splitError = await io.applySplit(percent)
    const splitConflict = asConflict(splitError)
    if (splitConflict) {
      state = { kind: 'stopped', reason: splitConflict.reason, fault: 'state_conflict' }
      break
    }
    if (typeof splitError === 'string') {
      const rolled = await io.rollback()
      const rolledConflict = asConflict(rolled)
      if (rolledConflict) {
        state = { kind: 'stopped', reason: rolledConflict.reason, fault: 'state_conflict' }
        break
      }
      rollbackError = typeof rolled === 'string' ? rolled : null
      state = { kind: 'rolled-back', reason: splitError }
      break
    }
    if (io.onApplied) io.onApplied(percent)
    if (policy.warmupMs > 0) await io.sleep(policy.warmupMs)
    const from = io.now()
    let probeLoss = emptyProbeLoss(policy.probe.maxLossRate)
    let sample: LatencySample = ALL_INVOCATIONS
    const dwell = io.dwell
    if (dwell) {
      const probed = await probeWindows(policy, io, dwell, step.dwellMs, percent)
      const window = probed.window
      sample = probed.sample
      probeLoss = window.loss
      // `telemetry`: a probe-loss fault is the harness (client aborts, probe tail). Record it and judge the step on the
      // new version's telemetry below; a 5xx the Worker served is in that telemetry.
      const deferred = window.kind === 'harness_fault' && policy.probe.onHarnessFault === 'telemetry'
      if (window.kind !== 'ok' && !deferred) {
        const decision = probeWindowDecision(policy, window)
        const noted = withProbeRules(decision, probeLoss)
        const line = progressLine({
          step: index + 1,
          steps: policy.steps.length,
          percent,
          next: null,
          previous: null,
          carriedPrevious: null,
          share: UNTESTED_SHARE,
          decision: noted,
          latency: policy.gates.latency.mode,
          probe: { kind: 'measured', loss: probeLoss },
          sample,
        })
        lines.push(line)
        steps.push({ percent, burns: noted.burns, outcome: noted.outcome, line, probeLoss, forecast: null })
        if (window.kind === 'harness_fault') {
          const settled = await settleHarnessFault(policy, io, percent, window.reason, lastPassed)
          state = settled.state
          rollbackError = settled.rollbackError
        } else if (window.kind === 'rollback') {
          const rolled = await io.rollback()
          const rolledConflict = asConflict(rolled)
          if (rolledConflict) state = { kind: 'stopped', reason: rolledConflict.reason, fault: 'state_conflict' }
          else {
            rollbackError = typeof rolled === 'string' ? rolled : null
            state = { kind: 'rolled-back', reason: window.reason }
          }
        } else {
          state = { kind: 'held', reason: window.reason, outcome: 'insufficient_samples' }
        }
        break
      }
    } else {
      await io.sleep(step.dwellMs)
    }
    const to = io.now()
    // Wait for the dwell's own tail to land, then query that window. The next step
    // has not started. The checked-in wait is above the 2026-11-01 gaps: 12640ms
    // at 1% and 17313ms at 5% on run 2026-11-01T00-10-02-620Z.
    const observed = await observeAfterIngest(policy, io, from, to, percent, io.dwell ? probeLoss : null, sample)
    if (observed.kind === 'sample' && observed.previous.wallMs.length >= CARRY_WALL_SAMPLES) carried = observed.previous
    const carriedPrevious = observed.kind === 'sample'
      && percent === 100
      && observed.previous.wallMs.length < CARRY_WALL_SAMPLES
      && carried
      && carried.wallMs.length >= CARRY_WALL_SAMPLES
      ? carried
      : null
    const probes = io.dwell ? probeLoss : null
    const decision = withProbeRules(decideRampStep(observed, policy, percent, probes), probeLoss)
    const liveShare = observed.kind === 'sample'
      ? routedShare(observed.next.invocations, observed.aggregate.invocations, percent, policy.split.z)
      : UNTESTED_SHARE
    const line = progressLine({
      step: index + 1,
      steps: policy.steps.length,
      percent,
      next: observed.kind === 'sample' ? observed.next : null,
      previous: observed.kind === 'sample' ? observed.previous : null,
      carriedPrevious,
      share: liveShare,
      decision,
      latency: policy.gates.latency.mode,
      probe: io.dwell ? { kind: 'measured', loss: probeLoss } : { kind: 'none' },
      sample,
    })
    lines.push(line)
    let forecast: ForecastCheck | null = null
    if (observed.kind === 'sample') {
      const seen = observeStep(observed, policy.split.z)
      const predicted = basis === null ? null : predictStep(basis, percent, step.dwellMs, policy.split.z)
      forecast = compareStep({ step: index + 1, percent, basis, predicted, observed: seen.resolution, wallDeltaMs: seen.wallDeltaMs })
      basis = observedBasis(index + 1, percent, observed, step.dwellMs)
    }
    steps.push({ percent, burns: decision.burns, outcome: decision.outcome, line, probeLoss, forecast })
    if (io.onDecision) {
      if (!observed.ref) throw new Error('decision without an observation')
      await io.onDecision(observed.ref, decision, percent)
    }
    state = applyRamp(state, decision, policy.steps.length)
    if (state.kind === 'stopped' && state.fault === 'harness_fault') {
      const settled = await settleHarnessFault(policy, io, percent, decision.reason, lastPassed)
      state = settled.state
      rollbackError = settled.rollbackError
      break
    }
    if (state.kind === 'ramping' || state.kind === 'complete') lastPassed = some(percent)
    if (state.kind === 'rolled-back') {
      const rolled = await io.rollback()
      const rolledConflict = asConflict(rolled)
      if (rolledConflict) {
        state = { kind: 'stopped', reason: rolledConflict.reason, fault: 'state_conflict' }
        break
      }
      rollbackError = typeof rolled === 'string' ? rolled : null
      break
    }
  }
  if (state.kind === 'ramping') {
    const rolled = await io.rollback()
    const rolledConflict = asConflict(rolled)
    if (rolledConflict) {
      state = { kind: 'stopped', reason: rolledConflict.reason, fault: 'state_conflict' }
    } else {
      rollbackError = typeof rolled === 'string' ? rolled : null
      state = { kind: 'rolled-back', reason: 'ramp did not finish' }
    }
  }
  return { state, lines, rollbackError, steps }
}
