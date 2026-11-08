import { spawnSync } from 'node:child_process'
import { mkdir, open, readFile, rmdir, stat, unlink } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * One writer of the Worker's deployment at a time, across worktrees and agents.
 *
 * Two runs overlapped on 2026-11-07: run 2026-11-07T18-30-47-501Z replaced another agent's measurement canary
 * (b494b751) in the 0% slot. The `pgrep` habit in the runbook was advisory. This lock is not: every command that
 * writes the deployment (`cd`, `deploy-canary`, `ramp`, `rollback`) takes it before it opens a run directory, and a
 * second run refuses while the holder is alive.
 *
 * The lock is a file created with O_EXCL in the shared state directory (`~/.local/state/ply-cd/deploy.lock`, beside the
 * ledger, so every worktree sees the same one). It holds the holder's pid, host, cwd, command and start time. A lock whose
 * pid is gone (or is no longer a `scripts/cd/main.ts` process: a reused pid) on this host is stale and is taken over; the
 * takeover itself is serialised by a `mkdir` mutex so two runs cannot both steal one stale lock. A lock from another host
 * cannot be checked and is never taken over.
 */

export type LockHolder = {
  readonly pid: number
  readonly host: string
  readonly cwd: string
  readonly command: string
  readonly startedAt: string
}

export type LockResult =
  | { readonly ok: true; readonly path: string; readonly holder: LockHolder; readonly tookOver: LockHolder | null; release(): Promise<void> }
  | { readonly ok: false; readonly path: string; readonly holder: LockHolder | null; readonly reason: string }

export type LockIo = {
  /** True while `pid` on this host is a live CD process. */
  alive(pid: number): boolean
  host(): string
  now(): Date
}

/** `PLY_CD_LOCK` overrides it. */
export function defaultLockPath(): string {
  return join(homedir(), '.local', 'state', 'ply-cd', 'deploy.lock')
}

const CD_ENTRY = /scripts\/cd\/main\.ts/

/** Alive and still a CD process. EPERM from signal 0 is alive (another user's process). */
export function pidIsCd(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  // `ps` unavailable: trust signal 0 rather than steal a live lock.
  if (ps.error) return true
  return CD_ENTRY.test(String(ps.stdout))
}

export const realLockIo: LockIo = {
  alive: pidIsCd,
  host: () => hostname(),
  now: () => new Date(),
}

function parseHolder(text: string): LockHolder | null {
  try {
    const value = JSON.parse(text) as Partial<LockHolder>
    if (typeof value.pid !== 'number' || typeof value.host !== 'string') return null
    return {
      pid: value.pid,
      host: value.host,
      cwd: typeof value.cwd === 'string' ? value.cwd : '?',
      command: typeof value.command === 'string' ? value.command : '?',
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : '?',
    }
  } catch {
    return null
  }
}

async function readHolder(path: string): Promise<{ readonly text: string; readonly holder: LockHolder | null } | null> {
  try {
    const text = await readFile(path, 'utf8')
    return { text, holder: parseHolder(text) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function create(path: string, holder: LockHolder): Promise<boolean> {
  try {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(holder) + '\n')
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

export function describeHolder(holder: LockHolder): string {
  return `pid ${holder.pid} on ${holder.host}, started ${holder.startedAt}, cwd ${holder.cwd}, command "${holder.command}"`
}

/** A takeover mutex older than this was left by a crashed takeover. */
const STEAL_STALE_MS = 30_000

async function withStealMutex<T>(path: string, fn: () => Promise<T>): Promise<T | 'busy'> {
  const mutex = `${path}.steal`
  try {
    await mkdir(mutex)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const held = await stat(mutex).catch(() => null)
    const age = held ? Date.now() - held.mtimeMs : Number.POSITIVE_INFINITY
    if (age <= STEAL_STALE_MS) return 'busy'
    await rmdir(mutex).catch(() => {})
    try {
      await mkdir(mutex)
    } catch {
      return 'busy'
    }
  }
  try {
    return await fn()
  } finally {
    await rmdir(mutex).catch(() => {})
  }
}

/**
 * Take the deployment lock or say who has it. Never waits: a second run is refused, not queued, because the first
 * one's split is what the second would plan against.
 */
export async function acquireLock(
  path: string,
  info: { readonly command: string; readonly cwd: string; readonly pid: number },
  io: LockIo = realLockIo,
): Promise<LockResult> {
  await mkdir(dirname(path), { recursive: true })
  const me: LockHolder = {
    pid: info.pid,
    host: io.host(),
    cwd: info.cwd,
    command: info.command,
    startedAt: io.now().toISOString(),
  }
  const granted = (tookOver: LockHolder | null): LockResult => ({
    ok: true,
    path,
    holder: me,
    tookOver,
    release: async () => {
      // Remove only our own lock: a holder that was (wrongly) taken over must not delete its successor's.
      const seen = await readHolder(path).catch(() => null)
      if (seen && seen.holder && seen.holder.pid === me.pid && seen.holder.host === me.host && seen.holder.startedAt === me.startedAt) {
        await unlink(path).catch(() => {})
      }
    },
  })
  if (await create(path, me)) return granted(null)
  const seen = await readHolder(path)
  if (seen === null) {
    // Released between our create and our read: one more try, then refuse rather than loop.
    if (await create(path, me)) return granted(null)
    return { ok: false, path, holder: null, reason: `deployment lock ${path} changed hands while it was read; try again` }
  }
  const holder = seen.holder
  if (holder && holder.host !== me.host) {
    return { ok: false, path, holder, reason: `deployment lock ${path} is held by ${describeHolder(holder)}; another host's pid cannot be checked, so it is not taken over` }
  }
  if (holder && io.alive(holder.pid)) {
    return { ok: false, path, holder, reason: `deployment lock ${path} is held by a live run: ${describeHolder(holder)}` }
  }
  // Stale (dead pid, reused pid, or an unreadable body). Take it over under the mutex, re-reading first.
  const stolen = await withStealMutex(path, async () => {
    const again = await readHolder(path)
    if (again !== null && again.text !== seen.text) return false
    if (again !== null) await unlink(path).catch(() => {})
    return create(path, me)
  })
  if (stolen === true) return granted(holder || { pid: -1, host: '?', cwd: '?', command: 'unreadable lock file', startedAt: '?' })
  return { ok: false, path, holder, reason: `deployment lock ${path} was stale and another run is taking it over; try again` }
}
