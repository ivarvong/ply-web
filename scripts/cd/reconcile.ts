import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ListedVersion, VersionShare } from './deploy-plan.ts'
import { asRecord } from './json.ts'
import { readEvents, type CdEvent } from './log.ts'
import { isGitSha, releaseTag, sameRelease, type ReleaseId, type ReleasePair } from './release.ts'

export type Reconcile =
  | { readonly stage: 'upload' }
  | { readonly stage: 'smoke-canary'; readonly versionId: string; readonly previous: string }
  | { readonly stage: 'ramp'; readonly versionId: string; readonly previous: string; readonly percent: number }
  | { readonly stage: 'smoke-live'; readonly versionId: string; readonly previous: string | null }
  | { readonly stage: 'done'; readonly versionId: string }
  | { readonly stage: 'refuse'; readonly reason: string }

/**
 * Next stage for a release. Depends only on the live split, whether a version
 * tagged with this ply sha and this ply-web sha exists, and whether live smoke
 * already passed for it. A ply-only tag is not this release.
 */
export function reconcile(input: {
  readonly release: ReleaseId
  readonly versions: readonly ListedVersion[]
  readonly split: readonly VersionShare[]
  readonly liveSmokePassed: boolean
  readonly rampPercents: readonly number[]
}): Reconcile {
  const tag = releaseTag(input.release)
  const versionId = input.versions.find(version => version.tag === tag)?.id ?? null
  if (versionId === null) return { stage: 'upload' }
  const mine = input.split.filter(share => share.versionId === versionId)
  if (mine.length === 0) return { stage: 'upload' }
  const me = mine[0]
  if (!me || mine.length !== 1) return { stage: 'refuse', reason: refusal() }
  const others = input.split.filter(share => share.versionId !== versionId)
  if (me.percentage === 0) {
    const previous = others[0]
    if (others.length !== 1 || !previous || previous.percentage !== 100) return { stage: 'refuse', reason: refusal() }
    return { stage: 'smoke-canary', versionId, previous: previous.versionId }
  }
  if (me.percentage === 100) {
    if (others.length !== 0) return { stage: 'refuse', reason: refusal() }
    if (input.liveSmokePassed) return { stage: 'done', versionId }
    return { stage: 'smoke-live', versionId, previous: null }
  }
  if (!input.rampPercents.includes(me.percentage)) return { stage: 'refuse', reason: refusal() }
  const previous = others[0]
  if (others.length !== 1 || !previous || previous.percentage !== 100 - me.percentage) {
    return { stage: 'refuse', reason: refusal() }
  }
  return { stage: 'ramp', versionId, previous: previous.versionId, percent: me.percentage }
}

function refusal(): string {
  return 'deployment is not a canary, a ramp step, or live for this release'
}

export function reconcileReason(decision: Reconcile): string {
  switch (decision.stage) {
    case 'upload':
      return 'upload'
    case 'smoke-canary':
      return 'pinned smoke'
    case 'ramp':
      return `ramp from ${decision.percent}%`
    case 'smoke-live':
      return 'live smoke'
    case 'done':
      return 'done: live smoke already passed'
    case 'refuse':
      return decision.reason
  }
}

function pairField(value: unknown): ReleasePair | null {
  const rec = asRecord(value)
  if (!rec) return null
  const ply = rec.ply
  const web = rec.web
  if (typeof ply !== 'string' || typeof web !== 'string') return null
  if (!isGitSha(ply) || !isGitSha(web)) return null
  return { ply, web }
}

function namesRelease(value: unknown, release: ReleaseId): boolean {
  const pair = pairField(value)
  return pair !== null && sameRelease(release, pair)
}

function eventRelease(event: CdEvent, release: ReleaseId): boolean {
  if (event.kind === 'lifecycle' && event.payload.event === 'run_started') return namesRelease(event.payload.release, release)
  if (event.kind === 'lifecycle' && event.payload.event === 'resumed') return namesRelease(event.payload.release, release)
  if (event.kind === 'policy') return namesRelease(event.payload.release, release)
  if (event.kind === 'observation') {
    const measurement = asRecord(event.payload.measurement)
    return measurement?.source === 'reconcile' && namesRelease(measurement.release, release)
  }
  return false
}

/** The latest unfinished run directory whose log names this release. A ply-only run is not a match. */
export async function unfinishedRunDir(root: string, release: ReleaseId): Promise<string | null> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return null
  }
  const matches: string[] = []
  for (const name of names) {
    const dir = join(root, name)
    let events: CdEvent[]
    try {
      events = await readEvents(dir)
    } catch {
      continue
    }
    if (events.some(event => event.kind === 'lifecycle' && event.payload.event === 'run_finished')) continue
    if (events.some(event => eventRelease(event, release))) matches.push(dir)
  }
  matches.sort()
  return matches.at(-1) ?? null
}

/** True when some run under `root` recorded a passing live smoke for this version. */
export async function liveSmokeAlreadyPassed(root: string, versionId: string): Promise<boolean> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return false
  }
  for (const name of names) {
    try {
      const rec = asRecord(JSON.parse(await readFile(join(root, name, 'live-smoke.json'), 'utf8')))
      if (rec?.version === versionId && rec.failed === 0) return true
    } catch {
      continue
    }
  }
  return false
}
