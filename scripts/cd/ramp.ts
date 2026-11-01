import { asRecord } from './json.ts'
import type { ObservationRef } from './log.ts'
import type { RolloutPolicy } from './policy.ts'
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

export type RampDecision = StepVerdict | HarnessRamp

export type HeldWrite = { readonly kind: 'state_conflict'; readonly reason: string }

export type RampState =
  | { readonly kind: 'ramping'; readonly step: number }
  | { readonly kind: 'rolled-back'; readonly reason: string }
  | { readonly kind: 'stopped'; readonly reason: string; readonly fault: 'harness_fault' | 'state_conflict' }
  | { readonly kind: 'held'; readonly reason: string; readonly outcome: 'hold' | 'insufficient_data' }
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

/** Advance on a clean step. A terminal state stays terminal. A harness fault, a hold, or insufficient evidence stops without rolling back. */
export function applyRamp(state: RampState, decision: RampDecision, stepCount: number): RampState {
  if (state.kind !== 'ramping') return state
  if (decision.outcome === 'harness_fault') return { kind: 'stopped', reason: decision.reason, fault: 'harness_fault' }
  if (decision.outcome === 'rollback') return { kind: 'rolled-back', reason: decision.reason }
  if (decision.outcome === 'hold' || decision.outcome === 'insufficient_data') {
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
  const head = `ramp step=${input.step}/${input.steps} percent=${input.percent} previous=${previousPercent} samples=${samples} error_rate=${errors} ${routed}${internal}${latency} decision=${input.decision.outcome}`
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
  /** Probe during the dwell. When omitted, `sleep` is the whole dwell. A harness fault is a probe that got no response. */
  dwell?(ms: number): Promise<{ readonly harnessFaults?: number }>
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

export async function runRamp(policy: RolloutPolicy, io: RampIo): Promise<RampLoopResult> {
  const lines: string[] = []
  const steps: RampStepRecord[] = []
  let state = rampStart()
  let carried: VersionStats | null = null
  let rollbackError: string | null = null
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
    const probed = io.dwell ? await io.dwell(step.dwellMs) : (await io.sleep(step.dwellMs), { harnessFaults: 0 })
    if ((probed.harnessFaults ?? 0) > 0) {
      state = { kind: 'stopped', reason: 'harness fault during probes', fault: 'harness_fault' }
      break
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
    const decision = decideRampStep(observed, policy, percent)
    steps.push({ percent, burns: decision.burns, outcome: decision.outcome })
    const liveShare = observed.kind === 'sample'
      ? routedShare(observed.next.invocations, observed.aggregate.invocations, percent, policy.split.z)
      : { n: 0, newRequests: 0, share: null, low: null, high: null, kind: 'untested' as const }
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
    })
    lines.push(line)
    if (io.onDecision) {
      if (!observed.ref) throw new Error('decision without an observation')
      await io.onDecision(observed.ref, decision, percent)
    }
    state = applyRamp(state, decision, policy.steps.length)
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
