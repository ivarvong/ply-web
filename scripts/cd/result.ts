export type StageName = 'bump' | 'deploy-canary' | 'smoke' | 'telemetry' | 'ramp' | 'visual' | 'rollback'

export type Pass<T> = {
  readonly kind: 'pass'
  readonly stage: StageName
  readonly value: T
}

export type Fault = 'worker' | 'harness_fault' | 'state_conflict' | 'insufficient_samples' | 'harness_unhealthy'

export type Fail = {
  readonly kind: 'fail'
  readonly stage: StageName
  readonly reason: string
  /** The ramp (or a safety check) already moved traffic back to the previous version at 100%. */
  readonly rolledBack: boolean
  /**
   * `harness_fault`, `insufficient_samples` and `harness_unhealthy` are unjudged steps. Above 0% each has
   * already settled traffic through `probe.onHarnessFault`: rolled back to `previous` (`rollback`, `telemetry`),
   * or held at the last fully passed split (`hold`; rolled back when no step passed). The reason ends with where
   * traffic went; when that rollback or hold write failed it ends `…failed: <error>; still at N%` and `rolledBack`
   * is false, because the new, unjudged version still serves N%. `state_conflict` does not move traffic. `insufficient_samples` is not a pass and is not a
   * correctness failure. `harness_unhealthy` is the client itself (a stalled box): no product verdict on the Worker.
   */
  readonly fault: Fault
}

export type StageResult<T> = Pass<T> | Fail

export function pass<T>(stage: StageName, value: T): Pass<T> {
  return { kind: 'pass', stage, value }
}

export function fail(stage: StageName, reason: string, rolledBack = false, fault: Fault = 'worker'): Fail {
  return { kind: 'fail', stage, reason, rolledBack, fault }
}
