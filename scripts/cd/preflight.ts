import { run } from './proc.ts'

/** cloudflare.config.ts is loaded by cf, which needs Node 22.18 or newer. */
export const MIN_NODE = { major: 22, minor: 18 } as const

const SHA = /^[0-9a-f]{40}$/

export function checkNode(version: string): string | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return `Node ${version} is not a recognized version`
  const major = Number(match[1])
  const minor = Number(match[2])
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)
  if (ok) return null
  return `Node ${version} is older than ${MIN_NODE.major}.${MIN_NODE.minor}, which cloudflare.config.ts needs`
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
