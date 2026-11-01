// Scratch-repo delete is lossy the same way a probe is. Run 2026-11-01T17-29-43-122Z
// (web 9558b10) passed, then `cf artifacts namespaces repos delete` took 103s and
// returned APIError "timeout", exit 1. The retry was 404 [10200] Repository not found:
// the delete had succeeded. A timeout is not a failed release.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNever } from '../../src/never.ts'
import { asRecord } from './json.ts'
import type { DecisionOutcome, ObservationRef } from './log.ts'
import { writeJson } from './run-dir.ts'

export const CLEANUP_FILE = 'cleanup.json'

/** One `cf repos delete` invocation, timed by the caller. */
export type DeleteCommand = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly latencyMs: number
}

/** What that invocation proved. `absent` is a 404: the repo is already gone. */
export type DeleteAttempt =
  | { readonly kind: 'deleted'; readonly latencyMs: number }
  | { readonly kind: 'absent'; readonly latencyMs: number }
  | { readonly kind: 'transient'; readonly latencyMs: number; readonly detail: string }

/** `attempts` is the bound. The wait before retry n is `backoffMs * 2^(n-1)`. */
export type CleanupBound = {
  readonly attempts: number
  readonly backoffMs: number
}

export type CleanupResult =
  | { readonly kind: 'deleted'; readonly repo: string; readonly attempts: readonly DeleteAttempt[] }
  | { readonly kind: 'leak'; readonly repo: string; readonly attempts: readonly DeleteAttempt[] }

export type CleanupStep =
  | { readonly kind: 'call' }
  | { readonly kind: 'wait'; readonly waitMs: number }
  | { readonly kind: 'done'; readonly result: CleanupResult }

export type ListedRepo = {
  readonly name: string
  readonly createdAtMs: number | null
}

export type SweepReport = {
  readonly deleted: readonly string[]
  readonly leaks: readonly string[]
}

export type CleanupIo = {
  readonly once: () => Promise<DeleteCommand>
  readonly sleep: (ms: number) => Promise<void>
}

export type SweepInput = {
  readonly listed: readonly ListedRepo[]
  readonly nowMs: number
  readonly staleMs: number
  readonly prefix: string
  readonly bound: CleanupBound
  readonly once: (name: string) => Promise<DeleteCommand>
  readonly sleep: (ms: number) => Promise<void>
  readonly note: (result: CleanupResult) => Promise<void>
}

type CleanupLog = {
  observation(input: {
    readonly measurement: unknown
    readonly query: unknown
    readonly from: number
    readonly to: number
    readonly raw: string
  }): Promise<ObservationRef>
  decision(input: {
    readonly inputs: readonly [ObservationRef, ...ObservationRef[]]
    readonly rules: readonly [{ readonly name: string; readonly value: number | string }, ...{ readonly name: string; readonly value: number | string }[]]
    readonly outcome: DecisionOutcome
    readonly reason: string
  }): Promise<void>
}

function clip(text: string, code: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return `exit ${code}`
  return flat.slice(0, 240)
}

function isAbsent(text: string): boolean {
  if (/repository not found/i.test(text)) return true
  if (text.includes('[10200]')) return true
  return /\b404\b/.test(text)
}

/** Exit 0 is deleted. 404, [10200], or "Repository not found" is deleted too. Anything else is retried. */
export function classifyDelete(command: DeleteCommand): DeleteAttempt {
  if (command.code === 0) return { kind: 'deleted', latencyMs: command.latencyMs }
  const text = `${command.stdout}\n${command.stderr}`
  if (isAbsent(text)) return { kind: 'absent', latencyMs: command.latencyMs }
  return { kind: 'transient', latencyMs: command.latencyMs, detail: clip(text, command.code) }
}

function confirmed(attempts: readonly DeleteAttempt[]): boolean {
  for (const attempt of attempts) {
    switch (attempt.kind) {
      case 'deleted':
      case 'absent':
        return true
      case 'transient':
        break
      default:
        return assertNever(attempt)
    }
  }
  return false
}

/**
 * Stop when a delete is confirmed, or when `bound.attempts` is exhausted.
 * Exhaustion is a leak: the release already passed, and the repo name is the record.
 */
export function cleanupStep(repo: string, attempts: readonly DeleteAttempt[], bound: CleanupBound): CleanupStep {
  if (confirmed(attempts)) return { kind: 'done', result: { kind: 'deleted', repo, attempts } }
  if (attempts.length >= bound.attempts) return { kind: 'done', result: { kind: 'leak', repo, attempts } }
  if (attempts.length === 0) return { kind: 'call' }
  return { kind: 'wait', waitMs: bound.backoffMs * 2 ** (attempts.length - 1) }
}

export async function confirmDelete(repo: string, bound: CleanupBound, io: CleanupIo): Promise<CleanupResult> {
  const attempts: DeleteAttempt[] = []
  for (;;) {
    const step = cleanupStep(repo, attempts, bound)
    switch (step.kind) {
      case 'done':
        return step.result
      case 'wait':
        await io.sleep(step.waitMs)
        attempts.push(classifyDelete(await io.once()))
        break
      case 'call':
        attempts.push(classifyDelete(await io.once()))
        break
      default:
        return assertNever(step)
    }
  }
}

