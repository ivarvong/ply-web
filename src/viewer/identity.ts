// How a repository is named on the page. The URL keeps the raw host and path; the page leads with what a person
// recognises: "public-v0 / ply" for the public Artifacts namespace, "owner / repo" on a forge. The raw remote stays
// available in the Diagnostics section.
import { PUBLIC_GIT_HOST, PUBLIC_NAMESPACE } from '../public.ts'

export type RepoIdentity = {
  /** Namespace, owner, or group path. Empty when the repo sits at the host root. */
  scope: string
  /** Where the scope label links (the public list for public-v0), or null for plain text. */
  scopeHref: string | null
  /** The repository name: the page title. */
  name: string
  /** A short label for the host, shown quietly next to the name. */
  hostLabel: string
  /** The full https remote, for Diagnostics. */
  remote: string
}

const FORGES: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'codeberg.org': 'Codeberg',
  'bitbucket.org': 'Bitbucket',
  'git.sr.ht': 'sourcehut',
}

export function repoIdentity(host: string, repoPath: string): RepoIdentity {
  const remote = `https://${host}/${repoPath}`
  const parts = repoPath.replace(/\.git$/, '').split('/').filter(part => part.length > 0)
  const artifacts = host === PUBLIC_GIT_HOST || host.endsWith('.artifacts.cloudflare.net')
  if (artifacts && parts[0] === 'git' && parts.length === 3) {
    const scope = parts[1] ?? ''
    return {
      scope,
      scopeHref: host === PUBLIC_GIT_HOST && scope === PUBLIC_NAMESPACE ? '/view#public' : null,
      name: parts[2] ?? '',
      hostLabel: 'Artifacts',
      remote,
    }
  }
  const name = parts[parts.length - 1] ?? repoPath
  return { scope: parts.slice(0, -1).join('/'), scopeHref: null, name, hostLabel: FORGES[host] ?? host, remote }
}
