import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redact } from './redact.ts'
import { traceCommand } from './trace.ts'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CF = join(ROOT, 'node_modules', '.bin', 'cf')

export type CfResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The directory cf runs in. cf creates `node_modules/.cache` under cwd, so this is the repo, never `/`. */
export function cfWorkdir(): string {
  return ROOT
}

/** cf with --quiet. Stdout is raw so a token can be parsed; callers must not log it. The log copy is redacted. */
export function runCf(args: readonly string[], secrets: readonly string[] = []): Promise<CfResult> {
  const started = Date.now()
  return new Promise(resolve => {
    execFile(CF, ['--quiet', ...args], {
      cwd: cfWorkdir(),
      env: { ...process.env, CF_SEND_TELEMETRY: 'false' },
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const coded = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
      const code = typeof coded === 'number' ? coded : err ? 1 : 0
      const rawOut = stdout ?? ''
      const safeErr = redact(stderr ?? '', secrets)
      void traceCommand({
        argv: [CF, '--quiet', ...args],
        cwd: cfWorkdir(),
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

export async function cfOk(args: readonly string[], secrets: readonly string[] = []): Promise<string> {
  const result = await runCf(args, secrets)
  if (result.code !== 0) {
    throw new Error(`cf ${args.slice(0, 4).join(' ')} exited ${result.code}: ${result.stderr.slice(0, 500)}`)
  }
  return result.stdout
}
