import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { sameSplit, type VersionShare } from '../scripts/cd/deploy-plan.ts'
import { readEvents, RunLog } from '../scripts/cd/log.ts'
import { liveSmokeAlreadyPassed, reconcile, unfinishedRunDir, type Reconcile } from '../scripts/cd/reconcile.ts'

const SHA = '1274f2dd05b83d70f8d421cdcc79628692d848df'
const NEXT = '8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e'
const PREVIOUS = '1aa0bb11-2222-4333-8444-555566667777'
const PERCENTS = [1, 5, 10, 25, 50, 75, 100]
const REFUSAL = 'deployment is not a canary, a ramp step, or live for this sha'

type Row = {
  readonly name: string
  readonly sha?: string
  readonly versionId: string | null
  readonly split: readonly VersionShare[]
  readonly liveSmokePassed?: boolean
  readonly want: Reconcile
}

function shares(percent: number): VersionShare[] {
  if (percent === 100) return [{ versionId: NEXT, percentage: 100 }]
  return [
    { versionId: PREVIOUS, percentage: 100 - percent },
    { versionId: NEXT, percentage: percent },
  ]
}

test('reconcile picks the next stage from the live split', () => {
  const ramp: Row[] = PERCENTS.filter(percent => percent < 100).map(percent => ({
    name: `at ${percent}%`,
    versionId: NEXT,
    split: shares(percent),
    liveSmokePassed: percent === 25,
    want: { stage: 'ramp', versionId: NEXT, previous: PREVIOUS, percent },
  }))
  const rows: Row[] = [
    { name: 'no version', versionId: null, split: [{ versionId: PREVIOUS, percentage: 100 }], want: { stage: 'upload' } },
    { name: 'empty deployment', versionId: null, split: [], want: { stage: 'upload' } },
    {
      name: 'tagged version is not in the split',
      versionId: NEXT,
      split: [{ versionId: PREVIOUS, percentage: 100 }],
      want: { stage: 'upload' },
    },
    {
      name: 'at 0%',
      versionId: NEXT,
      split: shares(0),
      want: { stage: 'smoke-canary', versionId: NEXT, previous: PREVIOUS },
    },
    ...ramp,
    {
      name: 'at 100%',
      versionId: NEXT,
      split: shares(100),
      want: { stage: 'smoke-live', versionId: NEXT, previous: null },
    },
    {
      name: 'live smoke already passed',
      versionId: NEXT,
      split: shares(100),
      liveSmokePassed: true,
      want: { stage: 'done', versionId: NEXT },
    },
    { name: 'bad sha', sha: 'not-a-sha', versionId: null, split: [], want: { stage: 'refuse', reason: 'sha is not 12 to 40 hex characters' } },
    {
      name: 'off the schedule',
      versionId: NEXT,
      split: shares(40),
      want: { stage: 'refuse', reason: REFUSAL },
    },
    {
      name: 'three versions',
      versionId: NEXT,
      split: [
        { versionId: NEXT, percentage: 25 },
        { versionId: PREVIOUS, percentage: 25 },
        { versionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', percentage: 50 },
      ],
      want: { stage: 'refuse', reason: REFUSAL },
    },
    {
      name: '100% is not alone',
      versionId: NEXT,
      split: [
        { versionId: NEXT, percentage: 100 },
        { versionId: PREVIOUS, percentage: 0 },
      ],
      liveSmokePassed: true,
      want: { stage: 'refuse', reason: REFUSAL },
    },
  ]
  for (const row of rows) {
    assert.deepEqual(reconcile({
      sha: row.sha ?? SHA,
      versionId: row.versionId,
      split: row.split,
      liveSmokePassed: row.liveSmokePassed ?? false,
      rampPercents: PERCENTS,
    }), row.want, row.name)
  }
})

test('a traffic write is refused when the live split is not the expected prior', () => {
  const at25 = [
    { versionId: NEXT, percentage: 25 },
    { versionId: PREVIOUS, percentage: 75 },
  ]
  const at10 = [
    { versionId: NEXT, percentage: 10 },
    { versionId: PREVIOUS, percentage: 90 },
  ]
  assert.equal(sameSplit(at25, at10), false)
  assert.equal(sameSplit(at25, at25), true)
})

test('re-entry keeps the unfinished run for this sha', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ply-cd-reconcile-'))
  const other = join(root, '2026-10-31T21-00-00-000Z')
  const unfinished = join(root, '2026-10-31T22-00-00-000Z')
  const finished = join(root, '2026-10-31T23-00-00-000Z')
  const ledger = join(root, 'ledger.jsonl')
  const open = async (dir: string, sha: string) => {
    const log = await RunLog.open(dir, ledger, basename(dir))
    await log.started({
      config: { sha },
      tools: { node: process.version, cf: 'cf', git: 'git' },
      plySha: sha,
      plyWebSha: 'def',
      host: 'box',
    })
    return log
  }
  await open(other, 'a'.repeat(40))
  await open(unfinished, SHA)
  const done = await open(finished, SHA)
  await done.finish(0, null)
  assert.equal(await unfinishedRunDir(root, SHA), unfinished)
  const resumed = await RunLog.reopen(unfinished, ledger)
  await resumed.resumed(SHA)
  const events = await readEvents(unfinished)
  const marker = events.find(event => event.kind === 'lifecycle' && event.payload.event === 'resumed')
  assert.equal(marker?.run_id, basename(unfinished))
  assert.equal(marker && marker.kind === 'lifecycle' && marker.payload.event === 'resumed' ? marker.payload.sha : '', SHA)
})

test('live smoke already passed is live-smoke.json for this version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ply-cd-live-smoke-'))
  const passed = join(root, '2026-10-31T21-00-00-000Z')
  const failed = join(root, '2026-10-31T22-00-00-000Z')
  await mkdir(passed, { recursive: true })
  await mkdir(failed, { recursive: true })
  await writeFile(join(passed, 'smoke.json'), JSON.stringify({ version: NEXT, failed: 0 }))
  await writeFile(join(passed, 'live-smoke.json'), JSON.stringify({ version: NEXT, failed: 0 }))
  await writeFile(join(failed, 'live-smoke.json'), JSON.stringify({ version: PREVIOUS, failed: 1 }))
  assert.equal(await liveSmokeAlreadyPassed(root, NEXT), true)
  assert.equal(await liveSmokeAlreadyPassed(root, PREVIOUS), false)
})