/** Names whose age is strictly greater than `staleMs`. A missing timestamp is kept. */
export function leakedRepos(repos: readonly ListedRepo[], nowMs: number, staleMs: number, prefix: string): readonly string[] {
  const names: string[] = []
  for (const repo of repos) {
    if (!repo.name.startsWith(prefix)) continue
    if (repo.createdAtMs === null) continue
    if (nowMs - repo.createdAtMs <= staleMs) continue
    names.push(repo.name)
  }
  return names
}

export function reposFromList(value: unknown): readonly ListedRepo[] {
  if (!Array.isArray(value)) return []
  const repos: ListedRepo[] = []
  for (const item of value) {
    const rec = asRecord(item)
    if (!rec) continue
    if (typeof rec.name !== 'string' || rec.name.length === 0) continue
    const created = typeof rec.created_at === 'string' ? Date.parse(rec.created_at) : Number.NaN
    repos.push({ name: rec.name, createdAtMs: Number.isFinite(created) ? created : null })
  }
  return repos
}

export async function sweepLeaks(input: SweepInput): Promise<SweepReport> {
  const deleted: string[] = []
  const leaks: string[] = []
  for (const name of leakedRepos(input.listed, input.nowMs, input.staleMs, input.prefix)) {
    const result = await confirmDelete(name, input.bound, {
      once: () => input.once(name),
      sleep: input.sleep,
    })
    await input.note(result)
    switch (result.kind) {
      case 'deleted':
        deleted.push(result.repo)
        break
      case 'leak':
        leaks.push(result.repo)
        break
      default:
        return assertNever(result)
    }
  }
  return { deleted, leaks }
}

export function mergeLeakNames(prior: readonly string[], extra: readonly string[]): readonly string[] {
  const names: string[] = []
  for (const name of prior) {
    if (!names.includes(name)) names.push(name)
  }
  for (const name of extra) {
    if (!names.includes(name)) names.push(name)
  }
  return names
}

export function cleanupLeakNames(value: unknown): readonly string[] {
  const rec = asRecord(value)
  if (!rec || !Array.isArray(rec.leaks)) return []
  const names: string[] = []
  for (const name of rec.leaks) {
    if (typeof name === 'string' && name.length > 0 && !names.includes(name)) names.push(name)
  }
  return names
}

export async function appendCleanupFile(runDir: string, leaks: readonly string[]): Promise<void> {
  if (leaks.length === 0) return
  let prior: readonly string[] = []
  try {
    prior = cleanupLeakNames(JSON.parse(await readFile(join(runDir, CLEANUP_FILE), 'utf8')) as unknown)
  } catch {
    prior = []
  }
  await writeJson(runDir, CLEANUP_FILE, { leaks: mergeLeakNames(prior, leaks) })
}

function attemptDetail(attempt: DeleteAttempt): string {
  switch (attempt.kind) {
    case 'transient':
      return attempt.detail
    case 'deleted':
    case 'absent':
      return ''
    default:
      return assertNever(attempt)
  }
}

function attemptText(attempt: DeleteAttempt): string {
  switch (attempt.kind) {
    case 'deleted':
      return `${attempt.latencyMs}ms deleted`
    case 'absent':
      return `${attempt.latencyMs}ms absent`
    case 'transient':
      return `${attempt.latencyMs}ms transient`
    default:
      return assertNever(attempt)
  }
}

function reasonOf(result: CleanupResult): string {
  const parts = result.attempts.map(attemptText).join(', ')
  switch (result.kind) {
    case 'deleted':
      return `deleted ${result.repo} (${parts})`
    case 'leak':
      return `cleanup_leak ${result.repo} (${parts})`
    default:
      return assertNever(result)
  }
}

function decisionOutcome(result: CleanupResult): DecisionOutcome {
  switch (result.kind) {
    case 'deleted':
      return 'advance'
    case 'leak':
      return 'cleanup_leak'
    default:
      return assertNever(result)
  }
}

function nonempty(refs: readonly ObservationRef[]): [ObservationRef, ...ObservationRef[]] {
  const first = refs[0]
  if (!first) throw new Error('cleanup record needs an observation')
  return [first, ...refs.slice(1)]
}

/** Ledger record. Each attempt's latency is its own observation. A leak names the repo. */
export async function recordCleanup(log: CleanupLog, result: CleanupResult, bound: CleanupBound): Promise<void> {
  const refs: ObservationRef[] = []
  let ordinal = 0
  for (const attempt of result.attempts) {
    ordinal += 1
    const to = Date.now()
    const from = to - attempt.latencyMs
    const measurement = {
      source: 'repo-delete',
      repo: result.repo,
      attempt: ordinal,
      kind: attempt.kind,
      latencyMs: attempt.latencyMs,
      detail: attemptDetail(attempt),
    }
    refs.push(await log.observation({
      measurement,
      query: { source: 'repo-delete', repo: result.repo },
      from,
      to,
      raw: JSON.stringify(measurement),
    }))
  }
  if (result.kind === 'leak') {
    const now = Date.now()
    const measurement = { source: 'cleanup-leak', repo: result.repo }
    refs.push(await log.observation({
      measurement,
      query: { source: 'cleanup-leak', repo: result.repo },
      from: now,
      to: now,
      raw: JSON.stringify(measurement),
    }))
  }
  await log.decision({
    inputs: nonempty(refs),
    rules: [
      { name: 'cleanup.attempts', value: bound.attempts },
      { name: 'cleanup.backoffMs', value: bound.backoffMs },
    ],
    outcome: decisionOutcome(result),
    reason: reasonOf(result),
  })
}
