import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { BLOB_DIR, RunLog } from '../scripts/cd/log.ts'
import { planRetention, pruneRuns, runStartedAt, statusFromEvents, type RetentionPolicy, type RunEntry } from '../scripts/cd/retention.ts'

async function temp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ply-cd-retention-'))
}

const PAGE = JSON.stringify({ events: Array.from({ length: 200 }, (_, i) => ({ id: i, wall: 12.5 })) }, null, 2)

async function pollingRun(dir: string, code: number, rolledBack = false): Promise<RunLog> {
  const log = await RunLog.open(dir, join(dir, '..', 'ledger.jsonl'), 'run')
  await log.started({ config: {}, tools: { node: 'v24', cf: 'cf', git: 'git' }, plySha: null, plyWebSha: 'abc', host: 'box' })
  for (let i = 0; i < 3; i++) {
    await log.noteCommand({ argv: ['cf', 'o11y', 'telemetry', 'query'], cwd: '/w', exitCode: 0, durationMs: 1, stdout: PAGE, stderr: '' })
  }
  const ref = await log.observation({ measurement: { source: 'ramp-step', nextRequests: 200 }, query: {}, from: 0, to: 1, raw: JSON.stringify({ pages: [log.digest(PAGE)] }) })
  await log.decision({ inputs: [ref], rules: [{ name: 'fast_burn', value: 14.4 }], outcome: code === 0 ? 'advance' : 'rollback', reason: 'r' })
  if (rolledBack) log.patch({ rolledBack: true, rollbackReason: 'burn' })
  await log.finish(code, code === 0 ? null : 'boom')
  return log
}

test('identical captures are stored once, gzipped, and the digest is the blob name', async () => {
  const dir = join(await temp(), 'run')
  const log = await pollingRun(dir, 1)
  const blobs = await readdir(join(dir, BLOB_DIR))
  // Three identical pages, one empty stderr, one observation body.
  assert.equal(blobs.length, 3)
  const command = log.recorded().find(event => event.kind === 'command')
  assert.ok(command && command.kind === 'command')
  assert.equal(command.payload.stdoutPath, `${BLOB_DIR}/${command.payload.stdoutDigest}.gz`)
  assert.equal(command.payload.stdoutDigest, log.digest(PAGE))
  const stored = gunzipSync(await readFile(join(dir, command.payload.stdoutPath))).toString('utf8')
  assert.equal(stored, PAGE)
  assert.ok((await readFile(join(dir, command.payload.stdoutPath))).length < PAGE.length / 5)
  assert.equal(existsSync(join(dir, 'captures')), false)
  assert.equal(existsSync(join(dir, 'raw')), false)
})

test('a clean pass drops its blobs at seal; a failure or a rollback keeps them', async () => {
  const root = await temp()
  for (const [name, code, rolledBack, kept] of [['pass', 0, false, false], ['fail', 1, false, true], ['rolled', 0, true, true]] as const) {
    const dir = join(root, name)
    const log = await pollingRun(dir, code, rolledBack)
    assert.equal(log.keepsBlobs, kept)
    await log.seal()
    assert.equal(existsSync(join(dir, BLOB_DIR)), kept, name)
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { blobs: string; files: Record<string, string> }
    assert.equal(manifest.blobs, kept ? 'kept' : 'dropped')
    assert.equal(Object.keys(manifest.files).some(file => file.startsWith(`${BLOB_DIR}/`)), kept)
    assert.ok(manifest.files['events.jsonl'])
  }
})

test('status comes from the last run_finished; a rollback is a failure', () => {
  const line = (payload: object) => JSON.stringify({ seq: 1, kind: 'lifecycle', payload })
  assert.equal(statusFromEvents(line({ event: 'run_started' })), 'unfinished')
  assert.equal(statusFromEvents(`${line({ event: 'run_started' })}\n${line({ event: 'run_finished', verdict: 'pass', rolledBack: false })}\n`), 'pass')
  assert.equal(statusFromEvents(line({ event: 'run_finished', verdict: 'pass', rolledBack: true })), 'fail')
  assert.equal(statusFromEvents(line({ event: 'run_finished', verdict: 'fail', rolledBack: false })), 'fail')
  assert.equal(statusFromEvents('{"partial line from a tail read"\n'), 'unfinished')
  assert.equal(runStartedAt('2026-11-07T17-51-47-638Z'), Date.parse('2026-11-07T17:51:47.638Z'))
})

