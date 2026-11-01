/**
 * SLO definitions and the ramp's burn-rate math. Numbers live here, not at the call site.
 *
 * Burn rate is the observed bad fraction divided by the error-budget fraction (1 − target).
 * The ramp fails a step when that rate is above the policy's fast burn and the window
 * has the policy's sample floor, or when a version (or the whole worker) has any
 * exception, 5xx, error log, or non-ok outcome. Which of those signals actually
 * stops a step comes from the rollout policy. Wall time is a gate only when that
 * policy says `latency.mode` is `gate`. The routed share is a separate check.
 * The multi-window table is the alerting policy for later; the step window uses only
 * the fast-burn multiple.
 */

import type { RolloutPolicy } from './policy.ts'

declare const ratioBrand: unique symbol
/** A fraction strictly between 0 and 1. */
export type Ratio = number & { readonly [ratioBrand]: 'Ratio' }

declare const msBrand: unique symbol
export type Milliseconds = number & { readonly [msBrand]: 'Milliseconds' }

function ratio(value: number): Ratio {
  if (!(value > 0 && value < 1)) throw new Error('SLO target must be between 0 and 1')
  return value as Ratio
}

function milliseconds(value: number): Milliseconds {
  if (!(value > 0)) throw new Error('ceiling must be positive')
  return value as Milliseconds
}

export type SloId = 'availability' | 'read_latency' | 'write_latency' | 'correctness'

export type Slo = {
  readonly id: SloId
  readonly statement: string
  readonly target: Ratio
  readonly windowDays: number
  readonly initial: boolean
  readonly ceilingMs: Milliseconds | null
}

export const READ_WALL_MS = milliseconds(1000)
export const WRITE_WALL_MS = milliseconds(2500)

export const AVAILABILITY: Slo = {
  id: 'availability',
  statement: 'good = non-5xx and no exception, over /v1 requests excluding expected 4xx',
  target: ratio(0.999),
  windowDays: 28,
  initial: false,
  ceilingMs: null,
}

/** Initial ceiling. Tighten from a real baseline; the target stays 99% under the ceiling. */
export const READ_LATENCY: Slo = {
  id: 'read_latency',
  statement: 'GET /v1/* wall time under the ceiling',
  target: ratio(0.99),
  windowDays: 28,
  initial: true,
  ceilingMs: READ_WALL_MS,
}

/** Initial ceiling. Tighten from a real baseline; the target stays 99% under the ceiling. */
export const WRITE_LATENCY: Slo = {
  id: 'write_latency',
  statement: 'POST /v1/* wall time under the ceiling',
  target: ratio(0.99),
  windowDays: 28,
  initial: true,
  ceilingMs: WRITE_WALL_MS,
}

export const CORRECTNESS: Slo = {
  id: 'correctness',
  statement: 'lifecycle smoke pass: every step expected status, fsck clean, refs equal',
  target: ratio(0.995),
  windowDays: 28,
  initial: false,
  ceilingMs: null,
}

export const SLOS: readonly Slo[] = [AVAILABILITY, READ_LATENCY, WRITE_LATENCY, CORRECTNESS]

/**
 * Google SRE workbook fast burn. On a 30-day budget, 14.4× for 1 hour spends about 2%.
 * Our SLO window is 28 days; the multiple on a ramp step is still this constant.
 */
export const FAST_BURN = 14.4

/**
 * Sample floor copied into the checked-in policy as `burn.minSamples`.
 * A ramp reads the policy. This export is the chart fallback for a run that
 * recorded no policy event, and the lock that the file did not drift.
 */
export const MIN_SAMPLES = 100

/**
 * At 100% the old version is no longer allocated. The wall and CPU numbers on
 * that line use the last step whose old version had at least this many wall
 * samples. This is display, not a gate.
 */
export const CARRY_WALL_SAMPLES = 5

/**
 * Alerting policy for later. Not applied on a ramp step.
 * The budget shares are the workbook's 30-day figures (1h/720, 6h/720, 3d/30d).
 */
