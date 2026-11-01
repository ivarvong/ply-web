/**
 * SLO definitions and the ramp's burn-rate math. Numbers live here, not at the call site.
 *
 * Burn rate is the observed bad fraction divided by the error-budget fraction (1 − target).
 * The ramp fails a step when that rate is above FAST_BURN and the window has MIN_SAMPLES,
 * or when the new version has any exception or 5xx. The multi-window table is the alerting
 * policy for later; the step window uses only the fast-burn multiple.
 */

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

/** Below this, a burn rate is not judged. A short clean window is insufficient_data, not a pass of the SLO. */
export const MIN_SAMPLES = 20

/** Both sides at least this long, and at least one side under MIN_SAMPLES: compare p99 instead of Mann-Whitney. */
export const QUANTILE_FLOOR = 5

/** Initial. new/old wall p99 above this, on a short sample, rolls back. Equal to it advances. */
export const QUANTILE_P99_RATIO = 2

/** One-sided Mann-Whitney. Fail when the new version is slower and this tail probability is under alpha. */
export const MANN_WHITNEY_ALPHA = 0.01

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
  readonly outcome: 'advance' | 'insufficient_data' | 'rollback'
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

export type RankTest = {
  readonly rankSum: number
  readonly z: number
  readonly pGreater: number
  /** True when the new sample is stochastically greater and the one-sided tail is under alpha. */
  readonly slower: boolean
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-a * a)
  return sign * y
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/**
 * One-sided Mann-Whitney: is `newer` stochastically greater than `older`?
 * Ranks are 1-based with the average rank on ties. Null when either side has fewer than 2 points.
 */
export function mannWhitneyGreater(newer: readonly number[], older: readonly number[], alpha: number): RankTest | null {
  const n1 = newer.length
  const n2 = older.length
  if (n1 < 2 || n2 < 2) return null
  const tagged = [
    ...newer.map(value => ({ value, side: 'new' as const })),
    ...older.map(value => ({ value, side: 'old' as const })),
  ].sort((a, b) => a.value - b.value)
  const ranks = new Array<number>(tagged.length)
  let tieTerm = 0
  let index = 0
  while (index < tagged.length) {
    let end = index
    while (end < tagged.length && tagged[end]?.value === tagged[index]?.value) end += 1
    const width = end - index
    const average = (index + 1 + end) / 2
    for (let cursor = index; cursor < end; cursor++) ranks[cursor] = average
    if (width > 1) tieTerm += width * width * width - width
    index = end
  }
  let rankSum = 0
  for (let cursor = 0; cursor < tagged.length; cursor++) {
    if (tagged[cursor]?.side === 'new') rankSum += ranks[cursor] ?? 0
  }
  const n = n1 + n2
  const mean = n1 * (n + 1) / 2
  let variance = n1 * n2 * (n + 1) / 12
  if (n > 1) variance -= n1 * n2 * tieTerm / (12 * n * (n - 1))
  if (variance <= 0) return { rankSum, z: 0, pGreater: 0.5, slower: false }
  const z = (rankSum - mean) / Math.sqrt(variance)
  const pGreater = 1 - normalCdf(z)
  return { rankSum, z, pGreater, slower: z > 0 && pGreater < alpha }
}

function p99(values: readonly number[]): number | null {
  const sorted = values.filter(value => Number.isFinite(value)).slice().sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.floor((sorted.length - 1) * 0.99)] ?? null
}

export type LatencyCall =
  | { readonly kind: 'insufficient_data'; readonly reason: string; readonly rule: AppliedRule }
  | { readonly kind: 'not_slower'; readonly reason: string; readonly rule: AppliedRule }
  | { readonly kind: 'slower'; readonly reason: string; readonly rule: AppliedRule }

