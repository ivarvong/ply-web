import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { REPO_PREFIX } from '../scripts/cd/baseline.ts'
import {
  appendCleanupFile,
  classifyDelete,
  cleanupLeakNames,
  confirmDelete,
  recordCleanup,
  reposFromList,
  sweepLeaks,
  type DeleteCommand,
} from '../scripts/cd/cleanup.ts'
import { asRecord } from '../scripts/cd/json.ts'
import { parseEvent, RunLog } from '../scripts/cd/log.ts'
import { DEFAULT_POLICY_PATH, loadPolicy } from '../scripts/cd/policy.ts'

const TIMEOUT = 'APIError: timeout'
const ABSENT = 'APIError: 404 [10200] Repository not found'
const REPO = `${REPO_PREFIX}20261101172943-ab12cd`

function command(code: number, stderr: string, latencyMs: number): DeleteCommand {
  return { code, stdout: '', stderr, latencyMs }
}

function scripted(commands: readonly DeleteCommand[]): () => Promise<DeleteCommand> {
  const pending = [...commands]
  return async () => {
    const next = pending.shift()
    if (!next) throw new Error('no more delete commands')
    return next
  }
}

test('a timeout then a 404 confirms the delete and keeps the 103s latency', async () => {
  const policy = loadPolicy(DEFAULT_POLICY_PATH).policy.cleanup
  const waits: number[] = []
  const result = await confirmDelete(REPO, { attempts: policy.attempts, backoffMs: policy.backoffMs }, {
    once: scripted([
      command(1, TIMEOUT, policy.calibration.latencyMs),
      command(1, ABSENT, 400),
    ]),
    sleep: async ms => {
      waits.push(ms)
    },
  })
  assert.equal(result.kind, 'deleted')
  assert.equal(result.repo, REPO)
  assert.equal(result.attempts.length, 2)
  const first = result.attempts[0]
  const second = result.attempts[1]
  if (!first || !second) throw new Error('missing attempt')
  assert.equal(first.kind, 'transient')
  assert.equal(first.latencyMs, 103_000)
  assert.match(first.kind === 'transient' ? first.detail : '', /timeout/)
  assert.equal(second.kind, 'absent')
  assert.equal(second.latencyMs, 400)
  assert.deepEqual(waits, [policy.backoffMs])
})

test('a 404 on the first try is deleted, and exit 0 is deleted', () => {
  const absent = classifyDelete(command(1, ABSENT, 180))
  assert.equal(absent.kind, 'absent')
  assert.equal(absent.latencyMs, 180)
  const gone = classifyDelete(command(1, 'Repository not found', 20))
  assert.equal(gone.kind, 'absent')
  const code = classifyDelete(command(1, 'error [10200]', 20))
  assert.equal(code.kind, 'absent')
  const deleted = classifyDelete(command(0, TIMEOUT, 103_000))
  assert.equal(deleted.kind, 'deleted')
  assert.equal(deleted.latencyMs, 103_000)
})

test('a persistent timeout records a cleanup_leak and does not fail a pass', async () => {
  const policy = loadPolicy(DEFAULT_POLICY_PATH).policy.cleanup
  const waits: number[] = []
  const result = await confirmDelete(REPO, { attempts: policy.attempts, backoffMs: policy.backoffMs }, {
    once: scripted([
      command(1, TIMEOUT, 103_000),
      command(1, TIMEOUT, 103_000),
      command(1, TIMEOUT, 103_000),
      command(1, ABSENT, 10),
    ]),
    sleep: async ms => {
      waits.push(ms)
    },
  })
  assert.equal(result.kind, 'leak')
  if (result.kind !== 'leak') return
  assert.equal(result.repo, REPO)
  assert.equal(result.attempts.length, policy.attempts)
  assert.deepEqual(waits, [policy.backoffMs, policy.backoffMs * 2])
  const dir = await mkdtemp(join(tmpdir(), 'ply-cd-cleanup-'))
  const ledger = join(dir, 'ledger.jsonl')
  const runDir = join(dir, 'run')
  const log = await RunLog.open(runDir, ledger, 'run-cleanup')
  await recordCleanup(log, result, { attempts: policy.attempts, backoffMs: policy.backoffMs })
  await appendCleanupFile(runDir, [result.repo])
  const stored = cleanupLeakNames(JSON.parse(await readFile(join(runDir, 'cleanup.json'), 'utf8')) as unknown)
  assert.deepEqual(stored, [REPO])
  const verdict = { kind: 'pass' as const, failures: [] as const, cleanup_leak: stored }
  assert.equal(verdict.kind, 'pass')
  assert.deepEqual(verdict.cleanup_leak, [REPO])
  const lines = (await readFile(ledger, 'utf8')).trim().split('\n')
  let sawLatency = false
  let sawLeak = false
  for (const line of lines) {
    const event = parseEvent(JSON.parse(line) as unknown)
    if (event.kind === 'observation') {
      const measurement = asRecord(event.payload.measurement)
      if (!measurement) continue
      if (measurement.source === 'repo-delete' && measurement.latencyMs === 103_000 && measurement.repo === REPO) sawLatency = true
      if (measurement.source === 'cleanup-leak' && measurement.repo === REPO) sawLeak = true
    }
    if (event.kind === 'decision') {
      assert.equal(event.payload.outcome, 'cleanup_leak')
      assert.match(event.payload.reason, new RegExp(REPO))
      assert.match(event.payload.reason, /103000ms transient/)
    }
  }
  assert.equal(sawLatency, true)
  assert.equal(sawLeak, true)
})

test('sweep deletes only stale prefixed repos and records a leak when delete stays unconfirmed', async () => {
  const now = Date.parse('2026-11-01T17:29:43.122Z')
  const hour = 60 * 60 * 1000
  const listed = reposFromList([
    { name: `${REPO_PREFIX}old`, created_at: new Date(now - hour - 1).toISOString() },
    { name: `${REPO_PREFIX}fresh`, created_at: new Date(now - 60_000).toISOString() },
    { name: `${REPO_PREFIX}stuck`, created_at: new Date(now - 2 * hour).toISOString() },
    { name: `${REPO_PREFIX}gone`, created_at: new Date(now - 3 * hour).toISOString() },
    { name: 'other-repo', created_at: new Date(now - 3 * hour).toISOString() },
    { name: `${REPO_PREFIX}undated` },
    { name: '', created_at: new Date(now - 3 * hour).toISOString() },
  ])
  const called: string[] = []
  const report = await sweepLeaks({
    listed,
    nowMs: now,
    staleMs: hour,
    prefix: REPO_PREFIX,
    bound: { attempts: 2, backoffMs: 0 },
    once: async name => {
      called.push(name)
      if (name.endsWith('stuck')) return command(1, TIMEOUT, 103_000)
      if (name.endsWith('gone')) return command(1, ABSENT, 250)
      return command(0, '', 30)
    },
    sleep: async () => {},
    note: async () => {},
  })
  assert.deepEqual(called.filter((name, index) => called.indexOf(name) === index), [
    `${REPO_PREFIX}old`,
    `${REPO_PREFIX}stuck`,
    `${REPO_PREFIX}gone`,
  ])
  assert.deepEqual(report.deleted, [`${REPO_PREFIX}old`, `${REPO_PREFIX}gone`])
  assert.deepEqual(report.leaks, [`${REPO_PREFIX}stuck`])
  const stuckCalls = called.filter(name => name.endsWith('stuck'))
  assert.equal(stuckCalls.length, 2)
})
