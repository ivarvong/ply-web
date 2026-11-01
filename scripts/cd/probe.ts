// A ramp probe is a server response, a client-side loss, or a shed.
// Loss is not a server error. The measured abort is 1/790 on run 2026-11-01T17-06-08-780Z
// (web 789ba93, ply 1743461). Run 2026-11-01T19-40-35-485Z (web 22bfb79) stalled the
// scheduler: 10/128 never answered and both versions returned together at ~69830ms.
import { none, some, type Option } from '../../src/option.ts'
import { assertNever } from '../../src/never.ts'

/** Why an issued probe never produced a status or a ray. `timed_out` is the policy deadline, not a transport error. */
export type ProbeLossReason = 'aborted' | 'network' | 'timed_out'

export type ProbeOutcome =
  | {
    readonly kind: 'responded'
    readonly id: string
    readonly status: number
    readonly ray: Option<string>
    readonly latencyMs: number
    /** The `x-ply-version` header. A lost probe has no version, so this is only on a response. */
    readonly version: Option<string>
  }
  | {
    readonly kind: 'lost'
    readonly id: string
    readonly reason: ProbeLossReason
  }
  | {
    readonly kind: 'shed'
    readonly id: string
  }

/** What `fetch` did, before it is a probe outcome. A thrown attempt has no status and no ray. */
export type FetchAttempt =
  | {
    readonly kind: 'response'
    readonly status: number
    readonly ray: Option<string>
    readonly latencyMs: number
    readonly version: Option<string>
  }
  | { readonly kind: 'thrown'; readonly name: string; readonly message: string }
  | { readonly kind: 'timeout' }

export type ProbeLoss = {
  /** Issued probes: responded plus lost. A shed was never sent and is not in this denominator. */
  readonly total: number
  readonly count: number
  readonly rate: number
  readonly maxLossRate: number
  /** `rate > maxLossRate`. The loss-rate gate also requires `probe.minSamples` before it can fail a step. */
  readonly exceeded: boolean
  /** Responded probes only. A lost probe is not a server error and is not in this count. */
  readonly responded: number
  /** HTTP status >= 500 among responded probes. Lost probes are not included. */
  readonly serverErrors: number
  readonly ids: readonly string[]
  readonly timedOut: number
  readonly aborted: number
  readonly network: number
  readonly shed: number
}

export type ProbeWindow =
  | { readonly kind: 'ok'; readonly loss: ProbeLoss }
  | { readonly kind: 'harness_fault'; readonly loss: ProbeLoss; readonly reason: string }
  | { readonly kind: 'insufficient_samples'; readonly loss: ProbeLoss; readonly reason: string }
  | { readonly kind: 'rollback'; readonly loss: ProbeLoss; readonly reason: string }
  | { readonly kind: 'retry'; readonly loss: ProbeLoss; readonly reason: string }

/** Bounds for one probe window. `minSamples` is the loss-rate denominator; `respondedMin` is `burn.minSamples`. */
export type ProbeJudge = {
  readonly maxLossRate: number
  readonly respondedMin: number
  readonly minSamples: number
  readonly stallLatencyMs: number
  readonly fivexxHard: boolean
}

/** One step recorded in ramp.jsonl, events, and the verdict. */
export type ProbeLossRecord = {
  readonly percent: number
  readonly count: number
  readonly rate: number
  readonly total: number
  readonly responded: number
  readonly ids: readonly string[]
}

export function probeLossRecord(percent: number, loss: ProbeLoss): ProbeLossRecord {
  return {
    percent,
    count: loss.count,
    rate: loss.rate,
    total: loss.total,
    responded: loss.responded,
    ids: loss.ids,
  }
}

function lossReason(name: string, message: string): ProbeLossReason {
  if (name === 'TimeoutError') return 'timed_out'
  if (message.includes('timeout')) return 'timed_out'
  if (name === 'AbortError' || message.includes('aborted')) return 'aborted'
  return 'network'
}

/**
 * A thrown fetch has no status and no ray, so it is a loss. A policy timeout is
 * `timed_out`, distinct from a transport error. Status 0 is the same as no HTTP
 * response. Any other status is a response, ray or not.
 */
export function classifyProbe(id: string, attempt: FetchAttempt): ProbeOutcome {
  switch (attempt.kind) {
    case 'timeout':
      return { kind: 'lost', id, reason: 'timed_out' }
    case 'thrown':
      return { kind: 'lost', id, reason: lossReason(attempt.name, attempt.message) }
    case 'response':
      if (attempt.status === 0) return { kind: 'lost', id, reason: 'network' }
      return {
        kind: 'responded',
        id,
        status: attempt.status,
        ray: attempt.ray,
        latencyMs: attempt.latencyMs,
        version: attempt.version,
      }
    default:
      return assertNever(attempt)
  }
}

export function emptyProbeLoss(maxLossRate: number): ProbeLoss {
  return {
    total: 0,
    count: 0,
    rate: 0,
    maxLossRate,
    exceeded: false,
    responded: 0,
    serverErrors: 0,
    ids: [],
    timedOut: 0,
    aborted: 0,
    network: 0,
    shed: 0,
  }
}