export const BURN_ALERTS = [
  { severity: 'page', multiple: 14.4, longWindow: '1h', shortWindow: '5m', budgetShare: 0.02 },
  { severity: 'ticket', multiple: 6, longWindow: '6h', shortWindow: '30m', budgetShare: 0.05 },
  { severity: 'ticket', multiple: 1, longWindow: '3d', shortWindow: '6h', budgetShare: 0.10 },
] as const

export type V1Request = {
  readonly method: 'GET' | 'POST' | 'OTHER'
  readonly path: string
  readonly status: number
  readonly exception: boolean
  readonly wallMs: number | null
  /** Ramp telemetry marks every 4xx expected, so client errors leave the availability denominator. */
  readonly expected4xx: boolean
}

export type SloCount = {
  readonly id: SloId
  readonly good: number
  readonly bad: number
  readonly total: number
  readonly burn: number | null
}

export type BurnMap = Readonly<Record<SloId, number | null>>

export type AppliedRule = {
  readonly name: string
  readonly value: number | string
}

export type StepVerdict = {
  readonly outcome: 'advance' | 'rollback' | 'hold' | 'insufficient_data'
  readonly reason: string
  readonly rules: readonly [AppliedRule, ...AppliedRule[]]
  readonly burns: BurnMap
}

export function errorBudget(target: Ratio): number {
  return 1 - target
}

/** Null when the window saw nothing. Otherwise bad/total divided by the error budget. */
export function burnRate(bad: number, total: number, target: Ratio): number | null {
  if (total <= 0) return null
  return (bad / total) / errorBudget(target)
}

function isV1(path: string): boolean {
  return path === '/v1' || path.startsWith('/v1/')
}

function skippedClientError(request: V1Request): boolean {
  return request.expected4xx && request.status >= 400 && request.status < 500 && !request.exception
}

export function countSlo(slo: Slo, requests: readonly V1Request[]): SloCount {
  let good = 0
  let bad = 0
  for (const request of requests) {
    if (!isV1(request.path)) continue
    if (slo.id === 'availability') {
      if (skippedClientError(request)) continue
      if (request.exception || request.status >= 500) bad += 1
      else good += 1
      continue
    }
    if (slo.id === 'read_latency' && request.method !== 'GET') continue
    if (slo.id === 'write_latency' && request.method !== 'POST') continue
    if (slo.id !== 'read_latency' && slo.id !== 'write_latency') continue
    if (request.wallMs === null || slo.ceilingMs === null) continue
    if (request.wallMs < slo.ceilingMs) good += 1
    else bad += 1
  }
  const total = good + bad
  return { id: slo.id, good, bad, total, burn: burnRate(bad, total, slo.target) }
}

/** One lifecycle run, or the steps inside it. The smoke stage still fails closed on any failed step. */
export function countCorrectness(passed: number, failed: number): SloCount {
  const total = passed + failed
  return {
    id: CORRECTNESS.id,
    good: passed,
    bad: failed,
    total,
    burn: burnRate(failed, total, CORRECTNESS.target),
  }
}

export function burnMap(requests: readonly V1Request[], correctness: SloCount | null = null): BurnMap {
  return {
    availability: countSlo(AVAILABILITY, requests).burn,
    read_latency: countSlo(READ_LATENCY, requests).burn,
    write_latency: countSlo(WRITE_LATENCY, requests).burn,
    correctness: correctness?.burn ?? null,
  }
}

export type StepInput = {
  readonly requests: number
  /** Fetch invocations. The routed share uses this, not `requests`, which falls back to logs. */
  readonly invocations: number
  readonly exceptions: number
  readonly errors: number
  readonly fivexx: number
  readonly errorLogs: number
  readonly wallMs: readonly number[]
  readonly v1: readonly V1Request[]
}

