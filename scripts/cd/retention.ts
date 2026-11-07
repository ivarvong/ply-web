import { open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mapGet } from '../../src/absent.ts'
import { unwrapOr } from '../../src/option.ts'
import { asRecord } from './json.ts'
import { RUN_ID } from './run-dir.ts'

// Measured 2026-11-07: a ramp run's directory was 120-135 MB (captures/ 73 MB, raw/ 53 MB) and about 50 runs filled
// the disk twice. Nothing deleted old runs. Retention runs once at the start of every run that creates a directory.

export type RunStatus = 'pass' | 'fail' | 'unfinished'

/** A run entry as retention sees it. `compacted` runs keep only their top-level summary files. */
export type RunEntry = {
  readonly name: string
  readonly status: RunStatus
  readonly compacted: boolean
}

export type RetentionPolicy = {
  /** Newest passing runs kept whole (events, screenshots, summaries). */
  readonly keepPass: number
  /** Newest failed, rolled-back, or abandoned runs kept whole, blobs included. */
  readonly keepFail: number
  /** Further runs, newest first, that keep their summary files after compaction. Older ones are removed. */
  readonly keepSummaries: number
  /** An unfinished run younger than this is never touched: it may still be running or about to resume. */
  readonly graceMs: number
}

export const RETENTION: RetentionPolicy = {
  keepPass: 10,
  keepFail: 10,
  keepSummaries: 500,
  graceMs: 24 * 3600_000,
}

export type RetentionPlan = {
  readonly keep: readonly string[]
  /** Whole runs that passed cleanly: their leftover blobs and pre-2026-11-07 captures/ and raw/ go. */
  readonly strip: readonly string[]
  readonly compact: readonly string[]
  readonly remove: readonly string[]
}

