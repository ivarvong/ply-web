import { strict as assert } from 'node:assert'
import { loadPolicy, DEFAULT_POLICY_PATH } from '../scripts/cd/policy.ts'
import { judgeStep, type StepInput } from '../scripts/cd/slo.ts'

// Deterministic LCG RNG
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

function makeStepInput(overrides: Partial<StepInput> = {}): StepInput {
  const base: StepInput = {
    requests: 0,
    invocations: 10000,
    exceptions: 0,
    errors: 0,
    fivexx: 0,
    errorLogs: 0,
    wallMs: [],
    v1: [],
  }
  return { ...base, ...overrides }
}

test('1000x sim: 0 rollbacks on old-version loss/timeouts; 100% rollback on new-version 5xx', () => {
  const { policy } = loadPolicy(DEFAULT_POLICY_PATH)
  const targetPercent = policy.steps.length > 0 ? policy.steps[0].percent : 10
  const rand = lcg(0xC0FFEE)

  // Scenario A: old-version timeouts/loss as non-ok outcomes → never rollback
  let falseRollbacks = 0
  for (let i = 0; i < 1000; i++) {
    // Randomly pick a small number of non-ok outcomes on old
    const nonOkOld = Math.floor(rand() * 10)
    const aggregate = makeStepInput({ invocations: 10000 })
    const next = makeStepInput({ requests: 1000, invocations: 1000 })
    const previous = makeStepInput({ requests: 9000, invocations: 9000, errors: nonOkOld })
    const decision = judgeStep({ next, previous, aggregate, targetPercent, policy })
    if (decision.outcome === 'rollback') falseRollbacks += 1
  }
  assert.equal(falseRollbacks, 0, `expected 0 false rollbacks, saw ${falseRollbacks}`)

  // Scenario B: new-version server errors → always rollback
  let rollbacks = 0
  for (let i = 0; i < 1000; i++) {
    const fivexxNew = 1 + Math.floor(rand() * 3) // at least one 5xx
    const aggregate = makeStepInput({ invocations: 10000 })
    const next = makeStepInput({ requests: 1000, invocations: 1000, fivexx: fivexxNew })
    const previous = makeStepInput({ requests: 9000, invocations: 9000 })
    const decision = judgeStep({ next, previous, aggregate, targetPercent, policy })
    if (decision.outcome === 'rollback') rollbacks += 1
  }
  assert.equal(rollbacks, 1000, `expected 100% rollback on new 5xx, saw ${rollbacks}/1000`)
})

