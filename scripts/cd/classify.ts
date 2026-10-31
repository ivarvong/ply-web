/** Artifacts' own 403 text when the bearer this stage minted is dead. */
export const EXPIRED_TOKEN = 'Invalid or expired token'

export type FailureClass = 'harness_fault' | 'worker'

export type CallEvidence = {
  readonly status: number
  readonly body: string
  /** Abort, curl 000, or no HTTP response. */
  readonly timedOut: boolean
  /** The call presented a token this stage minted. */
  readonly mintedToken: boolean
}

/**
 * No response is the harness: the version was never reached.
 * A 403 that names a token minted in this stage is the same fault.
 * A Worker that answered anything else is a version failure.
 */
export function classifyCall(evidence: CallEvidence): FailureClass {
  if (evidence.timedOut || evidence.status === 0) return 'harness_fault'
  if (evidence.status === 403 && evidence.mintedToken && evidence.body.includes(EXPIRED_TOKEN)) return 'harness_fault'
  return 'worker'
}
