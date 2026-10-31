/** cloudflare.config.ts is loaded by cf, which needs Node 22.18 or newer. */
export const MIN_NODE = { major: 22, minor: 18 } as const

export function checkNode(version: string): string | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return `Node ${version} is not a recognized version`
  const major = Number(match[1])
  const minor = Number(match[2])
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)
  if (ok) return null
  return `Node ${version} is older than ${MIN_NODE.major}.${MIN_NODE.minor}, which cloudflare.config.ts needs`
}
