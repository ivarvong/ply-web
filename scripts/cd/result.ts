export type StageName = 'bump' | 'deploy-canary' | 'smoke' | 'telemetry' | 'ramp' | 'rollback'

export type Pass<T> = {
  readonly kind: 'pass'
  readonly stage: StageName
  readonly value: T
}

export type Fault = 'worker' | 'harness_fault' | 'state_conflict'

export type Fail = {
  readonly kind: 'fail'
  readonly stage: StageName
  readonly reason: string
  /** The ramp (or a safety check) already moved traffic back to the previous version at 100%. */
  readonly rolledBack: boolean
  /** `harness_fault` and `state_conflict` leave the split where it is. */
  readonly fault: Fault
}

export type StageResult<T> = Pass<T> | Fail

export function pass<T>(stage: StageName, value: T): Pass<T> {
  return { kind: 'pass', stage, value }
}

export function fail(stage: StageName, reason: string, rolledBack = false, fault: Fault = 'worker'): Fail {
  return { kind: 'fail', stage, reason, rolledBack, fault }
}
