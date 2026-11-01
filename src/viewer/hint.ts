// The blue banner on an error page. It names the part that failed and only the facts we have for that part.
import { chainGet } from '../absent.ts'
import type { BranchInfo, TagInfo } from './model.ts'
import { VIEWER_CAPS } from './limits.ts'

const HEADS = 'refs/heads/'
const TAGS = 'refs/tags/'

export type NearbyRef = { label: string; ref: string }

export type PathCue = {
  missing: string
  /** Directory prefix that exists. Empty means the repository root. */
  existingPath: string
  notDirectory: boolean
}

export type ViewerHint = {
  nearby: readonly NearbyRef[]
  path: PathCue | null
}

export const EMPTY_HINT: ViewerHint = { nearby: [], path: null }

export function shortRefName(name: string): string {
  if (name.startsWith(HEADS)) return name.slice(HEADS.length)
  if (name.startsWith(TAGS)) return name.slice(TAGS.length)
  return name
}

function sharedPrefix(query: string, label: string): number {
  const n = Math.min(query.length, label.length)
  let i = 0
  while (i < n && query[i] === label[i]) i++
  return i
}

/**
 * A few branch and tag names to offer when the requested ref missed.
 * Longer shared prefixes rank first; the default branch wins a tie. The list is capped.
 */
export function nearbyRefs(
  wanted: string,
  branches: readonly Pick<BranchInfo, 'name' | 'head'>[],
  tags: readonly Pick<TagInfo, 'name'>[],
  cap: number = VIEWER_CAPS.hintNearbyRefs,
): NearbyRef[] {
  const query = shortRefName(wanted)
  const seen = new Set<string>()
  const ranked: { item: NearbyRef; score: number; head: boolean }[] = []
  const add = (name: string, head: boolean) => {
    const label = shortRefName(name)
    if (!label || label === query || seen.has(name)) return
    seen.add(name)
    ranked.push({ item: { label, ref: name }, score: sharedPrefix(query, label), head })
  }
  for (const branch of branches) add(branch.name, branch.head)
  for (const tag of tags) add(tag.name, false)
  ranked.sort((a, b) => b.score - a.score || Number(b.head) - Number(a.head))
  return ranked.slice(0, cap).map(row => row.item)
}

function isPathCue(value: unknown): value is PathCue {
  if (!value || typeof value !== 'object') return false
  const cue = value as PathCue
  return typeof cue.missing === 'string' && cue.missing.length > 0
    && typeof cue.existingPath === 'string'
    && typeof cue.notDirectory === 'boolean'
}

/** The hint attached by the viewer when it already knows which names or path prefix exist. Anything else is empty. */
export function hintFromError(err: unknown): ViewerHint {
  const found = chainGet(err, 'viewerHint')
  if (found.tag === 'none' || typeof found.value !== 'object') return EMPTY_HINT
  const raw = found.value
  const nearbyFound = chainGet(raw, 'nearby')
  const nearbyRaw = nearbyFound.tag === 'some' ? nearbyFound.value : null
  const nearby: NearbyRef[] = []
  if (Array.isArray(nearbyRaw)) {
    for (const item of nearbyRaw) {
      if (nearby.length >= VIEWER_CAPS.hintNearbyRefs) break
      if (!item || typeof item !== 'object') continue
      const label = chainGet(item, 'label')
      const ref = chainGet(item, 'ref')
      if (label.tag === 'none' || ref.tag === 'none') continue
      if (typeof label.value !== 'string' || typeof ref.value !== 'string' || label.value.length === 0 || ref.value.length === 0) continue
      nearby.push({ label: label.value, ref: ref.value })
    }
  }
  const pathFound = chainGet(raw, 'path')
  const pathRaw = pathFound.tag === 'some' ? pathFound.value : null
  return { nearby, path: isPathCue(pathRaw) ? pathRaw : null }
}
