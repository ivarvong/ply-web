import { readFile } from 'node:fs/promises'
import { parseEvent, type CdEvent } from './log.ts'
import type { Fault } from './result.ts'

export type FinishedRun = {
  readonly runId: string
  readonly at: string
  readonly verdict: 'pass' | 'fail'
  readonly rolledBack: boolean
  readonly versionId: string | null
  readonly plyMergedAt: string | null
  readonly liveAt: string | null
  readonly failedAt: string | null
  readonly restoredAt: string | null
  readonly fault: Fault | null
  readonly stages: readonly { readonly name: string; readonly durationMs: number }[]
}

/** run_finished lines are the delivery record. Other events are ignored here. */
export function finishedRuns(events: readonly CdEvent[]): FinishedRun[] {
  const runs: FinishedRun[] = []
  for (const event of events) {
    if (event.kind !== 'lifecycle') continue
    const payload = event.payload
    if (payload.event !== 'run_finished') continue
    const stages = payload.stages.map(stage => ({ name: stage.name, durationMs: stage.durationMs }))
    runs.push({
      runId: event.run_id,
      at: event.ts,
      verdict: payload.verdict,
      rolledBack: payload.rolledBack,
      versionId: payload.versionId,
      plyMergedAt: payload.plyMergedAt,
      liveAt: payload.liveAt,
      failedAt: payload.failedAt,
      restoredAt: payload.restoredAt,
      fault: payload.fault,
      stages,
    })
  }
  return runs
}

export function quantile(values: readonly number[], p: number): number | null {
  const sorted = values.filter(value => Number.isFinite(value)).slice().sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.floor((sorted.length - 1) * p)] ?? null
}

function seconds(ms: number | null): string {
  if (ms === null) return '-'
  return `${Math.round(ms / 1000)}s`
}

function stamp(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * DORA figures from run_finished events.
 * Frequency is deploys / days between the first and last deploy. One timestamp has no rate.
 * Lead time is plyMergedAt → liveAt on a passing deploy.
 * Change failure is rollbacks / deploys, excluding a harness_fault. That is a script,
 * cf, parse, or preflight error, not a bad version.
 * Time to restore is failedAt → restoredAt.
 */
export function doraText(events: readonly CdEvent[]): string {
  const finished = finishedRuns(events)
  if (finished.length === 0) return 'no run_finished events in the ledger\n'
  const deploys = finished.filter(run => run.versionId !== null)
  const lines = [`runs: ${finished.length}`, `deploys: ${deploys.length}`]
  const times = deploys.map(run => stamp(run.at)).filter((value): value is number => value !== null).sort((a, b) => a - b)
  const first = times[0]
  const last = times[times.length - 1]
  if (deploys.length >= 2 && first !== undefined && last !== undefined && last > first) {
    const days = (last - first) / 86_400_000
    lines.push(`deployment frequency: ${(deploys.length / days).toFixed(3)} / day`)
    lines.push(`  ${deploys.length} deploys / ${days.toFixed(2)} days between the first and last run_finished`)
  } else {
    lines.push('deployment frequency: -')
    lines.push('  needs two deploys with different timestamps')
  }
  const leads = deploys.flatMap(run => {
    if (run.verdict !== 'pass') return []
    const merged = stamp(run.plyMergedAt)
    const live = stamp(run.liveAt)
    if (merged === null || live === null || live < merged) return []
    return [live - merged]
  })
  lines.push(`lead time p50: ${seconds(quantile(leads, 0.5))}  p90: ${seconds(quantile(leads, 0.9))}`)
  lines.push(`  ply merge → 100% live, ${leads.length} passing deploy${leads.length === 1 ? '' : 's'} with both timestamps`)
  const counted = deploys.filter(run => run.fault !== 'harness_fault')
  const failed = counted.filter(run => run.rolledBack).length
  const rate = counted.length === 0 ? 0 : failed / counted.length
  lines.push(`change failure rate: ${rate.toFixed(3)}`)
  lines.push(`  ${failed} rollbacks / ${counted.length} deploys`)
  const restores = deploys.flatMap(run => {
    if (!run.rolledBack) return []
    const from = stamp(run.failedAt)
    const to = stamp(run.restoredAt)
    if (from === null || to === null || to < from) return []
    return [to - from]
  })
  lines.push(`time to restore p50: ${seconds(quantile(restores, 0.5))}  p90: ${seconds(quantile(restores, 0.9))}`)
  lines.push(`  failure → rollback complete, ${restores.length} rollback${restores.length === 1 ? '' : 's'} with both timestamps`)
  const byStage = new Map<string, number[]>()
  for (const run of finished) {
    for (const stage of run.stages) {
      const list = byStage.get(stage.name) ?? []
      list.push(stage.durationMs)
      byStage.set(stage.name, list)
    }
  }
  lines.push('stage durations:')
  for (const [name, values] of byStage) {
    lines.push(`  ${name} p50 ${seconds(quantile(values, 0.5))} p90 ${seconds(quantile(values, 0.9))} (n=${values.length})`)
  }
  return lines.join('\n') + '\n'
}

export async function reportLedger(path: string): Promise<string> {
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return `no ledger at ${path}\n`
  }
  const events: CdEvent[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(parseEvent(JSON.parse(line) as unknown))
    } catch {
      skipped += 1
    }
  }
  const body = doraText(events)
  return skipped ? `${body}${skipped} ledger line${skipped === 1 ? '' : 's'} skipped\n` : body
}
