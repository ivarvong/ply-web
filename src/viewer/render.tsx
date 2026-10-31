import type { Loaded, TraceModel } from './model.ts'
import type { ViewerDocument } from './document.ts'
import { describeFailure } from './failure.ts'
import { EMPTY_HINT, type ViewerHint } from './hint.ts'
import { EMPTY_PUBLIC_REPOS, type PublicRepoList } from '../public.ts'
import { ViewerPage } from './pages.tsx'
import { trustRendered, type SafeHtml } from './safehtml.ts'

export function renderDocument(doc: ViewerDocument): SafeHtml {
  return trustRendered(`<!doctype html>${String(<ViewerPage doc={doc} />)}`)
}

export function renderHome(error: string | null, now = Date.now(), publicRepos: PublicRepoList = EMPTY_PUBLIC_REPOS): SafeHtml {
  return renderDocument({ kind: 'home', error, now, publicRepos })
}

export function renderNamespace(publicRepos: PublicRepoList, now = Date.now()): SafeHtml {
  return renderDocument({ kind: 'namespace', now, publicRepos })
}

export function renderError(status: number, code: string, message: string, trace: TraceModel, host = '', repoPath = '', ref: string | null = null, now = Date.now(), path = '', hint: ViewerHint = EMPTY_HINT): SafeHtml {
  const view = describeFailure({ code, status, message, host, repoPath, ref, path })
  return renderDocument({
    kind: 'error', status: view.status, code, message, summary: view.summary, part: view.part,
    trace, host, repoPath, ref, path, hint, now,
  })
}

export function renderLoaded(loaded: Exclude<Loaded, { kind: 'raw' }>, trace: TraceModel, now = Date.now()): SafeHtml {
  if (loaded.kind === 'tree') return renderDocument({ kind: 'tree', loaded, trace, now })
  if (loaded.kind === 'file') return renderDocument({ kind: 'file', loaded, trace, now })
  return renderDocument({ kind: 'pack', loaded, trace, now })
}
