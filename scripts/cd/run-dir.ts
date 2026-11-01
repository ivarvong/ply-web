import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redact } from './redact.ts'

/** Directory name from `toISOString()` with `:` and `.` replaced by `-`. */
export const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

export async function createRunDir(root: string): Promise<string> {
  const name = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function writeJson(dir: string, name: string, value: unknown, secrets: readonly string[] = []): Promise<void> {
  const text = redact(JSON.stringify(value, null, 2) + '\n', secrets)
  await writeFile(join(dir, name), text, { mode: 0o644 })
}

export async function writeText(dir: string, name: string, text: string, secrets: readonly string[] = []): Promise<void> {
  await writeFile(join(dir, name), redact(text, secrets), { mode: 0o644 })
}
