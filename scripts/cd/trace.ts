import { AsyncLocalStorage } from 'node:async_hooks'
import type { Secret } from './secret.ts'

/** One finished child process. `argv` may still hold Secret values; the log redacts them. */
export type CommandNote = {
  readonly argv: readonly (string | Secret)[]
  readonly cwd: string
  readonly exitCode: number
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
}

type Sink = (note: CommandNote) => Promise<void>

const current = new AsyncLocalStorage<Sink>()

/** Commands started inside `fn` are handed to `sink`. Concurrent runs do not share a sink. */
export function withCommandSink<T>(sink: Sink, fn: () => Promise<T>): Promise<T> {
  return current.run(sink, fn)
}

export function traceCommand(note: CommandNote): Promise<void> {
  const sink = current.getStore()
  return sink ? sink(note) : Promise.resolve()
}
