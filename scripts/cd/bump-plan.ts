export const PIN = /^github:ivarvong\/ply#([0-9a-f]{40})$/

export type BumpPlan =
  | { readonly kind: 'unchanged'; readonly sha: string }
  | { readonly kind: 'update'; readonly from: string; readonly sha: string }
  | { readonly kind: 'invalid'; readonly reason: string }

export function pinSpec(sha: string): string {
  return `github:ivarvong/ply#${sha}`
}

export function planBump(spec: string, sha: string): BumpPlan {
  if (!/^[0-9a-f]{40}$/.test(sha)) return { kind: 'invalid', reason: 'sha must be 40 hex characters' }
  const match = PIN.exec(spec)
  if (!match) return { kind: 'invalid', reason: 'dependencies.ply is not github:ivarvong/ply#<40 hex>' }
  const current = match[1] ?? ''
  if (current === sha) return { kind: 'unchanged', sha }
  return { kind: 'update', from: current, sha }
}
