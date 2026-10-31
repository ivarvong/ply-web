import { MESSAGE_MAX } from './baseline.ts'
import { asRecord } from './json.ts'

export const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type VersionShare = {
  readonly versionId: string
  readonly percentage: number
}

export type CanaryPlan =
  | { readonly kind: 'ok'; readonly live: string; readonly dropped: string | null }
  | { readonly kind: 'refuse'; readonly reason: string }

export function planCanary(versions: readonly VersionShare[], next: string): CanaryPlan {
  if (!VERSION_ID.test(next)) return { kind: 'refuse', reason: 'new version id is not a uuid' }
  if (versions.length === 0) return { kind: 'refuse', reason: 'no deployment' }
  const live = versions.filter(v => v.percentage === 100)
  const zero = versions.filter(v => v.percentage === 0)
  const other = versions.filter(v => v.percentage !== 100 && v.percentage !== 0)
  if (other.length > 0) return { kind: 'refuse', reason: 'deployment is not a 0/100 split' }
  if (live.length !== 1) {
    return { kind: 'refuse', reason: live.length === 0 ? 'no version at 100%' : 'more than one version at 100%' }
  }
  const current = live[0]
  if (!current) return { kind: 'refuse', reason: 'no version at 100%' }
  if (current.versionId === next) return { kind: 'refuse', reason: 'new version is already at 100%' }
  if (versions.length > 2) return { kind: 'refuse', reason: 'more than two versions in the deployment' }
  if (zero.length > 1) return { kind: 'refuse', reason: 'more than one version at 0%' }
  const sitting = zero[0]
  const dropped = sitting && sitting.versionId !== next ? sitting.versionId : null
  return { kind: 'ok', live: current.versionId, dropped }
}

const splitBrand = Symbol('TrafficSplit')

/**
 * A deployment body that sums to 100 and names real version ids.
 * An empty list, a non-integer percent, or two copies of one id cannot be built.
 */
export type TrafficSplit = {
  readonly [splitBrand]: 'TrafficSplit'
  readonly versions: readonly VersionShare[]
}

export type SplitRefusal = {
  readonly ok: false
  readonly reason: string
}

function seal(versions: readonly VersionShare[]): TrafficSplit {
  if (versions.length === 0) throw new Error('empty split')
  const total = versions.reduce((sum, share) => sum + share.percentage, 0)
  if (total !== 100) throw new Error('split must sum to 100')
  const ids = new Set(versions.map(share => share.versionId))
  if (ids.size !== versions.length) throw new Error('split versions must differ')
  for (const share of versions) {
    if (!Number.isInteger(share.percentage) || share.percentage < 0 || share.percentage > 100) {
      throw new Error('split percentage is not an integer 0..100')
    }
  }
  return { [splitBrand]: 'TrafficSplit', versions }
}

export function isTrafficSplit(value: TrafficSplit | SplitRefusal): value is TrafficSplit {
  return !('ok' in value)
}

/** 0 keeps the new version dark. 100 drops the previous version. Anything else is both, summing to 100. */
export function trafficSplit(percent: number, next: string, previous: string): TrafficSplit | SplitRefusal {
  if (!VERSION_ID.test(next)) return { ok: false, reason: 'new version id is not a uuid' }
  if (!VERSION_ID.test(previous)) return { ok: false, reason: 'previous version id is not a uuid' }
  if (next === previous) return { ok: false, reason: 'split versions must differ' }
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return { ok: false, reason: 'percent must be an integer 0..100' }
  if (percent === 100) return seal([{ versionId: next, percentage: 100 }])
  return seal([
    { versionId: next, percentage: percent },
    { versionId: previous, percentage: 100 - percent },
  ])
}

/** The previous version alone at 100%. */
export function fullSplit(versionId: string): TrafficSplit | SplitRefusal {
  if (!VERSION_ID.test(versionId)) return { ok: false, reason: 'version id is not a uuid' }
  return seal([{ versionId, percentage: 100 }])
}

export function deploymentBody(message: string, split: TrafficSplit) {
  return {
    strategy: 'percentage' as const,
    versions: split.versions.map(version => ({ version_id: version.versionId, percentage: version.percentage })),
    annotations: { 'workers/message': message.slice(0, MESSAGE_MAX) },
  }
}

function uuidIn(value: unknown): string | null {
  if (typeof value !== 'string' || !VERSION_ID.test(value)) return null
  return value
}

export type ListedVersion = {
  readonly id: string
  readonly tag: string
}

