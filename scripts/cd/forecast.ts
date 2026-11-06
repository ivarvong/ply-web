// Prediction vs observation for each ramp step (issue #73). Before a step, the previous step's measurements (or, for
// the first step, the policy's probe rate) predict how many requests each version will serve during the dwell and the
// smallest effect the step can then detect: an error-rate increase and a wall-time shift at the policy's z. After the
// step, the same quantities are computed from what it saw. A step whose traffic or resolution is more than `tolerance`
// times off the prediction is flagged as drift: the policy's dwell, z, and sample floors were set for a different
// distribution than the one the ramp is running on. Drift is logged next to the step line; it is never a gate.
//
// Detectable effects (two-sided normal approximation, the same z the routed-share band uses, policy.split.z):
//   error rate   max(3 / n_new, z * sqrt(p (1 - p) (1/n_new + 1/n_old)))  where p is the baseline error rate. 3/n is
//                the rule of three: with no error in n requests, rates above 3/n are excluded at about 95%.
//   wall time    z * sqrt(s^2 (1/n_new + 1/n_old)) ms, s^2 the measured wall-time variance of the basis step and n the
//                wall-time samples (requests x the basis step's samples per request).
import type { RolloutPolicy } from './policy.ts'
import type { VersionStats } from './telemetry.ts'

/** What a prediction is made from. */
export type ForecastBasis = {
  /** Where the numbers came from: `policy probe` or `step <n> (<percent>%)`. */
  readonly source: string
  /** External requests per second across the Worker. */
  readonly ratePerSecond: number
  /** Baseline bad-request rate (5xx and exceptions over requests). */
  readonly errorRate: number
  /** Wall-time variance in ms^2, or null when not measured. */
  readonly wallVariance: number | null
  /** Wall-time samples per request (not every request carries one). 1 when not measured. */
  readonly wallShare: number
}

/** The predicted or observed counts and resolution of one step. */
export type StepResolution = {
  readonly newRequests: number
  readonly oldRequests: number
  /** Smallest error-rate increase the step resolves. Null with no new-version request. */
  readonly detectableErrorRate: number | null
  /** Smallest wall-time shift in ms the step resolves. Null without a variance or without both versions. */
  readonly detectableWallMs: number | null
}

export type ForecastCheck = {
  readonly percent: number
  readonly predicted: StepResolution | null
  readonly basis: string | null
  readonly observed: StepResolution
  /** Observed wall-time mean difference new - old in ms, when both sides have samples. */
  readonly wallDeltaMs: number | null
  readonly drift: readonly string[]
  readonly line: string
}

/** Ratio beyond which a prediction has drifted. PRIOR (uncalibrated): a step that saw half or double the traffic it was sized for. */
export const FORECAST_TOLERANCE = 2

/** Rule of three: zero events in n bounds the rate at about 3/n (95%). */
const RULE_OF_THREE = 3
const MS_PER_SECOND = 1000