export type RoutedShare = {
  readonly n: number
  readonly newRequests: number
  readonly share: number | null
  readonly low: number | null
  readonly high: number | null
  readonly kind: 'untested' | 'match' | 'mismatch'
}

/**
 * Binomial band around the target percent. Width is `z` standard errors at this n.
 * `untested` is n = 0. `mismatch` is a share outside the band, or a new count that
 * is not a fraction of the aggregate.
 */
export function routedShare(newRequests: number, total: number, targetPercent: number, z: number): RoutedShare {
  if (!(total > 0) || newRequests < 0 || newRequests > total) {
    const kind = total >= 0 && newRequests > total ? 'mismatch' : 'untested'
    return { n: Math.max(0, total), newRequests, share: null, low: null, high: null, kind }
  }
  const p = targetPercent / 100
  const se = Math.sqrt((p * (1 - p)) / total)
  const margin = z * se
  const low = Math.max(0, p - margin)
  const high = Math.min(1, p + margin)
  const share = newRequests / total
  const kind = share < low || share > high ? 'mismatch' : 'match'
  return { n: total, newRequests, share, low, high, kind }
}

function rulesOf(list: readonly AppliedRule[]): readonly [AppliedRule, ...AppliedRule[]] {
  const first = list[0]
  if (!first) throw new Error('a decision needs a rule')
  return [first, ...list.slice(1)]
}

function verdict(
  outcome: StepVerdict['outcome'],
  reason: string,
  rules: readonly AppliedRule[],
  burns: BurnMap,
): StepVerdict {
  return { outcome, reason, rules: rulesOf(rules), burns }
}

function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter(value => Number.isFinite(value)).slice().sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.floor((sorted.length - 1) * p)] ?? null
}

type Breach = { readonly reason: string; readonly rule: AppliedRule }

/** Hard breaches stop the step. Informational ones are named on the advance reason. */
function consider(mode: 'hard' | 'informational', breach: Breach | null, hard: Breach[], notes: string[]): void {
  if (!breach) return
  if (mode === 'hard') hard.push(breach)
  else notes.push(breach.reason)
}

function countBreach(count: number, noun: string, rule: string, scope: string): Breach | null {
  if (count <= 0) return null
  const word = count === 1 ? noun : `${noun}s`
  return { reason: `${count} ${word} ${scope}`, rule: { name: rule, value: 0 } }
}

function points(fraction: number): string {
  return (fraction * 100).toFixed(2)
}

/**
 * Version-vs-version wall p99. Fires only for `latency.mode = gate`, and only
 * once both sides have the policy's minSamples. A short sample does not roll back.
 */
function latencyBreach(newer: readonly number[], older: readonly number[], policy: RolloutPolicy): Breach | null {
  const latency = policy.gates.latency
  if (latency.mode !== 'gate') return null
  if (newer.length < latency.minSamples || older.length < latency.minSamples) return null
  const next = percentile(newer, 0.99)
  const previous = percentile(older, 0.99)
  if (next === null || previous === null) return null
  const delta = next - previous
  const floor = { name: 'latency.effectFloorMs', value: latency.effectFloorMs }
  if (previous <= 0) {
    if (delta <= latency.effectFloorMs) return null
    return { reason: `wall p99 was ${previous} on the old version and ${next} on the new`, rule: floor }
  }
  const ratio = next / previous
  if (ratio > latency.p99Ratio && delta > latency.effectFloorMs) {
    return {
      reason: `wall p99 ratio ${ratio.toFixed(3)} > ${latency.p99Ratio} and +${delta}ms > ${latency.effectFloorMs}ms`,
      rule: { name: 'latency.p99Ratio', value: latency.p99Ratio },
    }
  }
  return null
}

const SCOPES = [
  { id: 'new', scope: 'on the new version', pick: (input: { readonly next: StepInput }) => input.next },
  { id: 'old', scope: 'on the old version', pick: (input: { readonly previous: StepInput }) => input.previous },
  { id: 'aggregate', scope: 'across the worker', pick: (input: { readonly aggregate: StepInput }) => input.aggregate },
] as const

