import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { chartPng } from '../scripts/cd/charts.ts'
import { cfWorkdir } from '../scripts/cd/cf.ts'
import { writeDebrief } from '../scripts/cd/debrief.ts'
import { fullSplit, isTrafficSplit, trafficSplit } from '../scripts/cd/deploy-plan.ts'
import { parseEvent, readEvents, RunLog, validateRun, type CdEvent } from '../scripts/cd/log.ts'
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

test('node preflight names 22.18', () => {
  assert.equal(checkNode('v22.18.0'), null)
  assert.equal(checkNode('v22.23.4'), null)
  assert.equal(checkNode('v24.0.0'), null)
  assert.match(checkNode('v22.17.9') ?? '', /older than 22\.18/)
  assert.match(checkNode('v20.11.0') ?? '', /cd|22\.18|older/)
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
      ...over,
    },
  })
  const text = doraText([
    finished({}),
    { ...finished({ rolledBack: true, verdict: 'fail', failedAt: '2026-10-31T22:00:00Z', restoredAt: '2026-10-31T22:01:30Z', liveAt: null, plyMergedAt: null }), run_id: 's', ts: '2026-11-01T21:00:00.000+00:00' },
  ])
  assert.match(text, /deployment frequency: 2\.000 \/ day/)
  assert.match(text, /lead time p50: 3600s/)
  assert.match(text, /change failure rate: 0\.500/)
  assert.match(text, /time to restore p50: 90s/)
  assert.match(text, /bump p50 2s/)
  assert.throws(() => validateRun([finished({}), finished({})]))
})

test('chart png is a png', () => {
  const png = chartPng({ title: 'burn rate', series: [{ name: 'read', rgb: [1, 2, 3], points: [{ x: '1', y: 2 }] }], hLine: { y: 14.4, rgb: [255, 0, 0] } })
  assert.equal(png.subarray(0, 4).toString('hex'), '89504e47')
})
