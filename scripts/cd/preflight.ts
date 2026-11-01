import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { delimiter, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NODE_PROBE_MS } from './baseline.ts'
import { run } from './proc.ts'

const SHA = /^[0-9a-f]{40}$/
const PACKAGE = fileURLToPath(new URL('../../package.json', import.meta.url))

/**
 * Node shipped on the operator image next to a default that is older than `engines`.
 * `npm run cd` uses this binary when `node` on `PATH` does not satisfy `package.json`.
 */
export const NODE_IMAGE_BIN = '/workspace/node-v24.22.1-linux-x64/bin/node'

type Semver = { readonly major: number; readonly minor: number; readonly patch: number }

export function enginesRange(): string {
  const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8')) as { engines?: { node?: string } }
  const node = pkg.engines?.node
  if (!node) throw new Error('package.json engines.node is missing')
  return node
}

function semver(version: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function compare(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  return left.patch - right.patch
}

/** `package.json` `engines.node`: `^X.Y.Z` or `>=X.Y.Z`, joined by `||`. */
export function nodeSatisfies(version: string, engines: string = enginesRange()): boolean {
  const got = semver(version)
  if (!got) return false
  for (const part of engines.split('||').map(item => item.trim()).filter(Boolean)) {
    const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(part)
    if (caret) {
      const min = { major: Number(caret[1]), minor: Number(caret[2]), patch: Number(caret[3]) }
      if (got.major === min.major && compare(got, min) >= 0) return true
      continue
    }
    const floor = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(part)
    if (floor) {
      const min = { major: Number(floor[1]), minor: Number(floor[2]), patch: Number(floor[3]) }
      if (compare(got, min) >= 0) return true
    }
  }
  return false
}

export function checkNode(version: string, engines: string = enginesRange()): string | null {
  if (!semver(version)) return `Node ${version} is not a recognized version`
  if (nodeSatisfies(version, engines)) return null
  return [
    `Node ${version} does not satisfy package.json engines (${engines}).`,
    `The operator image keeps a matching build at ${NODE_IMAGE_BIN}.`,
    '.nvmrc asks for 24.22.1.',
    'Set PLY_NODE to a binary that satisfies engines, or run npm run cd so it selects one.',
  ].join(' ')
}

export function binaryNodeVersion(bin: string): string | null {
  const result = spawnSync(bin, ['-p', 'process.version'], { encoding: 'utf8', timeout: NODE_PROBE_MS })
  if (result.status !== 0) return null
  const line = result.stdout.trim()
  return line.startsWith('v') ? line : null
}

/** PATH with `nodeBin`'s directory first, so a child `cf` resolves the same Node. */
export function pathWithNodeBin(nodeBin: string, path: string | undefined): string {
  const dir = dirname(nodeBin)
  if (!path) return dir
  return `${dir}${delimiter}${path}`
}

/** A different binary when the current one misses engines. Null when the current one is fine or none of the candidates is. */
export function selectNode(
  current: string,
  candidates: readonly { readonly bin: string; readonly version: string | null }[],
  engines: string = enginesRange(),
): string | null {
  if (nodeSatisfies(current, engines)) return null
  for (const candidate of candidates) {
    if (candidate.version && nodeSatisfies(candidate.version, engines)) return candidate.bin
  }
  return null
}

export type OriginMain =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly kind: 'not-on-origin-main'; readonly head: string; readonly main: string }
  | { readonly ok: false; readonly kind: 'origin-main-unavailable'; readonly reason: string }

/** A deploy is allowed only when HEAD and origin/main are the same commit. */
export function judgeOriginMain(head: string, main: string): OriginMain {
  if (!SHA.test(head) || !SHA.test(main)) {
    return { ok: false, kind: 'origin-main-unavailable', reason: 'HEAD or origin/main is not a commit sha' }
  }
  if (head !== main) return { ok: false, kind: 'not-on-origin-main', head, main }
  return { ok: true, sha: head }
}

export function originMainReason(result: Exclude<OriginMain, { ok: true }>): string {
  if (result.kind === 'not-on-origin-main') {
    return `not-on-origin-main: HEAD ${result.head} is not origin/main ${result.main}`
  }
  return `origin-main-unavailable: ${result.reason}`
}

/** Fetch `origin main` and return that commit. Does not look at HEAD. */
export async function fetchOriginMain(cwd: string): Promise<
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly kind: 'origin-main-unavailable'; readonly reason: string }
> {
  const fetched = await run('git', ['fetch', 'origin', 'main'], { cwd, timeout: 60_000 })
  if (fetched.code !== 0) {
    const detail = (fetched.stderr || fetched.stdout).trim().slice(0, 300)
    return { ok: false, kind: 'origin-main-unavailable', reason: detail || `git fetch origin main exited ${fetched.code}` }
  }
  const main = await run('git', ['rev-parse', 'origin/main'], { cwd })
  if (main.code !== 0) return { ok: false, kind: 'origin-main-unavailable', reason: 'git rev-parse origin/main failed' }
  const sha = main.stdout.trim()
  if (!SHA.test(sha)) return { ok: false, kind: 'origin-main-unavailable', reason: 'origin/main is not a commit sha' }
  return { ok: true, sha }
}

/** Fetch origin/main, then refuse unless HEAD is that commit. */
export async function requireOriginMain(cwd: string): Promise<OriginMain> {
  const main = await fetchOriginMain(cwd)
  if (!main.ok) return main
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd })
  if (head.code !== 0) return { ok: false, kind: 'origin-main-unavailable', reason: 'git rev-parse HEAD failed' }
  return judgeOriginMain(head.stdout.trim(), main.sha)
}
