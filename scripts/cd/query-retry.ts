// The ramp's observability query is lossy the same way a probe is.
// Run 2026-11-01T19-17-18-170Z (web 07568e0, ply 1743461) reached 100% with 0 errors
// and 0 probe loss, then `cf o11y telemetry query --body` exited 1 with
// APIError "timeout" Envelope Error. That one miss rolled the release back.
import { assertNever } from '../../src/never.ts'
import { activeLog, type ObservationRef, type RunLog } from './log.ts'

/** One `cf o11y telemetry query` invocation, timed by the caller. */
export type QueryCommand = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly latencyMs: number
}

/** Exit 0 is the page. Anything else is retried until the policy bound. */
export type QueryAttempt =
  | { readonly kind: 'ok'; readonly latencyMs: number; readonly stdout: string }
  | { readonly kind: 'transient'; readonly latencyMs: number; readonly detail: string }

/** `attempts` is the bound. The wait before retry n is `backoffMs * 2^(n-1)`. */
export type QueryBound = {
  readonly attempts: number
  readonly backoffMs: number
}

export type QueryResult =
  | { readonly kind: 'ok'; readonly stdout: string; readonly attempts: readonly QueryAttempt[] }
  | { readonly kind: 'lost'; readonly attempts: readonly QueryAttempt[] }

export type QueryStep =
  | { readonly kind: 'call' }
  | { readonly kind: 'wait'; readonly waitMs: number }
  | { readonly kind: 'done'; readonly result: QueryResult }

export type QueryIo = {
  readonly once: () => Promise<QueryCommand>
  readonly sleep: (ms: number) => Promise<void>
}

type QueryLog = {
  observation(input: {
    readonly measurement: unknown
    readonly query: unknown
    readonly from: number
    readonly to: number
    readonly raw: string
  }): Promise<ObservationRef>
}

function clip(text: string, code: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return `exit ${code}`
  return flat.slice(0, 240)
}

/** A non-zero exit is transient, including APIError "timeout" Envelope Error. The page is exit 0. */
export function classifyQuery(command: QueryCommand): QueryAttempt {
  if (command.code === 0) return { kind: 'ok', latencyMs: command.latencyMs, stdout: command.stdout }
  return { kind: 'transient', latencyMs: command.latencyMs, detail: clip(`${command.stdout}\n${command.stderr}`, command.code) }
}

function succeeded(attempts: readonly QueryAttempt[]): QueryAttempt | null {
  for (const attempt of attempts) {
    switch (attempt.kind) {
      case 'ok':
        return attempt
      case 'transient':
        break
      default:
        return assertNever(attempt)
    }
  }
  return null
}

/** Stop on the first page, or when `bound.attempts` is exhausted. Exhaustion is a lost query. */
export function queryStep(attempts: readonly QueryAttempt[], bound: QueryBound): QueryStep {
  const page = succeeded(attempts)
  if (page && page.kind === 'ok') return { kind: 'done', result: { kind: 'ok', stdout: page.stdout, attempts } }
  if (attempts.length >= bound.attempts) return { kind: 'done', result: { kind: 'lost', attempts } }
  if (attempts.length === 0) return { kind: 'call' }
  return { kind: 'wait', waitMs: bound.backoffMs * 2 ** (attempts.length - 1) }
}

export async function retryQuery(bound: QueryBound, io: QueryIo): Promise<QueryResult> {
  const attempts: QueryAttempt[] = []
  for (;;) {
    const step = queryStep(attempts, bound)
    switch (step.kind) {
      case 'done':
        return step.result
      case 'wait':
        await io.sleep(step.waitMs)
        attempts.push(classifyQuery(await io.once()))
        break
      case 'call':
        attempts.push(classifyQuery(await io.once()))
        break
      default:
        return assertNever(step)
    }
  }
}

export function currentLog(): RunLog | null {
  const log = activeLog()
  if (!log) return null
  return log
}

function attemptDetail(attempt: QueryAttempt): string {
  switch (attempt.kind) {
    case 'transient':
      return attempt.detail
    case 'ok':
      return ''
    default:
      return assertNever(attempt)
  }
}

/** One observation per invocation. The latency is the measurement; a miss is not a decision by itself. */
export async function recordQueryAttempt(log: QueryLog | null, ordinal: number, attempt: QueryAttempt): Promise<void> {
  if (log === null) return
  const to = Date.now()
  const measurement = {
    source: 'telemetry-query',
    attempt: ordinal,
    kind: attempt.kind,
    latencyMs: attempt.latencyMs,
    detail: attemptDetail(attempt),
  }
  await log.observation({
    measurement,
    query: { source: 'telemetry-query' },
    from: to - attempt.latencyMs,
    to,
    raw: JSON.stringify(measurement),
  })
}
