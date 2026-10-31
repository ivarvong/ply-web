import { execFile } from 'node:child_process'
import { redact } from './redact.ts'
import { isSecret, type Secret } from './secret.ts'
import { traceCommand } from './trace.ts'

export type RunResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export function run(
  cmd: string,
  args: readonly (string | Secret)[],
  opts: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly secrets?: readonly string[]; readonly timeout?: number } = {},
): Promise<RunResult> {
  const secrets = opts.secrets ?? []
  const revealed = args.map(arg => (isSecret(arg) ? arg.reveal() : arg))
  const started = Date.now()
  return new Promise(resolve => {
    execFile(cmd, revealed, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      timeout: opts.timeout,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const coded = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
      const code = typeof coded === 'number' ? coded : err ? 1 : 0
      const rawOut = stdout ?? ''
      const safeErr = redact(stderr ?? '', secrets)
      void traceCommand({
        argv: [cmd, ...args],
        cwd: opts.cwd ?? '',
        exitCode: code,
        durationMs: Date.now() - started,
        stdout: redact(rawOut, secrets),
        stderr: safeErr,
      }).finally(() => {
        resolve({ code, stdout: rawOut, stderr: safeErr })
      })
    })
  })
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
