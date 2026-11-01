import { GIT_SHA_HEX, VERSION_TAG_MAX } from './baseline.ts'
import { run } from './proc.ts'

const releaseBrand = Symbol('ReleaseId')
const GIT_SHA = new RegExp(`^[0-9a-f]{${GIT_SHA_HEX}}$`)
const RELEASE_TAG_SEP = '+'

/** The tag is `<ply>+<web>`. Both halves are full object ids, so a ply-only tag cannot parse as one. */
export const RELEASE_TAG_LENGTH = GIT_SHA_HEX + RELEASE_TAG_SEP.length + GIT_SHA_HEX

export type ReleaseId = {
  readonly [releaseBrand]: 'ReleaseId'
  readonly ply: string
  readonly web: string
}

export type ReleasePair = {
  readonly ply: string
  readonly web: string
}

export type ReleaseRefusal = {
  readonly ok: false
  readonly kind: 'bad-ply-sha' | 'bad-web-sha'
}

export type Checkout =
  | { readonly ok: true; readonly web: string }
  | { readonly ok: false; readonly kind: 'dirty-checkout' }
  | { readonly ok: false; readonly kind: 'checkout-unavailable'; readonly reason: string }

export function isGitSha(value: string): boolean {
  return GIT_SHA.test(value)
}

export function releaseId(ply: string, web: string): ReleaseId | ReleaseRefusal {
  if (!isGitSha(ply)) return { ok: false, kind: 'bad-ply-sha' }
  if (!isGitSha(web)) return { ok: false, kind: 'bad-web-sha' }
  return { [releaseBrand]: 'ReleaseId', ply, web }
}

export function isReleaseId(value: ReleaseId | ReleaseRefusal): value is ReleaseId {
  return !('ok' in value)
}

export function releasePair(id: ReleaseId): ReleasePair {
  return { ply: id.ply, web: id.web }
}

export function releaseTag(id: ReleaseId): string {
  if (RELEASE_TAG_LENGTH > VERSION_TAG_MAX) throw new Error('release tag exceeds workers/tag')
  return `${id.ply}${RELEASE_TAG_SEP}${id.web}`
}

/** A ply-only tag, or any tag that is not exactly two full shas, is not a release. */
export function releaseFromTag(tag: string): ReleasePair | null {
  const parts = tag.split(RELEASE_TAG_SEP)
  if (parts.length !== 2) return null
  const ply = parts[0] ?? ''
  const web = parts[1] ?? ''
  if (!isGitSha(ply) || !isGitSha(web)) return null
  return { ply, web }
}

export function sameRelease(id: ReleaseId, pair: ReleasePair): boolean {
  return id.ply === pair.ply && id.web === pair.web
}

export function judgeCheckout(porcelain: string, head: string): Checkout {
  if (porcelain.trim() !== '') return { ok: false, kind: 'dirty-checkout' }
  if (!isGitSha(head)) return { ok: false, kind: 'checkout-unavailable', reason: 'HEAD is not a commit sha' }
  return { ok: true, web: head }
}

export function checkoutReason(result: Exclude<Checkout, { ok: true }>): string {
  if (result.kind === 'dirty-checkout') return 'dirty-checkout: tracked files are modified'
  return `checkout-unavailable: ${result.reason}`
}

export async function readCheckout(cwd: string): Promise<Checkout> {
  const status = await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd })
  if (status.code !== 0) return { ok: false, kind: 'checkout-unavailable', reason: 'git status failed' }
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd })
  if (head.code !== 0) return { ok: false, kind: 'checkout-unavailable', reason: 'git rev-parse HEAD failed' }
  return judgeCheckout(status.stdout, head.stdout.trim())
}
