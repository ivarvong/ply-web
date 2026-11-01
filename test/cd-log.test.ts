import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { chartPng } from '../scripts/cd/charts.ts'
import { cfWorkdir } from '../scripts/cd/cf.ts'
import { canarySplit, writeDebrief } from '../scripts/cd/debrief.ts'
import { fullSplit, isTrafficSplit, trafficSplit } from '../scripts/cd/deploy-plan.ts'
import { appendFalsePositive, parseEvent, readEvents, RunLog, validateRun, type CdEvent } from '../scripts/cd/log.ts'
import { createdTokenSecret, harvestSecrets } from '../scripts/cd/redact.ts'
import { checkNode } from '../scripts/cd/preflight.ts'
import { doraText } from '../scripts/cd/report.ts'
import { Secret } from '../scripts/cd/secret.ts'
import { FAST_BURN } from '../scripts/cd/slo.ts'

const VERSION = '8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e'
const PREVIOUS = '1aa0bb11-2222-4333-8444-555566667777'

async function temp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ply-cd-'))
}

test('cf runs from the repo directory', () => {
  const cwd = cfWorkdir().replace(/\/$/, '')
  assert.equal(resolve(cwd), cwd)
  assert.notEqual(cwd, '/')
  assert.equal(existsSync(join(cwd, 'package.json')), true)
  assert.equal(existsSync(join(cwd, 'scripts', 'cd', 'cf.ts')), true)
})

test('node preflight follows package.json engines', () => {
  assert.equal(checkNode('v22.23.0'), null)
  assert.equal(checkNode('v22.23.4'), null)
  assert.equal(checkNode('v24.22.1'), null)
  assert.equal(checkNode('v26.12.0'), null)
  assert.match(checkNode('v22.14.0') ?? '', /does not satisfy package.json engines/)
  assert.match(checkNode('v22.14.0') ?? '', /node-v24\.22\.1/)
  assert.match(checkNode('v24.0.0') ?? '', /engines/)
})

test('an empty or unbalanced split cannot be built', () => {
  const zero = trafficSplit(0, VERSION, PREVIOUS)
  assert.equal(isTrafficSplit(zero), true)
  if (isTrafficSplit(zero)) assert.deepEqual(zero.versions.map(share => share.percentage), [0, 100])
  const full = trafficSplit(100, VERSION, PREVIOUS)
  assert.equal(isTrafficSplit(full), true)
  if (isTrafficSplit(full)) assert.equal(full.versions.length, 1)
  assert.equal(isTrafficSplit(trafficSplit(1.5, VERSION, PREVIOUS)), false)
  assert.equal(isTrafficSplit(trafficSplit(50, VERSION, VERSION)), false)
  assert.equal(isTrafficSplit(trafficSplit(50, 'nope', PREVIOUS)), false)
  assert.equal(isTrafficSplit(fullSplit('nope')), false)
  const alone = fullSplit(PREVIOUS)
  assert.equal(isTrafficSplit(alone), true)
})