/**
 * One ramp step. Correctness and burn are judged per version and across the worker.
 * The routed share uses telemetry invocation counts. Too few new-version requests is
 * `insufficient_data` or an advance, per the policy. A share outside the binomial
 * band holds or rolls back, per the policy. Latency rolls back only in `gate` mode.
 */
export function judgeStep(input: {
  readonly next: StepInput
  readonly previous: StepInput
  readonly aggregate: StepInput
  readonly targetPercent: number
  readonly policy: RolloutPolicy
}): StepVerdict {
  const burns = burnMap(input.next.v1)
  const hard: Breach[] = []
  const notes: string[] = []
  const gates = input.policy.gates
  for (const scope of SCOPES) {
    const side = scope.pick(input)
    consider(gates.exceptions, countBreach(side.exceptions, 'exception', `max_${scope.id}_exceptions`, scope.scope), hard, notes)
    consider(gates.fivexx, countBreach(side.fivexx, '5xx response', `max_${scope.id}_5xx`, scope.scope), hard, notes)
    consider(gates.errorLogs, countBreach(side.errorLogs, 'error log', `max_${scope.id}_error_logs`, scope.scope), hard, notes)
    consider(gates.nonOk, countBreach(side.errors, 'non-ok outcome', `max_${scope.id}_errors`, scope.scope), hard, notes)
    if (gates.burn !== 'hard' && gates.burn !== 'informational') continue
    for (const slo of [AVAILABILITY, READ_LATENCY, WRITE_LATENCY]) {
      const count = countSlo(slo, side.v1)
      if (count.total < input.policy.burn.minSamples || count.burn === null || count.burn <= input.policy.burn.fastBurn) continue
      consider(
        gates.burn,
        {
          reason: `${slo.id} burn ${count.burn.toFixed(2)} > ${input.policy.burn.fastBurn} ${scope.scope}`,
          rule: { name: 'fast_burn', value: input.policy.burn.fastBurn },
        },
        hard,
        notes,
      )
    }
  }
  consider(gates.latency.mode === 'gate' ? 'hard' : 'informational', latencyBreach(input.next.wallMs, input.previous.wallMs, input.policy), hard, notes)
  const first = hard[0]
  if (first) return verdict('rollback', first.reason, [first.rule], burns)
  const noted = notes.length === 0 ? '' : `; informational: ${notes.join('; ')}`
  const routed = routedShare(input.next.invocations, input.aggregate.invocations, input.targetPercent, input.policy.split.z)
  if (routed.kind === 'mismatch') {
    const where = routed.share === null
      ? 'new-version requests are not a fraction of the aggregate'
      : `routed share ${points(routed.share)}% is outside ${points(routed.low ?? 0)}..${points(routed.high ?? 0)} of target ${input.targetPercent}% (n=${routed.n})`
    const outcome = input.policy.split.onMismatch === 'rollback' ? 'rollback' : 'hold'
    return verdict(outcome, where, [{ name: 'routed_share', value: input.policy.split.z }], burns)
  }
  if (routed.kind === 'untested' || routed.newRequests < input.policy.split.minNewRequests) {
    const reason = routed.kind === 'untested'
      ? `insufficient evidence: 0 requests in the window${noted}`
      : `insufficient evidence: ${routed.newRequests} new-version requests < ${input.policy.split.minNewRequests}${noted}`
    const rule = { name: 'min_new_requests', value: input.policy.split.minNewRequests }
    if (input.policy.split.onInsufficient === 'hold') return verdict('insufficient_data', reason, [rule], burns)
    return verdict('advance', reason, [rule], burns)
  }
  const reason = notes.length === 0
    ? `within burn ${input.policy.burn.fastBurn}`
    : `within burn ${input.policy.burn.fastBurn}${noted}`
  return verdict('advance', reason, [{ name: 'fast_burn', value: input.policy.burn.fastBurn }], burns)
}
