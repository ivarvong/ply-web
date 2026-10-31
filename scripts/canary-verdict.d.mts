// Types for scripts/canary-verdict.mjs. The loss policy stays in that module; the CD telemetry gate calls it.

export type CanaryRequest = {
  readonly id: string
  readonly version: string | null
  readonly step: string
}

export type CanaryHealth = {
  readonly nonOk: number
  readonly fivexx: number
  readonly errorLogs: number
}

export type CanaryOther = CanaryRequest & { readonly loggedBy: readonly string[] }

export type CanaryVerdict = {
  readonly pass: boolean
  readonly total: number
  readonly matched: number
  readonly allowance: number
  readonly lost: readonly CanaryRequest[]
  readonly unconfirmed: readonly CanaryRequest[]
  readonly otherVersion: readonly CanaryOther[]
  readonly reasons: readonly string[]
  readonly line: string
}

export function lossAllowance(n: number): number

export function verdict(input: {
  readonly version: string
  readonly requests: readonly CanaryRequest[]
  readonly loggedBy: ReadonlyMap<string, ReadonlySet<string>>
  readonly health: CanaryHealth
}): CanaryVerdict