test('events round-trip and a decision must cite an observation', async () => {
  const dir = await temp()
  const ledger = join(dir, 'ledger.jsonl')
  const runDir = join(dir, 'run')
  const log = await RunLog.open(runDir, ledger, 'run-1')
  await log.started({
    config: { worker: 'ply' },
    tools: { node: 'v22.23.4', cf: 'cf 1', git: 'git 2' },
    plySha: null,
    plyWebSha: 'abc',
    host: 'box',
  })
  const ref = await log.observation({
    measurement: { source: 'ramp-step', percent: 1, observedPercent: 0, nextWallP99: 10, previousWallP99: 9 },
    query: { view: 'events' },
    from: Date.parse('2026-10-31T21:00:00Z'),
    to: Date.parse('2026-10-31T21:00:40Z'),
    raw: '{"events":[]}',
  })
  await log.decision({
    inputs: [ref],
    rules: [{ name: 'fast_burn', value: FAST_BURN }],
    outcome: 'advance',
    reason: 'within burn 14.4 and latency is not slower',
  })
  await log.addStep({ percent: 1, burns: { availability: 0, read_latency: null, write_latency: null, correctness: null } })
  await log.finish(0, null)
  await log.seal()
  const events = await readEvents(runDir)
  assert.deepEqual(events, log.recorded())
  for (const event of events) {
    assert.deepEqual(parseEvent(JSON.parse(JSON.stringify(event)) as unknown), event)
  }
  const ledgerText = await readFile(ledger, 'utf8')
  assert.equal(ledgerText, await readFile(join(runDir, 'events.jsonl'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as { files: Record<string, string> }
  assert.match(manifest.files['events.jsonl'] ?? '', /^[0-9a-f]{64}$/)
  assert.equal(manifest.files['manifest.json'], undefined)
  await assert.rejects(log.observation({ measurement: {}, query: {}, from: 0, to: 1, raw: '{}' }))
  assert.throws(() => parseEvent({
    seq: 1, ts: events[0]?.ts, run_id: 'run-1', stage: 'ramp', kind: 'decision',
    payload: { inputs: [], rules: [{ name: 'fast_burn', value: FAST_BURN }], outcome: 'advance', reason: 'x' },
  }))
  const forged = { seq: 1 } as unknown as Parameters<RunLog['decision']>[0]['inputs'][0]
  const open = await RunLog.open(join(dir, 'run-2'), join(dir, 'ledger-2.jsonl'), 'run-2')
  await assert.rejects(open.decision({
    inputs: [forged, forged],
    rules: [{ name: 'fast_burn', value: FAST_BURN }],
    outcome: 'hold',
    reason: 'no observation',
  }))
})

test('plaintext is a Secret and does not require a token prefix', () => {
  const token = 'art_v2_plaintext_token_value'
  const found = harvestSecrets({ id: 'tok', plaintext: token, nested: { plaintext: 'art_v2_also_a_secret_value' } })
  assert.deepEqual(found.map(secret => secret.reveal()), [token, 'art_v2_also_a_secret_value'])
  const created = 'art_v1_not_a_plaintext_field'
  const harvested = harvestSecrets({ token: created, id: 'tok' })
  assert.deepEqual(harvested.map(secret => secret.reveal()), [created])
  assert.equal(createdTokenSecret({ result: { token: created } }, harvested)?.reveal(), created)
  assert.equal(harvestSecrets({ token: 'short' }).length, 0)
  assert.equal(harvestSecrets({ plaintext: '' }).length, 0)
})

test('a v2 token never reaches captures', async () => {
  const v2 = 'art_v2_NEVER_LOG_THIS_TOKEN'
  const exact = new Secret('exact-match-secret-value')
  const dir = await temp()
  const runDir = join(dir, 'run')
  const log = await RunLog.open(runDir, join(dir, 'ledger.jsonl'), 'run-v2')
  await log.noteCommand({
    argv: ['cf', 'tokens', 'create'],
    cwd: '/workspace',
    exitCode: 0,
    durationMs: 1,
    stdout: `plaintext ${v2}`,
    stderr: '',
  })
  await log.noteCommand({
    argv: ['cf', exact],
    cwd: '/workspace',
    exitCode: 0,
    durationMs: 1,
    stdout: exact.reveal(),
    stderr: exact.reveal(),
  })
  await log.finish(0, null)
  const cap1 = await readFile(join(runDir, 'captures', '1.stdout'), 'utf8')
  const cap2 = await readFile(join(runDir, 'captures', '2.stdout'), 'utf8')
  const cap2err = await readFile(join(runDir, 'captures', '2.stderr'), 'utf8')
  const events = await readFile(join(runDir, 'events.jsonl'), 'utf8')
  assert.equal(cap1.includes(v2), false)
  assert.equal(cap1.includes('art_v2_'), false)
  assert.equal(events.includes(v2), false)
  assert.equal(cap2.includes('exact-match-secret-value'), false)
  assert.equal(cap2err.includes('exact-match-secret-value'), false)
  assert.equal(events.includes('exact-match-secret-value'), false)
})

test('a Secret never appears in an event', async () => {
  const secret = new Secret('art_v1_NEVER_LOG_THIS_TOKEN')
  assert.throws(() => JSON.stringify(secret), /Secret cannot be serialized/)
  const dir = await temp()
  const runDir = join(dir, 'run')
  const log = await RunLog.open(runDir, join(dir, 'ledger.jsonl'), 'run-secret')
  log.conceal('plain-secret-value')
  await log.noteCommand({
    argv: ['cf', 'tokens', 'create', secret],
    cwd: '/workspace',
    exitCode: 0,
    durationMs: 3,
    stdout: `token ${secret.reveal()} and plain-secret-value`,
    stderr: '',
  })
  await assert.rejects(log.error('boom', { leaked: secret }))
  await log.finish(0, null)
  const text = await readFile(join(runDir, 'events.jsonl'), 'utf8')
  const captured = await readFile(join(runDir, 'captures', '1.stdout'), 'utf8')
  assert.equal(text.includes('art_v1_NEVER_LOG_THIS_TOKEN'), false)
  assert.equal(text.includes('plain-secret-value'), false)
  assert.equal(captured.includes('art_v1_NEVER_LOG_THIS_TOKEN'), false)
  assert.match(text, /<redacted>/)
  await log.seal()
})

test('debrief cites the decision, its rule, and writes charts', async () => {
  const dir = await temp()
  const runDir = join(dir, 'run')
  const log = await RunLog.open(runDir, join(dir, 'ledger.jsonl'), 'run-debrief')
  await log.started({
    config: { worker: 'ply' },
    tools: { node: process.version, cf: 'cf', git: 'git' },
    plySha: 'abc',
    plyWebSha: 'def',
    host: 'box',
  })
  const ref = await log.observation({
    measurement: { source: 'ramp-step', percent: 5, observedPercent: 4, nextWallP99: 90, previousWallP99: 80 },
    query: { view: 'events', filters: [] },
    from: 0,
    to: 1000,
    raw: '{}',
  })
  await log.decision({
    inputs: [ref],
    rules: [{ name: 'fast_burn', value: FAST_BURN }],
    outcome: 'insufficient_data',
    reason: 'wall samples 3/4; need 20 each for Mann-Whitney or 5 each for a quantile compare',
  })
  log.addStep({ percent: 5, burns: { read_latency: 0, availability: null, write_latency: null, correctness: null } })
  await log.finish(0, null)
  await log.seal()
  const markdownPath = await writeDebrief(runDir)
  const markdown = await readFile(markdownPath, 'utf8')
  assert.match(markdown, /insufficient_data/)
  assert.match(markdown, /fast_burn/)
  assert.match(markdown, /14\.4/)
  assert.match(markdown, /raw\/2\.json/)
  const png = await readFile(join(dir, 'run.debrief', 'burn.png'))
  assert.equal(png[0], 137)
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.equal(markdown.includes('art_v1_'), false)
})

test('dora metrics use run_finished', () => {
  const finished = (over: Record<string, unknown>): CdEvent => ({
    seq: 1,
    ts: '2026-10-31T21:00:00.000+00:00',
    run_id: 'r',
    stage: 'run',
    kind: 'lifecycle',
    payload: {
      event: 'run_finished',
      verdict: 'pass',
      reason: null,
      rolledBack: false,
      rollbackReason: null,
      versionId: VERSION,
      plySha: 'a',
      plyMergedAt: '2026-10-31T20:00:00Z',
      plyWebSha: 'b',
      smoke: { passed: 1, failed: 0 },
      stages: [{ name: 'bump', startedAt: '2026-10-31T20:00:00.000+00:00', finishedAt: '2026-10-31T20:00:02.000+00:00', durationMs: 2000 }],
      steps: [],
      liveAt: '2026-10-31T21:00:00Z',
      failedAt: null,
      restoredAt: null,
      fault: null,
      ...over,
    },
  })
  const rollback = { ...finished({ rolledBack: true, verdict: 'fail', failedAt: '2026-10-31T22:00:00Z', restoredAt: '2026-10-31T22:01:30Z', liveAt: '2026-11-01T20:50:00Z', plyMergedAt: null }), run_id: 's', ts: '2026-11-01T21:00:00.000+00:00' }
  const text = doraText([
    finished({}),
    rollback,
    { ...finished({ verdict: 'fail', liveAt: null, rolledBack: false, fault: 'worker', plyMergedAt: null }), run_id: 'held', ts: '2026-11-03T21:00:00.000+00:00' },
    { ...finished({ fault: 'harness_fault', verdict: 'fail', liveAt: null, rolledBack: false, plyMergedAt: null }), run_id: 'h', ts: '2026-11-04T21:00:00.000+00:00' },
    { ...finished({ verdict: 'fail', liveAt: null, rolledBack: true, fault: 'worker', failedAt: '2026-11-05T21:00:00Z', restoredAt: '2026-11-05T21:10:00Z', plyMergedAt: null }), run_id: 'aborted', ts: '2026-11-05T21:00:00.000+00:00' },
  ])
  assert.match(text, /runs: 5/)
  assert.match(text, /deploys: 2/)
  assert.match(text, /excluded from deploys: 3/)
  assert.match(text, /aborted: 1/)
  assert.match(text, /held: 1/)
  assert.match(text, /harness_fault: 1/)
  assert.match(text, /false_positive: 0/)
  assert.match(text, /false positives: 0/)
  assert.match(text, /deployment frequency: 2\.000 \/ day/)
  assert.match(text, /lead time p50: 3600s/)
  assert.match(text, /change failure rate: 0\.500/)
  const withHarness = doraText([
    finished({}),
    rollback,
    { ...finished({ fault: 'harness_fault', rolledBack: true, verdict: 'fail' }), run_id: 'h', ts: '2026-11-02T21:00:00.000+00:00' },
  ])
  assert.match(withHarness, /deploys: 2/)
  assert.match(withHarness, /change failure rate: 0\.500/)
  assert.match(text, /time to restore p50: 90s/)
  assert.match(text, /bump p50 2s/)
  assert.throws(() => validateRun([finished({}), finished({})]))
})

test('split.png includes the 0% canary', async () => {
  const dir = await temp()
  const runDir = join(dir, 'run')
  const log = await RunLog.open(runDir, join(dir, 'ledger.jsonl'), 'run-split')
  await log.stateChange({
    before: [{ versionId: PREVIOUS, percentage: 100 }],
    after: [{ versionId: VERSION, percentage: 0 }, { versionId: PREVIOUS, percentage: 100 }],
    deploymentId: 'dep',
  })
  await log.stateChange({
    before: [{ versionId: VERSION, percentage: 0 }, { versionId: PREVIOUS, percentage: 100 }],
    after: [{ versionId: VERSION, percentage: 1 }, { versionId: PREVIOUS, percentage: 99 }],
    deploymentId: 'dep',
  })
  await log.finish(0, null)
  assert.deepEqual(canarySplit(log.recorded()).map(point => point.percent), [0, 1])
  await log.seal()
  const markdown = await readFile(await writeDebrief(runDir), 'utf8')
  assert.match(markdown, /0% canary/)
})

test('a false-positive annotation is appended and leaves change failure', async () => {
  const dir = await temp()
  const ledger = join(dir, 'ledger.jsonl')
  const runId = '2026-11-01T00-10-02-620Z'
  const reason = '5% ramp Mann-Whitney flagged a sub-millisecond wall-time shift'
  const rollback: CdEvent = {
    seq: 1,
    ts: '2026-11-01T00:13:40.000+00:00',
    run_id: runId,
    stage: 'run',
    kind: 'lifecycle',
    payload: {
      event: 'run_finished',
      verdict: 'fail',
      reason: 'new version wall time is slower',
      rolledBack: true,
      rollbackReason: 'new version wall time is slower',
      versionId: VERSION,
      plySha: null,
      plyMergedAt: null,
      plyWebSha: 'b',
      smoke: { passed: 1, failed: 0 },
      stages: [],
      steps: [],
      liveAt: '2026-11-01T00:13:00Z',
      failedAt: '2026-11-01T00:13:20Z',
      restoredAt: '2026-11-01T00:13:40Z',
      fault: 'worker',
    },
  }
  const pass: CdEvent = {
    seq: 1,
    ts: '2026-11-02T00:00:00.000+00:00',
    run_id: '2026-11-02T00-00-00-000Z',
    stage: 'run',
    kind: 'lifecycle',
    payload: {
      event: 'run_finished',
      verdict: 'pass',
      reason: null,
      rolledBack: false,
      rollbackReason: null,
      versionId: VERSION,
      plySha: null,
      plyMergedAt: null,
      plyWebSha: 'b',
      smoke: { passed: 1, failed: 0 },
      stages: [],
      steps: [],
      liveAt: '2026-11-02T00:00:00Z',
      failedAt: null,
      restoredAt: null,
      fault: null,
    },
  }
  const before = `${JSON.stringify(rollback)}\n`
  await writeFile(ledger, before)
  const noted = await appendFalsePositive(ledger, runId, `  ${reason}  `, new Date('2026-11-02T12:00:00Z'))
  const after = await readFile(ledger, 'utf8')
  assert.ok(after.startsWith(before))
  assert.equal(after.split('\n').filter(line => line).length, 2)
  assert.equal(noted.seq, 2)
  assert.equal(noted.kind, 'annotation')
  if (noted.kind === 'annotation') {
    assert.equal(noted.payload.note, 'false_positive')
    assert.equal(noted.payload.reason, reason)
  }
  const events = after.split('\n').filter(line => line).map(line => parseEvent(JSON.parse(line) as unknown))
  const text = doraText([...events, pass])
  assert.match(text, /deploys: 1/)
  assert.match(text, /false_positive: 1/)
  assert.match(text, new RegExp(runId))
  assert.match(text, /change failure rate: 0\.000/)
  assert.match(text, /0 rollbacks \/ 1 deploys/)
  const blamed = doraText([rollback, pass])
  assert.match(blamed, /change failure rate: 0\.500/)
})

test('chart png is a png', () => {
  const png = chartPng({ title: 'burn rate', series: [{ name: 'read', rgb: [1, 2, 3], points: [{ x: '1', y: 2 }] }], hLine: { y: 14.4, rgb: [255, 0, 0] } })
  assert.equal(png.subarray(0, 4).toString('hex'), '89504e47')
})
