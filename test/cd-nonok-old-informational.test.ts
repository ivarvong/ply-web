import { strict as assert } from 'node:assert'
import { loadPolicy, DEFAULT_POLICY_PATH } from '../scripts/cd/policy.ts'
import { judgeStep, type StepInput } from '../scripts/cd/slo.ts'

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

test('non-ok on old version is informational only', () => {
  const { policy } = loadPolicy(DEFAULT_POLICY_PATH)
  const targetPercent = policy.steps.length > 0 ? policy.steps[0].percent : 10
  const aggregate = makeStepInput({ invocations: 10000 })
  const next = makeStepInput({ requests: 1000, invocations: 1000 })
  const previous = makeStepInput({ requests: 9000, invocations: 9000, errors: 5 })
  const decision = judgeStep({ next, previous, aggregate, targetPercent, policy })
  assert.notEqual(decision.outcome, 'rollback')
  assert.match(decision.reason, /informational|within burn|insufficient/i)
})