export type VersionLookup =
  | { readonly ok: true; readonly versionId: string }
  | { readonly ok: false; readonly kind: 'version-not-found'; readonly tag: string }

function tagOf(rec: Record<string, unknown>): string | null {
  if (typeof rec.tag === 'string' && rec.tag !== '') return rec.tag
  const annotations = asRecord(rec.annotations)
  const tagged = annotations?.['workers/tag']
  return typeof tagged === 'string' && tagged !== '' ? tagged : null
}

/** Versions in a `cf workers versions list` JSON payload. A string is TTY text and yields nothing. */
export function versionsFromList(payload: unknown): ListedVersion[] {
  if (typeof payload === 'string') return []
  const out: ListedVersion[] = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const rec = asRecord(node)
    if (!rec) return
    const id = uuidIn(rec.id) ?? uuidIn(rec.version_id)
    const tag = tagOf(rec)
    if (id && tag && !out.some(version => version.id === id && version.tag === tag)) out.push({ id, tag })
    for (const item of Object.values(rec)) visit(item)
  }
  visit(payload)
  return out
}

/** The version whose tag is `tag`. Missing is a typed error. TTY banners are not read. */
export function versionByTag(payload: unknown, tag: string): VersionLookup {
  const found = versionsFromList(payload).find(version => version.tag === tag)
  if (!found) return { ok: false, kind: 'version-not-found', tag }
  return { ok: true, versionId: found.id }
}

/** True when the two deployments name the same ids at the same percentages. */
export function sameSplit(actual: readonly VersionShare[], expected: readonly VersionShare[]): boolean {
  if (actual.length !== expected.length) return false
  for (const want of expected) {
    const got = actual.find(version => version.versionId === want.versionId)
    if (!got || got.percentage !== want.percentage) return false
  }
  return true
}

function shareFrom(value: unknown): VersionShare | null {
  const rec = asRecord(value)
  if (!rec) return null
  const versionId = uuidIn(rec.version_id) ?? uuidIn(rec.versionId) ?? uuidIn(rec.id)
  const percentage = typeof rec.percentage === 'number' ? rec.percentage : Number(rec.percentage)
  if (!versionId || !Number.isFinite(percentage)) return null
  return { versionId, percentage }
}

function sharesFrom(value: unknown): VersionShare[] | null {
  if (!Array.isArray(value)) return null
  const shares: VersionShare[] = []
  for (const item of value) {
    const share = shareFrom(item)
    if (share) shares.push(share)
  }
  return shares
}

/** The latest deployment. Accepts the shapes cf has returned. `id` is null when the payload has none. */
export function parseDeployment(value: unknown): DeploymentView {
  const rec = asRecord(value)
  if (!rec) return { id: null, versions: [] }
  const result = asRecord(rec.result)
  const deployments = Array.isArray(rec.deployments)
    ? rec.deployments
    : result && Array.isArray(result.deployments)
      ? result.deployments
      : null
  if (deployments && deployments.length > 0) {
    const first = asRecord(deployments[0])
    const versions = first ? sharesFrom(first.versions) : null
    if (versions) {
      const id = first && typeof first.id === 'string' && first.id !== '' ? first.id : null
      return { id, versions }
    }
  }
  return { id: null, versions: sharesFrom(rec.versions) ?? (result ? sharesFrom(result.versions) : null) ?? [] }
}

/** The latest deployment's versions. Accepts the shapes cf has returned. */
export function parseDeploymentList(value: unknown): VersionShare[] {
  return [...parseDeployment(value).versions]
}

export type DeploymentView = {
  readonly id: string | null
  readonly versions: readonly VersionShare[]
}

/** Null when the live deployment matches the split. Otherwise the mismatch. */
export function assertSplit(versions: readonly VersionShare[], want: TrafficSplit): string | null {
  const expected = want.versions
  if (versions.length !== expected.length) return `deployment has ${versions.length} versions, wanted ${expected.length}`
  for (const wanted of expected) {
    const got = versions.find(version => version.versionId === wanted.versionId)
    if (!got) return `deployment is missing ${wanted.versionId}`
    if (got.percentage !== wanted.percentage) return `${wanted.versionId} is at ${got.percentage}%, wanted ${wanted.percentage}%`
  }
  return null
}

export function isFullRollback(versions: readonly VersionShare[], previous: string): boolean {
  return versions.length === 1 && versions[0]?.versionId === previous && versions[0].percentage === 100
}