test('the plan keeps the newest passes and failures whole, compacts the next, removes the rest', () => {
  const policy: RetentionPolicy = { keepPass: 2, keepFail: 1, keepSummaries: 2, graceMs: 3600_000 }
  const at = (minute: number) => `2026-11-07T10-${String(minute).padStart(2, '0')}-00-000Z`
  const now = Date.parse('2026-11-07T10:59:00.000Z')
  const entries: RunEntry[] = [
    { name: at(10), status: 'pass', compacted: false },
    { name: at(11), status: 'fail', compacted: false },
    { name: at(12), status: 'pass', compacted: true },
    { name: at(13), status: 'unfinished', compacted: false },
    { name: at(14), status: 'pass', compacted: false },
    { name: at(15), status: 'fail', compacted: false },
    { name: at(16), status: 'pass', compacted: false },
    { name: at(17), status: 'pass', compacted: false },
    { name: at(18), status: 'unfinished', compacted: false },
    { name: 'not-a-run', status: 'pass', compacted: false },
  ]
  const plan = planRetention(entries, { ...policy, graceMs: 45 * 60_000 }, now, new Set([at(10)]))
  // 18: unfinished inside the grace window. 10: excluded (being resumed).
  assert.deepEqual(plan.keep, [at(18), at(15), at(10)])
  assert.deepEqual(plan.strip, [at(17), at(16)])
  // 13 is past grace, so it is a failure; the one whole failure slot went to 15.
  assert.deepEqual(plan.compact, [at(14), at(13)])
  assert.deepEqual(plan.remove, [at(12), at(11)])
})

test('pruneRuns strips, compacts, and removes on disk, and the ledger is never touched', async () => {
  const root = await temp()
  const ledger = join(root, 'ledger.jsonl')
  const names = ['2026-11-01T00-00-00-000Z', '2026-11-02T00-00-00-000Z', '2026-11-03T00-00-00-000Z', '2026-11-04T00-00-00-000Z']
  for (const name of names) {
    const dir = join(root, 'runs', name)
    const log = await RunLog.open(dir, ledger, name)
    await log.started({ config: {}, tools: { node: 'v24', cf: 'cf', git: 'git' }, plySha: null, plyWebSha: 'abc', host: 'box' })
    await log.finish(0, null)
    await log.seal()
    // The pre-2026-11-07 layout: plain captures and raw copies.
    await mkdir(join(dir, 'captures'), { recursive: true })
    await writeFile(join(dir, 'captures', '1.stdout'), 'x'.repeat(10_000))
    await mkdir(join(dir, 'raw'), { recursive: true })
    await writeFile(join(dir, 'raw', '2.json'), 'y'.repeat(10_000))
    await mkdir(join(dir, 'visual'), { recursive: true })
    await writeFile(join(dir, 'visual', 'a.png'), 'png')
    await writeFile(join(dir, 'verdict.json'), '{"pass":true}\n')
    await writeFile(join(dir, 'live-smoke.json'), '{"failed":0}\n')
  }
  await mkdir(join(root, 'runs', `${names[0]}.debrief`))
  const ledgerBefore = await readFile(ledger, 'utf8')
  const policy: RetentionPolicy = { keepPass: 1, keepFail: 1, keepSummaries: 2, graceMs: 0 }
  const report = await pruneRuns(join(root, 'runs'), [], policy)
  assert.deepEqual(report.strip, [names[3]])
  assert.deepEqual(report.compact, [names[2], names[1]])
  assert.deepEqual(report.remove, [names[0]])
  assert.ok(report.bytesFreed > 50_000)
  const runs = join(root, 'runs')
  assert.deepEqual((await readdir(join(runs, names[3]))).sort(), ['events.jsonl', 'live-smoke.json', 'manifest.json', 'verdict.json', 'visual'])
  assert.deepEqual((await readdir(join(runs, names[2]))).sort(), ['live-smoke.json', 'pruned.json', 'verdict.json'])
  const marker = JSON.parse(await readFile(join(runs, names[2], 'pruned.json'), 'utf8')) as { status: string; removed: string[] }
  assert.equal(marker.status, 'pass')
  assert.deepEqual(marker.removed, ['captures', 'events.jsonl', 'manifest.json', 'raw', 'visual'])
  assert.equal(existsSync(join(runs, names[0])), false)
  assert.equal(existsSync(join(runs, `${names[0]}.debrief`)), false)
  assert.equal(await readFile(ledger, 'utf8'), ledgerBefore)
  // A second pass is stable: compacted runs keep their status and stay.
  const again = await pruneRuns(runs, [], policy)
  assert.deepEqual(again.compact, [])
  assert.deepEqual(again.remove, [])
  assert.deepEqual(again.keep, [names[2], names[1]])
  assert.equal(again.bytesFreed, 0)
})
