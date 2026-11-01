import { REVOKED_STATUS } from './baseline.ts'

/** Artifacts' own 403 text when the bearer this stage minted is dead. */
export const EXPIRED_TOKEN = 'Invalid or expired token'

/** Git info/refs on the scratch remote. The bearer is not part of the URL. */
export function artifactsProbeUrl(remote: string): string {
  const base = remote.endsWith('/') ? remote.slice(0, -1) : remote
  return `${base}/info/refs?service=git-upload-pack`
}

/** The post-revoke probe succeeded when Artifacts answered 403. */
export function revokeConfirmed(status: number): boolean {
  return status === REVOKED_STATUS
}

export type OpeningRevoke =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * The token Artifacts returns from repo create is revoked before the smoke mints its own.
 * The check is unevaluable without that token, a listed id, a successful revoke, and a 403.
 */
export function openingRevokeResult(input: {
  readonly hadToken: boolean
  readonly listed: number
  readonly revoked: boolean
  readonly confirmed: boolean
}): OpeningRevoke {
  if (!input.hadToken) return { ok: false, reason: 'repo create returned no token' }
  if (input.listed === 0) return { ok: false, reason: 'repo create token was not listed' }
  if (!input.revoked || !input.confirmed) return { ok: false, reason: 'repo create token was not revoked' }
  return { ok: true }
}

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
  if (evidence.status === REVOKED_STATUS && evidence.mintedToken && evidence.body.includes(EXPIRED_TOKEN)) return 'harness_fault'
  return 'worker'
}
