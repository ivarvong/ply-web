import type { ViewerHint } from './hint.ts'
import type { Loaded, TraceModel } from './model.ts'
import type { PublicRepoList } from '../public.ts'

export type TreeLoaded = Extract<Loaded, { kind: 'tree' }>
export type FileLoaded = Extract<Loaded, { kind: 'file' }>
export type PackLoaded = Extract<Loaded, { kind: 'pack' }>

export type ViewerDocument =
  | { kind: 'home'; error: string | null; now: number; publicRepos: PublicRepoList }
  | { kind: 'tree'; loaded: TreeLoaded; trace: TraceModel; now: number }
  | { kind: 'file'; loaded: FileLoaded; trace: TraceModel; now: number }
  | { kind: 'pack'; loaded: PackLoaded; trace: TraceModel; now: number }
  | { kind: 'namespace'; now: number; publicRepos: PublicRepoList }
  | {
      kind: 'error'
      status: number
      code: string
      message: string
      summary: string
      part: 'repo' | 'ref' | 'path' | 'request'
      trace: TraceModel
      host: string
      repoPath: string
      ref: string | null
      path: string
      hint: ViewerHint
      now: number
    }
