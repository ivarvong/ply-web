import type { Loaded, TraceModel } from './model.ts'
import type { ViewerDocument } from './document.ts'
import { ViewerPage } from './pages.tsx'
import { trustRendered, type SafeHtml } from './safehtml.ts'

export function renderDocument(doc: ViewerDocument): SafeHtml {
  return trustRendered(`<!doctype html>${String(<ViewerPage doc={doc} />)}`)
}

export function renderHome(error: string | null, now = Date.now()): SafeHtml {
  return renderDocument({ kind: 'home', error, now })
}

export function renderError(status: number, code: string, message: string, trace: TraceModel, host = '', repoPath = '', ref: string | null = null, now = Date.now()): SafeHtml {
  return renderDocument({ kind: 'error', status, code, message, trace, host, repoPath, ref, now })
}

export function renderLoaded(loaded: Exclude<Loaded, { kind: 'raw' }>, trace: TraceModel, now = Date.now()): SafeHtml {
  if (loaded.kind === 'tree') return renderDocument({ kind: 'tree', loaded, trace, now })
  if (loaded.kind === 'file') return renderDocument({ kind: 'file', loaded, trace, now })
  return renderDocument({ kind: 'pack', loaded, trace, now })
}