/** Mann-Whitney when both sides have MIN_SAMPLES. Quantile p99 when both have QUANTILE_FLOOR. Otherwise insufficient. */
export function compareLatency(newer: readonly number[], older: readonly number[]): LatencyCall {
  if (newer.length >= MIN_SAMPLES && older.length >= MIN_SAMPLES) {
    const test = mannWhitneyGreater(newer, older, MANN_WHITNEY_ALPHA)
    const rule = { name: 'mann_whitney_alpha', value: MANN_WHITNEY_ALPHA }
    if (!test) return { kind: 'insufficient_data', reason: 'Mann-Whitney needs two samples on each side', rule }
    if (test.slower) {
      return {
        kind: 'slower',
        reason: `new version wall time is slower (Mann-Whitney p=${test.pGreater.toExponential(2)} < ${MANN_WHITNEY_ALPHA})`,
        rule,
      }
    }
    return { kind: 'not_slower', reason: `Mann-Whitney p=${test.pGreater.toExponential(2)}`, rule }
  }
  if (newer.length >= QUANTILE_FLOOR && older.length >= QUANTILE_FLOOR) {
    const next = p99(newer)
    const previous = p99(older)
    const rule = { name: 'quantile_p99_ratio', value: QUANTILE_P99_RATIO }
    if (next === null || previous === null) {
      return { kind: 'insufficient_data', reason: 'wall p99 has no sample', rule }
    }
    if (previous === 0 && next === 0) return { kind: 'not_slower', reason: 'wall p99 is 0 on both versions', rule }
    if (previous === 0 && next > 0) {
      return { kind: 'slower', reason: `wall p99 was 0 on the old version and ${next} on the new`, rule }
    }
    const ratioValue = next / previous
    if (ratioValue > QUANTILE_P99_RATIO) {
      return { kind: 'slower', reason: `wall p99 ratio ${ratioValue.toFixed(3)} > ${QUANTILE_P99_RATIO}`, rule }
    }
    return { kind: 'not_slower', reason: `wall p99 ratio ${ratioValue.toFixed(3)}`, rule }
  }
  return {
    kind: 'insufficient_data',
    reason: `wall samples ${newer.length}/${older.length}; need ${MIN_SAMPLES} each for Mann-Whitney or ${QUANTILE_FLOOR} each for a quantile compare`,
    rule: { name: 'min_samples', value: MIN_SAMPLES },
  }
}

export type StepInput = {
  readonly requests: number
  readonly exceptions: number
  readonly errors: number
  readonly fivexx: number
  readonly wallMs: readonly number[]
  readonly v1: readonly V1Request[]
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

/**
 * One ramp step for the new version. Any exception, 5xx, non-ok outcome, or failed probe
 * rolls back before the sample floor. Burn is judged only at MIN_SAMPLES. Latency against
 * the old version is Mann-Whitney, or a p99 ratio when the sample is shorter.
 */
export function judgeStep(input: {
  readonly next: StepInput
  readonly previous: StepInput
  readonly probeFailures: number
}): StepVerdict {
  const burns = burnMap(input.next.v1)
  if (input.probeFailures > 0) {
    return verdict(
      'rollback',
      `${input.probeFailures} probe responses from the new version were not 2xx`,
      [{ name: 'probe_contract', value: 0 }],
      burns,
    )
  }
  if (input.next.exceptions > 0) {
    const noun = input.next.exceptions === 1 ? 'exception' : 'exceptions'
    return verdict(
      'rollback',
      `${input.next.exceptions} ${noun} on the new version`,
      [{ name: 'max_new_exceptions', value: 0 }],
      burns,
    )
  }
  if (input.next.fivexx > 0) {
    return verdict(
      'rollback',
      `${input.next.fivexx} 5xx responses on the new version`,
      [{ name: 'max_new_5xx', value: 0 }],
      burns,
    )
  }
  if (input.next.errors > 0) {
    return verdict(
      'rollback',
      `${input.next.errors} non-ok outcomes on the new version`,
      [{ name: 'max_new_errors', value: 0 }],
      burns,
    )
  }
  for (const slo of [AVAILABILITY, READ_LATENCY, WRITE_LATENCY]) {
    const count = countSlo(slo, input.next.v1)
    if (count.total >= MIN_SAMPLES && count.burn !== null && count.burn > FAST_BURN) {
      return verdict(
        'rollback',
        `${slo.id} burn ${count.burn.toFixed(2)} > ${FAST_BURN}`,
        [{ name: 'fast_burn', value: FAST_BURN }, { name: `${slo.id}.target`, value: slo.target }],
        burns,
      )
    }
  }
  const latency = compareLatency(input.next.wallMs, input.previous.wallMs)
  if (latency.kind === 'slower') return verdict('rollback', latency.reason, [latency.rule], burns)
  if (latency.kind === 'insufficient_data') return verdict('insufficient_data', latency.reason, [latency.rule], burns)
  return verdict(
    'advance',
    `within burn ${FAST_BURN} and latency is not slower`,
    [{ name: 'fast_burn', value: FAST_BURN }, latency.rule],
    burns,
  )
}
