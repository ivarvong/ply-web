import { assertNever } from '../../src/never.ts'
import { none, some, type Option } from '../../src/option.ts'
import { asRecord } from './json.ts'
import type { ObservationRef } from './log.ts'
import type { RolloutPolicy } from './policy.ts'
import { emptyProbeLoss, judgeProbeWindow, type ProbeLoss, type ProbeOutcome } from './probe.ts'
import { percentile, type VersionStats } from './telemetry.ts'
import { burnMap, CARRY_WALL_SAMPLES, judgeStep, routedShare, type RoutedShare, type StepVerdict } from './slo.ts'

export type { VersionStats } from './telemetry.ts'

export type Observation =
  | { readonly kind: 'unavailable'; readonly reason: string; readonly ref?: ObservationRef }
  | {
    readonly kind: 'sample'
    readonly next: VersionStats
    readonly previous: VersionStats
    readonly aggregate: VersionStats
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

/** One ramp step. Unavailable telemetry is a harness fault and does not roll back. A clean step advances. */
export function decideRampStep(obs: Observation, policy: RolloutPolicy, targetPercent: number): RampDecision {
  if (obs.kind === 'unavailable') {
    return {
      outcome: 'harness_fault',
      reason: obs.reason,
      rules: [{ name: 'telemetry_required', value: 1 }],
      burns: burnMap([]),
    }
  }
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
}): string {
  const previousPercent = input.percent >= 100 ? 0 : 100 - input.percent
  const samples = `${input.next?.requests ?? '-'}/${input.previous?.requests ?? '-'}`
  const errors = `${input.next ? fixedRate(input.next.errors, input.next.requests) : '-'}/${input.previous ? fixedRate(input.previous.errors, input.previous.requests) : '-'}`
  const oldWalls = input.carriedPrevious?.wallMs ?? input.previous?.wallMs
  const oldCpu = input.carriedPrevious?.cpuMs ?? input.previous?.cpuMs
  const walls = `${p99(input.next?.wallMs)}/${p99(oldWalls)}`
  const cpu = `${p99(input.next?.cpuMs)}/${p99(oldCpu)}`
  const latency = input.latency === 'off' ? '' : ` p99_wall_ms=${walls} p99_cpu_ms=${cpu} latency=${input.latency}`
  const routed = `routed_share=${points(input.share.share)} target=${input.percent} tolerance=${tolerance(input.share)} agg=${input.share.n}`
  const internal = internalNote(input.next, input.previous)
  const probe = input.probe.kind === 'measured' ? ` probe_loss=${input.probe.loss.count}/${input.probe.loss.total}` : ''
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
  observe(from: number, to: number, percent: number): Promise<Observation>
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
    rules: [...decision.rules, { name: 'probe_loss_count', value: loss.count }, { name: 'probe_loss_rate', value: loss.rate }],
  }
}

export async function runRamp(policy: RolloutPolicy, io: RampIo): Promise<RampLoopResult> {
  const lines: string[] = []
  const steps: RampStepRecord[] = []
  let state = rampStart()
  let carried: VersionStats | null = null
  let rollbackError: string | null = null
  let lastPassed: Option<number> = none()
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
    if (policy.warmupMs > 0) await io.sleep(policy.warmupMs)
    const from = io.now()
    let probeLoss = emptyProbeLoss(policy.probe.maxLossRate)
    if (io.dwell) {
      const probed = await io.dwell(step.dwellMs, percent)
      const window = judgeProbeWindow(probed.outcomes, policy.probe.maxLossRate, policy.burn.minSamples)
      probeLoss = window.loss
      if (window.kind !== 'ok') {
        const decision: RampDecision = window.kind === 'harness_fault'
          ? { outcome: 'harness_fault', reason: window.reason, rules: [{ name: 'probe_max_loss_rate', value: policy.probe.maxLossRate }], burns: burnMap([]) }
          : { outcome: 'insufficient_samples', reason: window.reason, rules: [{ name: 'probe_min_samples', value: policy.burn.minSamples }], burns: burnMap([]) }
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
        })
        lines.push(line)
        steps.push({ percent, burns: noted.burns, outcome: noted.outcome, line, probeLoss })
        if (window.kind === 'harness_fault') {
          const settled = await settleHarnessFault(policy, io, percent, window.reason, lastPassed)
          state = settled.state
          rollbackError = settled.rollbackError
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
    await io.sleep(policy.ingestWaitMs)
    const observed = await io.observe(from, to, percent)
    if (observed.kind === 'sample' && observed.previous.wallMs.length >= CARRY_WALL_SAMPLES) carried = observed.previous
    const carriedPrevious = observed.kind === 'sample'
      && percent === 100
      && observed.previous.wallMs.length < CARRY_WALL_SAMPLES
      && carried
      && carried.wallMs.length >= CARRY_WALL_SAMPLES
      ? carried
      : null
    const decision = withProbeRules(decideRampStep(observed, policy, percent), probeLoss)
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
    })
    lines.push(line)
    steps.push({ percent, burns: decision.burns, outcome: decision.outcome, line, probeLoss })
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
