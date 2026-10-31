import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VersionShare } from './deploy-plan.ts'
import { asRecord } from './json.ts'
import { readEvents, type CdEvent } from './log.ts'

export type Reconcile =
  | { readonly stage: 'upload' }
  | { readonly stage: 'smoke-canary'; readonly versionId: string; readonly previous: string }
  | { readonly stage: 'ramp'; readonly versionId: string; readonly previous: string; readonly percent: number }
  | { readonly stage: 'smoke-live'; readonly versionId: string; readonly previous: string | null }
  | { readonly stage: 'done'; readonly versionId: string }
  | { readonly stage: 'refuse'; readonly reason: string }

const SHA = /^[0-9a-f]{12,40}$/

/**
 * Next stage for a `--sha` run. Depends only on the live split, whether a version
 * tagged with that sha exists, and whether live smoke already passed for it.
 */
export function reconcile(input: {
  readonly sha: string
  readonly versionId: string | null
  readonly split: readonly VersionShare[]
  readonly liveSmokePassed: boolean
  readonly rampPercents: readonly number[]
}): Reconcile {
  if (!SHA.test(input.sha)) return { stage: 'refuse', reason: 'sha is not 12 to 40 hex characters' }
  if (input.versionId === null) return { stage: 'upload' }
  const mine = input.split.filter(share => share.versionId === input.versionId)
  if (mine.length === 0) return { stage: 'upload' }
  const me = mine[0]
  if (!me || mine.length !== 1) return { stage: 'refuse', reason: refusal() }
  const others = input.split.filter(share => share.versionId !== input.versionId)
  if (me.percentage === 0) {
    const previous = others[0]
    if (others.length !== 1 || !previous || previous.percentage !== 100) return { stage: 'refuse', reason: refusal() }
    return { stage: 'smoke-canary', versionId: input.versionId, previous: previous.versionId }
  }
  if (me.percentage === 100) {
    if (others.length !== 0) return { stage: 'refuse', reason: refusal() }
    if (input.liveSmokePassed) return { stage: 'done', versionId: input.versionId }
    return { stage: 'smoke-live', versionId: input.versionId, previous: null }
  }
  if (!input.rampPercents.includes(me.percentage)) return { stage: 'refuse', reason: refusal() }
  const previous = others[0]
  if (others.length !== 1 || !previous || previous.percentage !== 100 - me.percentage) {
    return { stage: 'refuse', reason: refusal() }
  }
  return { stage: 'ramp', versionId: input.versionId, previous: previous.versionId, percent: me.percentage }
}

function refusal(): string {
  return 'deployment is not a canary, a ramp step, or live for this sha'
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

function stringField(value: unknown, key: string): string | null {
  const rec = asRecord(value)
  const field = rec?.[key]
  return typeof field === 'string' ? field : null
}

function eventSha(event: CdEvent, sha: string): boolean {
  if (event.kind === 'lifecycle' && event.payload.event === 'run_started') return stringField(event.payload.config, 'sha') === sha
  if (event.kind === 'lifecycle' && event.payload.event === 'resumed') return event.payload.sha === sha
  if (event.kind === 'observation') {
    const measurement = asRecord(event.payload.measurement)
    return measurement?.source === 'reconcile' && measurement.sha === sha
  }
  return false
}

/** The latest unfinished run directory whose log names this sha. Null when none exists. */
export async function unfinishedRunDir(root: string, sha: string): Promise<string | null> {
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
    if (events.some(event => eventSha(event, sha))) matches.push(dir)
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