/** Inverse of `createRunDir`'s name. */
export function runStartedAt(name: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name)
  if (!m) return Number.NaN
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`)
}

/** Pure. Newest first by name; a failed or abandoned run counts against `keepFail`. */
export function planRetention(entries: readonly RunEntry[], policy: RetentionPolicy, now: number, exclude: ReadonlySet<string> = new Set()): RetentionPlan {
  const keep: string[] = []
  const strip: string[] = []
  const compact: string[] = []
  const remove: string[] = []
  let passes = 0
  let fails = 0
  let summaries = 0
  const sorted = entries.filter(entry => RUN_ID.test(entry.name)).sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  for (const entry of sorted) {
    if (exclude.has(entry.name)) {
      keep.push(entry.name)
      continue
    }
    if (entry.status === 'unfinished' && !entry.compacted && !(now - runStartedAt(entry.name) >= policy.graceMs)) {
      keep.push(entry.name)
      continue
    }
    if (!entry.compacted) {
      if (entry.status === 'pass' && passes < policy.keepPass) {
        passes += 1
        strip.push(entry.name)
        continue
      }
      if (entry.status !== 'pass' && fails < policy.keepFail) {
        fails += 1
        keep.push(entry.name)
        continue
      }
    }
    if (summaries < policy.keepSummaries) {
      summaries += 1
      if (entry.compacted) keep.push(entry.name)
      else compact.push(entry.name)
      continue
    }
    remove.push(entry.name)
  }
  return { keep, strip, compact, remove }
}

const TAIL_BYTES = 256 * 1024

async function tail(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** `run_finished` is the last event a run appends, so the tail of events.jsonl decides. A rollback counts as a failure. */
export function statusFromEvents(text: string): RunStatus {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('"run_finished"')) continue
    try {
      const event = asRecord(JSON.parse(line) as unknown)
      const payload = event ? asRecord(event.payload) : null
      if (!payload || payload.event !== 'run_finished') continue
      return payload.verdict === 'pass' && payload.rolledBack !== true ? 'pass' : 'fail'
    } catch {
      continue
    }
  }
  return 'unfinished'
}

export const PRUNED = 'pruned.json'

async function readEntry(root: string, name: string): Promise<RunEntry | null> {
  const dir = join(root, name)
  try {
    const marker = asRecord(JSON.parse(await readFile(join(dir, PRUNED), 'utf8')) as unknown)
    const status = marker ? marker.status : null
    if (status === 'pass' || status === 'fail' || status === 'unfinished') return { name, status, compacted: true }
  } catch {
    // Not compacted.
  }
  try {
    return { name, status: statusFromEvents(await tail(join(dir, 'events.jsonl'), TAIL_BYTES)), compacted: false }
  } catch {
    // No events.jsonl: a run that died before its first event. Abandoned.
    return { name, status: 'unfinished', compacted: false }
  }
}

async function sizeOf(path: string): Promise<number> {
  const info = await stat(path)
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of await readdir(path)) total += await sizeOf(join(path, entry))
  return total
}

async function removeAll(dir: string, names: readonly string[]): Promise<{ removed: string[]; bytes: number }> {
  const removed: string[] = []
  let bytes = 0
  for (const name of names) {
    const path = join(dir, name)
    try {
      bytes += await sizeOf(path)
    } catch {
      continue
    }
    await rm(path, { recursive: true, force: true })
    removed.push(name)
  }
  return { removed, bytes }
}

/** Pre-2026-11-07 runs wrote plain `captures/` and `raw/`; current runs write gzipped `blobs/`. */
const BULK_DIRS = ['blobs', 'captures', 'raw']
/** Duplicated in the ledger, or a large per-file index that names files compaction removes. */
const BULK_FILES = ['events.jsonl', 'manifest.json']

/**
 * Keep the top-level summary files (verdict, telemetry, smoke, visual, deploy, ramp: tens of KB) and drop
 * every directory (blobs, captures, raw, visual screenshots) plus events.jsonl, whose lines are in the ledger.
 */
async function compactRun(dir: string, status: RunStatus, now: number): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true })
  const names = entries.filter(entry => entry.isDirectory() || BULK_FILES.includes(entry.name)).map(entry => entry.name)
  const { removed, bytes } = await removeAll(dir, names)
  const marker = { status, compacted_at: new Date(now).toISOString(), removed: removed.sort(), bytes_freed: bytes }
  await writeFile(join(dir, PRUNED), JSON.stringify(marker, null, 2) + '\n')
  return bytes
}

export type RetentionReport = RetentionPlan & { readonly bytesFreed: number }

/** Apply `planRetention` under `root`. `exclude` names directories that must not change (a run being resumed). */
export async function pruneRuns(root: string, exclude: readonly string[] = [], policy: RetentionPolicy = RETENTION, now = Date.now()): Promise<RetentionReport> {
  let names: string[]
  try {
    names = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && RUN_ID.test(entry.name)).map(entry => entry.name)
  } catch {
    return { keep: [], strip: [], compact: [], remove: [], bytesFreed: 0 }
  }
  const entries: RunEntry[] = []
  for (const name of names) {
    const entry = await readEntry(root, name)
    if (entry) entries.push(entry)
  }
  const plan = planRetention(entries, policy, now, new Set(exclude))
  const status = new Map(entries.map(entry => [entry.name, entry.status]))
  let bytesFreed = 0
  for (const name of plan.strip) bytesFreed += (await removeAll(join(root, name), BULK_DIRS)).bytes
  for (const name of plan.compact) bytesFreed += await compactRun(join(root, name), unwrapOr(mapGet(status, name), 'unfinished'), now)
  for (const name of plan.remove) bytesFreed += (await removeAll(root, [name, `${name}.debrief`])).bytes
  return { ...plan, bytesFreed }
}

export function retentionLine(report: RetentionReport): string {
  const mb = (report.bytesFreed / 1e6).toFixed(1)
  return `retention: ${report.keep.length + report.strip.length} whole, ${report.compact.length} compacted, ${report.remove.length} removed, ${mb} MB freed`
}
