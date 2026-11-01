import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { MESSAGE_MAX, VERSION_TAG_MAX } from '../scripts/cd/baseline.ts'
import { sameSplit, type ListedVersion, type VersionShare } from '../scripts/cd/deploy-plan.ts'
import { readEvents, RunLog } from '../scripts/cd/log.ts'
import { DEFAULT_POLICY_PATH, loadPolicy } from '../scripts/cd/policy.ts'
import { liveSmokeAlreadyPassed, reconcile, unfinishedRunDir, type Reconcile } from '../scripts/cd/reconcile.ts'
import { isReleaseId, judgeCheckout, releaseFromTag, releaseId, releaseTag, RELEASE_TAG_LENGTH } from '../scripts/cd/release.ts'

const SHA = '1274f2dd05b83d70f8d421cdcc79628692d848df'
const WEB = 'be08f0406dab6d5b2d1167e934f7716463a757ed'
const OTHER_WEB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEXT = '8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e'
const PREVIOUS = '1aa0bb11-2222-4333-8444-555566667777'
const PERCENTS = loadPolicy(DEFAULT_POLICY_PATH).policy.steps.map(step => step.percent)
const REFUSAL = 'deployment is not a canary, a ramp step, or live for this release'

function release(ply: string, web: string) {
  const made = releaseId(ply, web)
  if (!isReleaseId(made)) throw new Error(made.kind)
  return made
}

const RELEASE = release(SHA, WEB)

type Row = {
  readonly name: string
  readonly versionId: string | null
  readonly tag?: string
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
      name: 'same pair at 100% with smoke passed',
      versionId: NEXT,
      split: shares(100),
      liveSmokePassed: true,
      want: { stage: 'done', versionId: NEXT },
    },
    {
      name: 'same ply sha and a different web sha',
      versionId: NEXT,
      tag: releaseTag(release(SHA, OTHER_WEB)),
      split: shares(100),
      liveSmokePassed: true,
      want: { stage: 'upload' },
    },
    {
      name: 'legacy version tagged only with the ply sha',
      versionId: NEXT,
      tag: SHA,
      split: shares(100),
      liveSmokePassed: true,
      want: { stage: 'upload' },
    },
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
    const versions: ListedVersion[] = row.versionId === null ? [] : [{ id: row.versionId, tag: row.tag ?? releaseTag(RELEASE) }]
    assert.deepEqual(reconcile({
      release: RELEASE,
      versions,
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
      config: { sha, release: { ply: sha, web: WEB } },
      tools: { node: process.version, cf: 'cf', git: 'git' },
      plySha: sha,
      plyWebSha: WEB,
      host: 'box',
      release: { ply: sha, web: WEB },
    })
    return log
  }
  await open(other, 'a'.repeat(40))
  await open(unfinished, SHA)
  const done = await open(finished, SHA)
  await done.finish(0, null)
  const legacy = join(root, '2026-11-01T00-00-00-000Z')
  const legacyLog = await RunLog.open(legacy, ledger, basename(legacy))
  await legacyLog.started({
    config: { sha: SHA },
    tools: { node: process.version, cf: 'cf', git: 'git' },
    plySha: SHA,
    plyWebSha: 'def',
    host: 'box',
  })
  assert.equal(await unfinishedRunDir(root, RELEASE), unfinished)
  const resumed = await RunLog.reopen(unfinished, ledger)
  await resumed.resumed(SHA, { ply: SHA, web: WEB })
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

test('a release tag is the ply sha and the ply-web sha, and a ply-only tag is not one', () => {
  const tag = releaseTag(RELEASE)
  assert.equal(tag, `${SHA}+${WEB}`)
  assert.equal(tag.length, RELEASE_TAG_LENGTH)
  assert.ok(RELEASE_TAG_LENGTH <= VERSION_TAG_MAX)
  assert.ok(`cd canary ${tag}`.length <= MESSAGE_MAX)
  assert.deepEqual(releaseFromTag(tag), { ply: SHA, web: WEB })
  assert.equal(releaseFromTag(SHA), null)
  assert.equal(isReleaseId(releaseId('abc', WEB)), false)
  assert.equal(isReleaseId(releaseId(SHA, 'abc')), false)
})

test('a dirty checkout is not a web sha', () => {
  assert.deepEqual(judgeCheckout(' M package.json\n', WEB), { ok: false, kind: 'dirty-checkout' })
  assert.equal(judgeCheckout('', WEB).ok, true)
  assert.equal(judgeCheckout('', 'abc').ok, false)
})
