import type { Loaded, TraceModel } from './model.ts'

export type TreeLoaded = Extract<Loaded, { kind: 'tree' }>
export type FileLoaded = Extract<Loaded, { kind: 'file' }>
export type PackLoaded = Extract<Loaded, { kind: 'pack' }>

export type ViewerDocument =
  | { kind: 'home'; error: string | null; now: number }
  | { kind: 'tree'; loaded: TreeLoaded; trace: TraceModel; now: number }
  | { kind: 'file'; loaded: FileLoaded; trace: TraceModel; now: number }
  | { kind: 'pack'; loaded: PackLoaded; trace: TraceModel; now: number }
  | {
      kind: 'error'
      status: number
      code: string
      message: string
      trace: TraceModel
      host: string
      repoPath: string
      ref: string | null
      now: number
    }
