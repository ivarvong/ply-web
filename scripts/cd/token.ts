import { readFile, stat } from 'node:fs/promises'

/** The Worker bearer. The file must be owner-only (mode 0600). The contents are never returned in an error. */
export async function readTokenFile(path: string): Promise<string> {
  let mode = 0
  try {
    mode = (await stat(path)).mode
  } catch {
    throw new Error(`PLY_TOKEN_FILE ${path} cannot be read`)
  }
  if ((mode & 0o077) !== 0) throw new Error(`PLY_TOKEN_FILE ${path} must be mode 0600`)
  const text = (await readFile(path, 'utf8')).trim()
  if (!text) throw new Error(`PLY_TOKEN_FILE ${path} is empty`)
  return text
}
