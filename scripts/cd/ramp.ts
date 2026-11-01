import { asRecord } from './json.ts'
import type { ObservationRef } from './log.ts'
import { percentile, type VersionStats } from './telemetry.ts'
import { burnMap, judgeStep, QUANTILE_FLOOR, type StepVerdict } from './slo.ts'
import { TELEMETRY_WAIT_MS, type RampSchedule } from './baseline.ts'

export type { VersionStats } from './telemetry.ts'

export type Observation =
  | { readonly kind: 'unavailable'; readonly reason: string; readonly ref?: ObservationRef }
  | { readonly kind: 'sample'; readonly next: VersionStats; readonly previous: VersionStats; readonly ref?: ObservationRef }

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
  | { readonly kind: 'complete' }

export function rampStart(): RampState {
  return { kind: 'ramping', step: 0 }
}

/** One ramp step. Unavailable telemetry is a harness fault and does not roll back. A short clean sample is insufficient_data, which still advances. */
export function decideRampStep(obs: Observation, probeFailures = 0): RampDecision {
  if (obs.kind === 'unavailable') {
    return {
      outcome: 'harness_fault',
      reason: obs.reason,
      rules: [{ name: 'telemetry_required', value: 1 }],
      burns: burnMap([]),
    }
  }
  return judgeStep({ next: obs.next, previous: obs.previous, probeFailures })
}

/** Advance on a clean step, including insufficient_data. A terminal state stays terminal. A harness fault stops without rolling back. */
export function applyRamp(state: RampState, decision: RampDecision, stepCount: number): RampState {
  if (state.kind !== 'ramping') return state
  if (decision.outcome === 'harness_fault') return { kind: 'stopped', reason: decision.reason, fault: 'harness_fault' }
  if (decision.outcome === 'rollback') return { kind: 'rolled-back', reason: decision.reason }
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

/** One line an operator can paste. `step` is 1-based. */
export function progressLine(input: {
  readonly step: number
  readonly steps: number
  readonly percent: number
  readonly next: VersionStats | null
  readonly previous: VersionStats | null
  readonly decision: RampDecision
  readonly carried?: boolean
}): string {
  const previousPercent = input.percent >= 100 ? 0 : 100 - input.percent
  const samples = `${input.next?.requests ?? '-'}/${input.previous?.requests ?? '-'}`
  const errors = `${input.next ? fixedRate(input.next.errors, input.next.requests) : '-'}/${input.previous ? fixedRate(input.previous.errors, input.previous.requests) : '-'}`
  const walls = `${p99(input.next?.wallMs)}/${p99(input.previous?.wallMs)}`
  const head = `ramp step=${input.step}/${input.steps} percent=${input.percent} previous=${previousPercent} samples=${samples} error_rate=${errors} p99_wall_ms=${walls} decision=${input.decision.outcome}`
  const carried = input.carried ? ' previous_sample=carried' : ''
  if (input.decision.outcome === 'advance') return head + carried
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
  /** Probe during the dwell. When omitted, `sleep` is the whole dwell and probes are zero. */
  dwell?(ms: number): Promise<{ readonly probeFailures: number; readonly harnessFaults?: number }>
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
 * Step the schedule. At 100% the previous version is no longer allocated, so the old side of
 * the latency compare is the last step whose old version had enough wall samples.
 */
function asConflict(value: null | string | HeldWrite): HeldWrite | null {
  if (value && typeof value === 'object') return value
  return null
}

export async function runRamp(schedule: RampSchedule, io: RampIo): Promise<RampLoopResult> {
  const lines: string[] = []
  const steps: RampStepRecord[] = []
  let state = rampStart()
  let carried: VersionStats | null = null
  let rollbackError: string | null = null
  const cap = schedule.percents.length
  for (let guard = 0; guard < cap && state.kind === 'ramping'; guard++) {
    const index = state.step
    const percent = schedule.percents[index]
    if (percent === undefined) {
      state = { kind: 'rolled-back', reason: `schedule has no step ${index}` }
      break
    }
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
    const from = io.now()
    const probed = io.dwell ? await io.dwell(schedule.dwellMs) : (await io.sleep(schedule.dwellMs), { probeFailures: 0 })
    if ((probed.harnessFaults ?? 0) > 0) {
      state = { kind: 'stopped', reason: 'harness fault during probes', fault: 'harness_fault' }
      break
    }
    const to = io.now()
    // Ingest lag on 2026-10-31 was 10–30s. Querying at the end of the dwell saw only
    // the first ~27s, so p99 was the second-largest cold start. Wait, then query the
    // dwell window. The next step has not started, so this wait does not include it.
    await io.sleep(TELEMETRY_WAIT_MS)
    const observed = await io.observe(from, to, percent)
    if (observed.kind === 'sample' && observed.previous.wallMs.length >= QUANTILE_FLOOR) carried = observed.previous
    let used = observed
    let usedCarried = false
    if (
      observed.kind === 'sample'
      && percent === 100
      && observed.previous.wallMs.length < QUANTILE_FLOOR
      && carried
      && carried.wallMs.length >= QUANTILE_FLOOR
    ) {
      used = { kind: 'sample', next: observed.next, previous: carried, ref: observed.ref }
      usedCarried = true
    }
    const decision = decideRampStep(used, probed.probeFailures)
    steps.push({ percent, burns: decision.burns, outcome: decision.outcome })
    const line = progressLine({
      step: index + 1,
      steps: schedule.percents.length,
      percent,
      next: used.kind === 'sample' ? used.next : null,
      previous: used.kind === 'sample' ? used.previous : null,
      decision,
      carried: usedCarried,
    })
    lines.push(line)
    if (io.onDecision) {
      if (!used.ref) throw new Error('decision without an observation')
      await io.onDecision(used.ref, decision, percent)
    }
    state = applyRamp(state, decision, schedule.percents.length)
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
