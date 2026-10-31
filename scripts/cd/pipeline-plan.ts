export type Phase =
  | 'bump'
  | 'deploy-canary'
  | 'smoke-canary'
  | 'telemetry-canary'
  | 'ramp'
  | 'smoke-live'
  | 'telemetry-live'
  | 'rollback'
  | 'halt'
  | 'done'

export type PhaseOutcome = 'pass' | 'fail' | 'rolled-back' | 'harness-stop' | 'state-conflict'

export type PipelineState = {
  readonly phase: Phase
  readonly smoke: PhaseOutcome | null
}

export function pipelineStart(): PipelineState {
  return { phase: 'bump', smoke: null }
}

/**
 * The operator pipeline. A pinned smoke failure halts: the canary stays at 0% and
 * telemetry does not run. A ramp rollback is already done, so the pipeline halts
 * instead of rolling back again. A live worker failure enters rollback. A harness fault
 * or a state conflict stops with the split held.
 */
export function nextPhase(state: PipelineState, outcome: PhaseOutcome): PipelineState {
  if (outcome === 'harness-stop' || outcome === 'state-conflict') return { phase: 'halt', smoke: state.smoke }
  switch (state.phase) {
    case 'bump':
      return outcome === 'pass' ? { phase: 'deploy-canary', smoke: null } : { phase: 'halt', smoke: null }
    case 'deploy-canary':
      return outcome === 'pass' ? { phase: 'smoke-canary', smoke: null } : { phase: 'halt', smoke: null }
    case 'smoke-canary':
      return outcome === 'pass'
        ? { phase: 'telemetry-canary', smoke: outcome }
        : { phase: 'halt', smoke: outcome }
    case 'telemetry-canary':
      return outcome === 'pass' && state.smoke === 'pass'
        ? { phase: 'ramp', smoke: state.smoke }
        : { phase: 'halt', smoke: state.smoke }
    case 'ramp':
      return outcome === 'pass' ? { phase: 'smoke-live', smoke: state.smoke } : { phase: 'halt', smoke: state.smoke }
    case 'smoke-live':
      return outcome === 'pass' ? { phase: 'telemetry-live', smoke: state.smoke } : { phase: 'rollback', smoke: state.smoke }
    case 'telemetry-live':
      return outcome === 'pass' ? { phase: 'done', smoke: state.smoke } : { phase: 'rollback', smoke: state.smoke }
    case 'rollback':
      return { phase: 'halt', smoke: state.smoke }
    case 'halt':
    case 'done':
      return state
  }
}
