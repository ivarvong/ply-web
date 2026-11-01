// A ramp probe is either a server response or a client-side loss. Loss is not an error.
// The measured loss is 1/790 on run 2026-11-01T17-06-08-780Z (web 789ba93, ply 1743461).
import { none, some, type Option } from '../../src/option.ts'
import { assertNever } from '../../src/never.ts'

/** Why a probe never produced a status or a ray. */
export type ProbeLossReason = 'aborted' | 'network'

export type ProbeOutcome =
  | {
    readonly kind: 'responded'
    readonly id: string
    readonly status: number
    readonly ray: Option<string>
  }
  | {
    readonly kind: 'lost'
    readonly id: string
    readonly reason: ProbeLossReason
  }

/** What `fetch` did, before it is a probe outcome. A thrown attempt has no status and no ray. */
export type FetchAttempt =
  | { readonly kind: 'response'; readonly status: number; readonly ray: Option<string> }
  | { readonly kind: 'thrown'; readonly name: string; readonly message: string }

export type ProbeLoss = {
  readonly total: number
  readonly count: number
  readonly rate: number
  readonly maxLossRate: number
  readonly exceeded: boolean
  /** Responded probes only. A lost probe is not a server error and is not in this count. */
  readonly responded: number
  /** HTTP status >= 500 among responded probes. Lost probes are not included. */
  readonly serverErrors: number
  readonly ids: readonly string[]
}

export type ProbeWindow =
  | { readonly kind: 'ok'; readonly loss: ProbeLoss }
  | { readonly kind: 'harness_fault'; readonly loss: ProbeLoss; readonly reason: string }
  | { readonly kind: 'insufficient_samples'; readonly loss: ProbeLoss; readonly reason: string }

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
  if (name === 'AbortError' || name === 'TimeoutError') return 'aborted'
  if (message.includes('aborted') || message.includes('timeout')) return 'aborted'
  return 'network'
}

/**
 * A thrown fetch has no status and no ray, so it is a loss. Status 0 is the same:
 * the client has no HTTP response. Any other status is a response, ray or not.
 */
export function classifyProbe(id: string, attempt: FetchAttempt): ProbeOutcome {
  switch (attempt.kind) {
    case 'thrown':
      return { kind: 'lost', id, reason: lossReason(attempt.name, attempt.message) }
    case 'response':
      if (attempt.status === 0) return { kind: 'lost', id, reason: 'network' }
      return { kind: 'responded', id, status: attempt.status, ray: attempt.ray }
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
  }
}

/** Count, rate, and the ids of probes that never got a response. `exceeded` is `rate > maxLossRate`. */
export function accountProbeLoss(outcomes: readonly ProbeOutcome[], maxLossRate: number): ProbeLoss {
  const ids: string[] = []
  let responded = 0
  let serverErrors = 0
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'lost':
        ids.push(outcome.id)
        break
      case 'responded':
        responded += 1
        if (outcome.status >= 500) serverErrors += 1
        break
      default:
        assertNever(outcome)
    }
  }
  const total = outcomes.length
  const count = ids.length
  const rate = total === 0 ? 0 : count / total
  return { total, count, rate, maxLossRate, exceeded: rate > maxLossRate, responded, serverErrors, ids }
}

/**
 * Loss above `maxLossRate` is a harness fault. Otherwise the step is judged on responded
 * probes only, and that count still has to reach `minSamples`. A short sample is not a pass.
 * No probes at all (the dwell did not send any) is not a loss.
 */
export function judgeProbeWindow(outcomes: readonly ProbeOutcome[], maxLossRate: number, minSamples: number): ProbeWindow {
  const loss = accountProbeLoss(outcomes, maxLossRate)
  if (loss.total === 0) return { kind: 'ok', loss }
  if (loss.exceeded) {
    const rate = (loss.rate * 100).toFixed(2)
    const max = (loss.maxLossRate * 100).toFixed(2)
    return {
      kind: 'harness_fault',
      loss,
      reason: `probe loss ${loss.count}/${loss.total} (${rate}%) exceeds probe.maxLossRate ${max}%`,
    }
  }
  if (loss.responded < minSamples) {
    return {
      kind: 'insufficient_samples',
      loss,
      reason: `insufficient samples: ${loss.responded} responded probes < ${minSamples}; ${loss.count} lost`,
    }
  }
  return { kind: 'ok', loss }
}

/** Header absence for a responded probe. An empty header is none. */
export function rayOf(header: string | null): Option<string> {
  if (header === null || header.length === 0) return none()
  return some(header)
}
