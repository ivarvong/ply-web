import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { none } from '../src/option.ts'
import { asRecord } from '../scripts/cd/json.ts'
import { parseEvent, RunLog } from '../scripts/cd/log.ts'
import { parsePolicy, type RolloutPolicy } from '../scripts/cd/policy.ts'
import { accountProbeLoss, type ProbeOutcome } from '../scripts/cd/probe.ts'
import {
  classifyQuery,
  recordQueryAttempt,
  retryQuery,
  type QueryCommand,
} from '../scripts/cd/query-retry.ts'
import { decideWithoutTelemetry, runRamp } from '../scripts/cd/ramp.ts'

const TIMEOUT = 'APIError: timeout Envelope Error'

function command(code: number, stderr: string, latencyMs: number, stdout = ''): QueryCommand {
  return { code, stdout, stderr, latencyMs }
}

function scripted(commands: readonly QueryCommand[]): () => Promise<QueryCommand> {
  const pending = [...commands]
  return async () => {
    const next = pending.shift()
    if (!next) throw new Error('no more query commands')
    return next
  }
}

function policy(): RolloutPolicy {
  const raw = JSON.parse(readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')) as Record<string, unknown>
  raw.steps = [{ percent: 100, dwellMs: 1 }]
  return parsePolicy(JSON.stringify(raw)).policy
}

function probes(count: number, status: number): ProbeOutcome[] {
  const outcomes: ProbeOutcome[] = []
  for (let index = 0; index < count; index += 1) {
    outcomes.push({ kind: 'responded', id: `probe-${index}`, status, ray: none() })
  }
  return outcomes
}

test('a timeout then a page is a sample, and the timeout latency is kept', async () => {
  const bound = policy().telemetry.query
  const waits: number[] = []
  const result = await retryQuery(
    { attempts: bound.attempts, backoffMs: bound.backoffMs },
    {
      once: scripted([
        command(1, TIMEOUT, 80_000),
        command(0, '', 400, '{"events":[]}'),
      ]),
      sleep: async ms => {
        waits.push(ms)
      },
    },
  )
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(result.stdout, '{"events":[]}')
  assert.equal(result.attempts.length, 2)
  const first = result.attempts[0]
  const second = result.attempts[1]
  if (!first || !second) throw new Error('missing attempt')
  assert.equal(first.kind, 'transient')
  assert.equal(first.latencyMs, 80_000)
  assert.match(first.kind === 'transient' ? first.detail : '', /timeout Envelope Error/)
  assert.equal(second.kind, 'ok')
  assert.equal(second.latencyMs, 400)
  assert.deepEqual(waits, [bound.backoffMs])
  const lost = classifyQuery(command(1, 'APIError "timeout" Envelope Error', 80_000))
  assert.equal(lost.kind, 'transient')
})

test('a persistent timeout records each attempt and does not fault a clean probe window', async () => {
  const rollout = policy()
  const bound = rollout.telemetry.query
  const waits: number[] = []
  const result = await retryQuery(
    { attempts: bound.attempts, backoffMs: bound.backoffMs },
    {
      once: scripted([
        command(1, TIMEOUT, 80_000),
        command(1, TIMEOUT, 80_000),
        command(1, TIMEOUT, 80_000),
        command(0, '', 10, '{}'),
      ]),
      sleep: async ms => {
        waits.push(ms)
      },
    },
  )
  assert.equal(result.kind, 'lost')
  if (result.kind !== 'lost') return
  assert.equal(result.attempts.length, bound.attempts)
  assert.deepEqual(waits, [bound.backoffMs, bound.backoffMs * 2])
  const dir = await mkdtemp(join(tmpdir(), 'ply-cd-query-'))
  const ledger = join(dir, 'ledger.jsonl')
  const log = await RunLog.open(join(dir, 'run'), ledger, 'run-query')
  let ordinal = 0
  for (const attempt of result.attempts) {
    ordinal += 1
    await recordQueryAttempt(log, ordinal, attempt)
  }
  const lines = (await readFile(ledger, 'utf8')).trim().split('\n')
  assert.equal(lines.length, bound.attempts)
  for (const line of lines) {
    const event = parseEvent(JSON.parse(line) as unknown)
    assert.equal(event.kind, 'observation')
    if (event.kind !== 'observation') continue
    const measurement = asRecord(event.payload.measurement)
    if (!measurement) throw new Error('missing measurement')
    assert.equal(measurement.source, 'telemetry-query')
    assert.equal(measurement.kind, 'transient')
    assert.equal(measurement.latencyMs, 80_000)
    assert.match(String(measurement.detail), /timeout Envelope Error/)
  }
  const clean = accountProbeLoss(probes(rollout.burn.minSamples, 200), rollout.probe.maxLossRate)
  const advance = decideWithoutTelemetry(clean, rollout, 'telemetry unavailable: APIError "timeout" Envelope Error')
  assert.equal(advance.outcome, 'advance')
  assert.match(advance.reason, /informational: telemetry query lost/)
  assert.match(advance.reason, /100 responded probes, 0 server errors/)
  let rolled = 0
  const ramp = await runRamp(rollout, {
    now: () => 0,
    sleep: async () => {},
    dwell: async () => ({ outcomes: probes(rollout.burn.minSamples, 200) }),
    applySplit: async () => null,
    observe: async () => ({ kind: 'unavailable', reason: 'telemetry unavailable: APIError "timeout" Envelope Error' }),
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.equal(ramp.state.kind, 'complete')
  assert.equal(rolled, 0)
  const line = ramp.lines[0]
  if (!line) throw new Error('missing ramp line')
  assert.match(line, /decision=advance/)
  assert.match(line, /telemetry query lost/)
})

test('a persistent timeout still rolls back when a responded probe was a 5xx', async () => {
  const rollout = policy()
  const sample = probes(rollout.burn.minSamples - 1, 200)
  sample.push({ kind: 'responded', id: 'probe-500', status: 500, ray: none() })
  const loss = accountProbeLoss(sample, rollout.probe.maxLossRate)
  const decision = decideWithoutTelemetry(loss, rollout, 'telemetry unavailable: timeout')
  assert.equal(decision.outcome, 'rollback')
  assert.match(decision.reason, /1 5xx on responded probes/)
  let rolled = 0
  const ramp = await runRamp(rollout, {
    now: () => 0,
    sleep: async () => {},
    dwell: async () => ({ outcomes: sample }),
    applySplit: async () => null,
    observe: async () => ({ kind: 'unavailable', reason: 'telemetry unavailable: timeout' }),
    rollback: async () => {
      rolled += 1
      return null
    },
  })
  assert.equal(ramp.state.kind, 'rolled-back')
  assert.equal(rolled, 1)
  const bare = decideWithoutTelemetry(null, rollout, 'telemetry unavailable: timeout')
  assert.equal(bare.outcome, 'harness_fault')
})