/** Count, rate, and the ids of probes that never got a response. `exceeded` is `rate > maxLossRate`. */
export function accountProbeLoss(outcomes: readonly ProbeOutcome[], maxLossRate: number): ProbeLoss {
  const ids: string[] = []
  let responded = 0
  let serverErrors = 0
  let timedOut = 0
  let aborted = 0
  let network = 0
  let shed = 0
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'lost':
        ids.push(outcome.id)
        switch (outcome.reason) {
          case 'timed_out':
            timedOut += 1
            break
          case 'aborted':
            aborted += 1
            break
          case 'network':
            network += 1
            break
          default:
            return assertNever(outcome.reason)
        }
        break
      case 'responded':
        responded += 1
        if (outcome.status >= 500) serverErrors += 1
        break
      case 'shed':
        shed += 1
        break
      default:
        return assertNever(outcome)
    }
  }
  const total = responded + ids.length
  const count = ids.length
  const rate = total === 0 ? 0 : count / total
  return {
    total,
    count,
    rate,
    maxLossRate,
    exceeded: rate > maxLossRate,
    responded,
    serverErrors,
    ids,
    timedOut,
    aborted,
    network,
    shed,
  }
}

type VersionPace = {
  readonly slow: number
  readonly healthy: number
}

/** Versions that answered. A version is slow when any of its responses reached the stall latency. */
function versionPace(outcomes: readonly ProbeOutcome[], stallLatencyMs: number): VersionPace {
  const slow = new Set<string>()
  const seen = new Set<string>()
  for (const outcome of outcomes) {
    if (outcome.kind !== 'responded' || outcome.version.tag !== 'some') continue
    const id = outcome.version.value
    seen.add(id)
    if (outcome.latencyMs >= stallLatencyMs) slow.add(id)
  }
  return { slow: slow.size, healthy: seen.size - slow.size }
}

/**
 * A lost probe has no version. The window is a harness/network stall when the
 * responded probes do not split by version: both versions show the stall latency,
 * or both are healthy while the harness timed probes out or shed them. A one-sided
 * stall stays on the loss-rate gate.
 */
function harnessStall(loss: ProbeLoss, pace: VersionPace, judge: ProbeJudge): boolean {
  if (loss.serverErrors > 0) return false
  if (pace.slow > 0 && pace.healthy > 0) return false
  const harnessSide = loss.timedOut > 0 || loss.shed > 0
  const short = loss.total < judge.minSamples
  const sameSlow = pace.slow >= 2 && pace.healthy === 0 && loss.count > 0 && (loss.exceeded || short)
  const sameTimeout = harnessSide && pace.healthy >= 2 && pace.slow === 0 && (short || (loss.exceeded && loss.aborted === 0 && loss.network === 0))
  const noVersion = pace.slow === 0 && pace.healthy === 0 && harnessSide && (short || loss.exceeded)
  return sameSlow || sameTimeout || noVersion
}

function percent(value: number): string {
  return (value * 100).toFixed(2)
}

/**
 * A 5xx on a responded probe rolls back when this window would otherwise be
 * dismissed as a stall or as too small to gate. Loss above `maxLossRate` is a
 * harness fault only once `total` reaches `minSamples`. A harness stall is a
 * retry, not a rollback. Fewer responded probes than `respondedMin` is not a pass.
 * No probes and no sheds (the dwell sent nothing) is not a loss.
 */
export function judgeProbeWindow(outcomes: readonly ProbeOutcome[], judge: ProbeJudge): ProbeWindow {
  const loss = accountProbeLoss(outcomes, judge.maxLossRate)
  if (loss.total === 0 && loss.shed === 0) return { kind: 'ok', loss }
  const pace = versionPace(outcomes, judge.stallLatencyMs)
  const stall = harnessStall(loss, pace, judge)
  if (loss.serverErrors > 0 && judge.fivexxHard && (stall || loss.total < judge.minSamples)) {
    return {
      kind: 'rollback',
      loss,
      reason: `${loss.serverErrors} 5xx on responded probes`,
    }
  }
  if (stall) {
    const rate = percent(loss.rate)
    const band = pace.slow >= 2 ? 'both versions stalled together' : pace.healthy >= 2 ? 'both versions healthy' : 'no version on the losses'
    return {
      kind: 'retry',
      loss,
      reason: `harness/network stall: probe loss ${loss.count}/${loss.total} (${rate}%), timed_out ${loss.timedOut}, shed ${loss.shed}; ${band}; re-run the dwell`,
    }
  }
  if (loss.total >= judge.minSamples && loss.exceeded) {
    return {
      kind: 'harness_fault',
      loss,
      reason: `probe loss ${loss.count}/${loss.total} (${percent(loss.rate)}%) exceeds probe.maxLossRate ${percent(loss.maxLossRate)}%`,
    }
  }
  if (loss.responded < judge.respondedMin) {
    return {
      kind: 'insufficient_samples',
      loss,
      reason: `insufficient samples: ${loss.responded} responded probes < ${judge.respondedMin}; ${loss.count} lost`,
    }
  }
  return { kind: 'ok', loss }
}

/** Header absence for a responded probe. An empty header is none. */
export function rayOf(header: string | null): Option<string> {
  if (header === null || header.length === 0) return none()
  return some(header)
}
