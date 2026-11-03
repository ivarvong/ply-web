import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { loadPolicy, DEFAULT_POLICY_PATH } from '../scripts/cd/policy.ts'
import { statsFromEvents } from '../scripts/cd/telemetry.ts'
import { judgeStep, type StepInput } from '../scripts/cd/slo.ts'

type CfEvent = Record<string, unknown>

function randLCG(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (1664525 * s + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

function fetchEvent(version: string, outcome: string): CfEvent {
  return {
    $metadata: { type: 'cf-worker-event' },
    $workers: {
      eventType: 'fetch',
      scriptVersion: { id: version },
      outcome,
    },
  }
}

function logEvent(version: string, status: number): CfEvent {
  return {
    $metadata: { level: status >= 500 ? 'error' : 'info' },
    $workers: { scriptVersion: { id: version } },
    source: { msg: 'ply.request', http: { response: { statusCode: status } } },
  }
}

function eventVersion(e: CfEvent): string | null {
  const w = (e as any).$workers
  if (!w || typeof w !== 'object') return null
  const sv = (w as any).scriptVersion
  if (!sv || typeof sv !== 'object') return null
  const id = (sv as any).id
  return typeof id === 'string' ? id : null
}

function asStepInput(stats: ReturnType<typeof statsFromEvents>): StepInput {
  return {
    requests: stats.requests,
    invocations: stats.invocations,
    exceptions: stats.exceptions,
    errors: stats.errors,
    fivexx: stats.fivexx,
    errorLogs: stats.errorLogs,
    wallMs: stats.wallMs,
    v1: stats.v1,
  }
}

test('1000x: client-caused outcomes (canceled/clientDisconnected/responseStreamDisconnected) never roll back (old or new)', () => {
  const { policy } = loadPolicy(DEFAULT_POLICY_PATH)
  const targetPercent = policy.steps.length > 0 ? policy.steps[0].percent : 10
  const rand = randLCG(0x12345678)
  const NEW = 'new-ver'
  const OLD = 'old-ver'
  const clientOutcomes = ['canceled', 'clientDisconnected', 'responseStreamDisconnected'] as const

  let rollbacks = 0
  for (let i = 0; i < 1000; i++) {
    const events: CfEvent[] = []
    const nOld = 100 + Math.floor(rand() * 50)
    const nNew = 100 + Math.floor(rand() * 50)
    for (let j = 0; j < nOld; j++) events.push(fetchEvent(OLD, clientOutcomes[j % clientOutcomes.length]))
    for (let j = 0; j < nNew; j++) events.push(fetchEvent(NEW, clientOutcomes[(j + 1) % clientOutcomes.length]))
    const next = asStepInput(statsFromEvents(events.filter(e => eventVersion(e) === NEW), []))
    const previous = asStepInput(statsFromEvents(events.filter(e => eventVersion(e) === OLD), []))
    const aggregate = asStepInput(statsFromEvents(events, []))
    const decision = judgeStep({ next, previous, aggregate, targetPercent, policy })
    if (decision.outcome === 'rollback') rollbacks += 1
  }
  assert.equal(rollbacks, 0, `expected 0 rollbacks for client-caused outcomes, saw ${rollbacks}`)
})

test('1000x: new-version worker faults roll back (exception or 5xx)', () => {
  const { policy } = loadPolicy(DEFAULT_POLICY_PATH)
  const targetPercent = policy.steps.length > 0 ? policy.steps[0].percent : 10
  const rand = randLCG(0xC0FFEE)
  const NEW = 'new-ver'
  const OLD = 'old-ver'

  // A: exceptions on new
  let rollbackExceptions = 0
  for (let i = 0; i < 500; i++) {
    const events: CfEvent[] = []
    const nOld = 100 + Math.floor(rand() * 50)
    const nNew = 100 + Math.floor(rand() * 50)
    for (let j = 0; j < nOld; j++) events.push(fetchEvent(OLD, 'ok'))
    for (let j = 0; j < nNew; j++) events.push(fetchEvent(NEW, j === 0 ? 'exception' : 'ok'))
    const next = asStepInput(statsFromEvents(events.filter(e => eventVersion(e) === NEW), []))
    const previous = asStepInput(statsFromEvents(events.filter(e => eventVersion(e) === OLD), []))
    const aggregate = asStepInput(statsFromEvents(events, []))
    const decision = judgeStep({ next, previous, aggregate, targetPercent, policy })
    if (decision.outcome === 'rollback') rollbackExceptions += 1
  }

  // B: 5xx on new (via logs)
  let rollback5xx = 0
  for (let i = 0; i < 500; i++) {
    const events: CfEvent[] = []
    const nOld = 100 + Math.floor(rand() * 50)
    const nNew = 100 + Math.floor(rand() * 50)
    for (let j = 0; j < nOld; j++) events.push(fetchEvent(OLD, 'ok'))
    for (let j = 0; j < nNew; j++) events.push(fetchEvent(NEW, 'ok'))
    // one 5xx log on NEW
    events.push(logEvent(NEW, 503))
    const next = asStepInput(statsFromEvents(events.filter(e => eventVersion(e) === NEW), []))
    const previous = asStepInput(statsFromEvents(events.filter(e => eventVersion(e) === OLD), []))
    const aggregate = asStepInput(statsFromEvents(events, []))
    const decision = judgeStep({ next, previous, aggregate, targetPercent, policy })
    if (decision.outcome === 'rollback') rollback5xx += 1
  }

  assert.equal(rollbackExceptions, 500, `expected 100% rollback with exceptions on new, saw ${rollbackExceptions}/500`)
  assert.equal(rollback5xx, 500, `expected 100% rollback with 5xx on new, saw ${rollback5xx}/500`)
})

test('regression: 021b436e — two timed-out probes (2/2000) do not roll back', () => {
  const { policy } = loadPolicy(DEFAULT_POLICY_PATH)
  const targetPercent = policy.steps.length > 0 ? policy.steps[0].percent : 10
  const NEW = 'new-ver'
  const OLD = 'old-ver'
  const events: CfEvent[] = []
  // 1998 ok fetches split evenly, plus 2 client timeouts on old
  for (let i = 0; i < 999; i++) events.push(fetchEvent(NEW, 'ok'))
  for (let i = 0; i < 999; i++) events.push(fetchEvent(OLD, 'ok'))
  events.push(fetchEvent(OLD, 'canceled'))
  events.push(fetchEvent(OLD, 'clientDisconnected'))
  const next = asStepInput(statsFromEvents(events.filter(e => eventVersion(e) === NEW), []))
  const previous = asStepInput(statsFromEvents(events.filter(e => eventVersion(e) === OLD), []))
  const aggregate = asStepInput(statsFromEvents(events, []))
  const decision = judgeStep({ next, previous, aggregate, targetPercent, policy })
  assert.notEqual(decision.outcome, 'rollback')
})