export function mean(values: readonly number[]): number | null {
  const finite = values.filter(value => Number.isFinite(value))
  if (finite.length === 0) return null
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

/** Sample variance (n - 1). Null below two samples. */
export function variance(values: readonly number[]): number | null {
  const finite = values.filter(value => Number.isFinite(value))
  if (finite.length < 2) return null
  const m = finite.reduce((sum, value) => sum + value, 0) / finite.length
  return finite.reduce((sum, value) => sum + (value - m) ** 2, 0) / (finite.length - 1)
}

export function detectableErrorRate(newRequests: number, oldRequests: number, baseline: number, z: number): number | null {
  if (!(newRequests > 0)) return null
  const floor = RULE_OF_THREE / newRequests
  if (!(oldRequests > 0)) return floor
  const p = Math.min(Math.max(baseline, 0), 1)
  return Math.max(floor, z * Math.sqrt(p * (1 - p) * (1 / newRequests + 1 / oldRequests)))
}

export function detectableWallMs(newRequests: number, oldRequests: number, wallVariance: number | null, z: number): number | null {
  if (wallVariance === null || !(newRequests > 0) || !(oldRequests > 0)) return null
  return z * Math.sqrt(wallVariance * (1 / newRequests + 1 / oldRequests))
}

/** The first step's basis: the probe alone (rps x calls). Real traffic adds to it, so this is a floor. */
export function probeBasis(policy: RolloutPolicy): ForecastBasis {
  return { source: 'policy probe', ratePerSecond: policy.probe.rps * policy.probe.calls.length, errorRate: 0, wallVariance: null, wallShare: 1 }
}

function bad(stats: VersionStats): number {
  return stats.fivexx + stats.exceptions
}

function served(stats: VersionStats): number {
  return stats.invocations > 0 ? stats.invocations : stats.requests
}

/** The next step's basis: this step's measured rate, error rate and wall-time variance (both versions pooled). */
export function observedBasis(step: number, percent: number, sample: { readonly next: VersionStats; readonly previous: VersionStats; readonly aggregate: VersionStats }, dwellMs: number): ForecastBasis {
  const total = served(sample.aggregate)
  const errors = bad(sample.next) + bad(sample.previous)
  const versions = served(sample.next) + served(sample.previous)
  return {
    source: `step ${step} (${percent}%)`,
    ratePerSecond: dwellMs > 0 ? total / (dwellMs / MS_PER_SECOND) : 0,
    errorRate: versions > 0 ? errors / versions : 0,
    wallVariance: variance([...sample.next.wallMs, ...sample.previous.wallMs]),
    wallShare: versions > 0 ? (sample.next.wallMs.length + sample.previous.wallMs.length) / versions : 1,
  }
}

export function predictStep(basis: ForecastBasis, percent: number, dwellMs: number, z: number): StepResolution {
  const total = basis.ratePerSecond * (dwellMs / MS_PER_SECOND)
  const share = Math.min(Math.max(percent / 100, 0), 1)
  const newRequests = Math.round(total * share)
  const oldRequests = Math.round(total * (1 - share))
  return {
    newRequests,
    oldRequests,
    detectableErrorRate: detectableErrorRate(newRequests, oldRequests, basis.errorRate, z),
    detectableWallMs: detectableWallMs(newRequests * basis.wallShare, oldRequests * basis.wallShare, basis.wallVariance, z),
  }
}

export function observeStep(sample: { readonly next: VersionStats; readonly previous: VersionStats }, z: number): { readonly resolution: StepResolution; readonly wallDeltaMs: number | null } {
  const newRequests = served(sample.next)
  const oldRequests = served(sample.previous)
  const baseline = oldRequests > 0 ? bad(sample.previous) / oldRequests : 0
  const nextMean = mean(sample.next.wallMs)
  const previousMean = mean(sample.previous.wallMs)
  return {
    resolution: {
      newRequests,
      oldRequests,
      detectableErrorRate: detectableErrorRate(newRequests, oldRequests, baseline, z),
      detectableWallMs: detectableWallMs(sample.next.wallMs.length, sample.previous.wallMs.length, variance([...sample.next.wallMs, ...sample.previous.wallMs]), z),
    },
    wallDeltaMs: nextMean === null || previousMean === null ? null : nextMean - previousMean,
  }
}

/** `observed` is more than `tolerance` times off `predicted`, either way. Zero against non-zero is off. */
function off(predicted: number, observed: number, tolerance: number): boolean {
  if (predicted === 0 && observed === 0) return false
  if (predicted === 0 || observed === 0) return true
  const ratio = observed / predicted
  return ratio > tolerance || ratio < 1 / tolerance
}

function num(value: number | null, digits = 0): string {
  if (value === null) return '-'
  return digits === 0 ? String(Math.round(value)) : value.toFixed(digits)
}

function resolutionText(r: StepResolution): string {
  return `new=${r.newRequests} old=${r.oldRequests} detectable_error_rate=${num(r.detectableErrorRate, 4)} detectable_wall_ms=${num(r.detectableWallMs, 1)}`
}

/** Prediction next to observation, and what drifted. `predicted` is null when there was no basis. */
export function compareStep(input: {
  readonly step: number
  readonly percent: number
  readonly basis: ForecastBasis | null
  readonly predicted: StepResolution | null
  readonly observed: StepResolution
  readonly wallDeltaMs: number | null
}, tolerance: number = FORECAST_TOLERANCE): ForecastCheck {
  const drift: string[] = []
  const p = input.predicted
  const o = input.observed
  if (p !== null) {
    if (off(p.newRequests, o.newRequests, tolerance)) drift.push(`new-version requests ${o.newRequests} vs predicted ${p.newRequests}`)
    if (off(p.oldRequests, o.oldRequests, tolerance)) drift.push(`old-version requests ${o.oldRequests} vs predicted ${p.oldRequests}`)
    if (p.detectableErrorRate !== null && o.detectableErrorRate !== null && o.detectableErrorRate > p.detectableErrorRate * tolerance) {
      drift.push(`detectable error rate ${num(o.detectableErrorRate, 4)} vs predicted ${num(p.detectableErrorRate, 4)}`)
    }
    if (p.detectableWallMs !== null && o.detectableWallMs !== null && o.detectableWallMs > p.detectableWallMs * tolerance) {
      drift.push(`detectable wall shift ${num(o.detectableWallMs, 1)}ms vs predicted ${num(p.detectableWallMs, 1)}ms`)
    }
  }
  const source = input.basis === null ? null : input.basis.source
  const predicted = p === null ? 'predicted=none' : `predicted(${source === null ? '-' : source}) ${resolutionText(p)}`
  const seen = `observed ${resolutionText(o)} wall_delta_ms=${num(input.wallDeltaMs, 1)}`
  const verdict = drift.length === 0 ? 'drift=none' : `drift="${drift.join('; ')}"`
  return {
    percent: input.percent,
    predicted: p,
    basis: source,
    observed: o,
    wallDeltaMs: input.wallDeltaMs,
    drift,
    line: `forecast step=${input.step} percent=${input.percent} ${predicted} | ${seen} ${verdict}`,
  }
}
