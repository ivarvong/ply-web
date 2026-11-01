import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SMOKE_LATENCY, TELEMETRY_CHUNK, TELEMETRY_POLLS_MS, TELEMETRY_WAIT_MS } from './baseline.ts'
import { raysByRequestId } from './csv.ts'
import { asRecord } from './json.ts'
import { activeLog } from './log.ts'
import { queryAll } from './o11y.ts'
import { errorMessage } from './proc.ts'
import { fail, pass, type StageResult } from './result.ts'
import { writeJson, writeText } from './run-dir.ts'
import {
  applyGates,
  judgeSmokeTelemetry,
  lossLine,
  telemetryLoss,
  queryFault,
  queryTo,
  serviceFilter,
  spanTypeFilter,
  summarizeTelemetry,
  telemetryMarkdown,
  telemetryQuery,
  versionFilter,
  type Filter,
  type SmokeRequest,
} from './telemetry.ts'
import type { CdConfig } from './config.ts'

export type TelemetryValue = {
  readonly version: string
  readonly line: string
  readonly from: number
  readonly to: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function readSmokeRequests(text: string): SmokeRequest[] {
  const parsed = JSON.parse(text) as unknown
  const rec = asRecord(parsed)
  const requests = rec?.requests
  if (!Array.isArray(requests)) return []
  const out: SmokeRequest[] = []
  for (const item of requests) {
    const row = asRecord(item)
    if (!row || typeof row.id !== 'string') continue
    const expected = Array.isArray(row.expected) ? row.expected.filter((status): status is number => typeof status === 'number') : []
    const ray = typeof row.ray === 'string' ? row.ray : typeof row.cfRay === 'string' ? row.cfRay : typeof row.cf_ray === 'string' ? row.cf_ray : null
    out.push({
      id: row.id,
      version: typeof row.version === 'string' ? row.version : null,
      step: typeof row.step === 'string' ? row.step : '?',
      status: typeof row.status === 'number' ? row.status : 0,
      expected,
      ray: ray === '' ? null : ray,
    })
  }
  return out
}

function chunks(ids: readonly string[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += TELEMETRY_CHUNK) out.push(ids.slice(i, i + TELEMETRY_CHUNK))
  return out
}

function csvSibling(reportPath: string): string {
  return reportPath.endsWith('.json') ? `${reportPath.slice(0, -'.json'.length)}.csv` : `${reportPath}.csv`
}

/** The smoke CSV already records each request's cf-ray. Fill a report row that omitted it. */
async function withRays(reportPath: string, requests: readonly SmokeRequest[]): Promise<SmokeRequest[]> {
  let rays = new Map<string, string>()
  try {
    rays = new Map(raysByRequestId(await readFile(csvSibling(reportPath), 'utf8')))
  } catch {
    return [...requests]
  }
  return requests.map(request => {
    if (request.ray) return request
    const ray = rays.get(request.id)
    return ray ? { ...request, ray } : request
  })
}

async function logsFor(config: CdConfig, from: number, to: number, ids: readonly string[], version: string | null): Promise<unknown[]> {
  const filters: Filter[] = [serviceFilter(config.worker)]
  if (version) filters.push(versionFilter(version))
  const out: unknown[] = []
  for (const group of chunks(ids)) {
    out.push(...await queryAll('events', from, to, [
      ...filters,
      { key: 'msg', operation: 'eq', type: 'string', value: 'ply.request' },
      { key: 'id', operation: 'in', type: 'string', value: group.join(',') },
    ]))
  }
  return out
}

export async function stageTelemetry(
  config: CdConfig,
  opts: { readonly version: string; readonly since: number; readonly reportPath: string; readonly runDir: string; readonly live: boolean },
): Promise<StageResult<TelemetryValue>> {
  try {
    const requests = await withRays(opts.reportPath, readSmokeRequests(await readFile(opts.reportPath, 'utf8')))
    const from = opts.since
    let events: unknown[] = []
    const started = Date.now()
    for (let attempt = 0; ; attempt++) {
      events = await logsFor(config, from, queryTo(Date.now()), requests.map(request => request.id), opts.version)
      const seen = new Set(events.map(event => {
        const source = asRecord(asRecord(event)?.source)
        return typeof source?.id === 'string' ? source.id : ''
      }).filter(Boolean))
      const waiting = Date.now() - started
      if (requests.every(request => seen.has(request.id)) || waiting >= TELEMETRY_WAIT_MS) break
      const pause = TELEMETRY_POLLS_MS[attempt] ?? TELEMETRY_POLLS_MS[TELEMETRY_POLLS_MS.length - 1] ?? 15_000
      await sleep(Math.min(pause, TELEMETRY_WAIT_MS - waiting))
    }
    const missing = requests.filter(request => !events.some(event => asRecord(asRecord(event)?.source)?.id === request.id)).map(request => request.id)
    if (missing.length) events.push(...await logsFor(config, from, queryTo(Date.now()), missing, null))
    const to = queryTo(Date.now())
    const scoped = [serviceFilter(config.worker), versionFilter(opts.version)]
    const health = await queryAll('events', from, to, scoped)
    const service = serviceFilter(config.worker)
    // The traces view is one summary row per trace and has no child spans. Fetch durations come from span events.
    const traces = await queryAll('traces', from, to, [service])
    const spans = await queryAll('events', from, to, [service, spanTypeFilter()])
    const seen = new Set<string>()
    const combined = []
    for (const event of [...events, ...health]) {
      const id = asRecord(asRecord(event)?.$metadata)?.id
      if (typeof id === 'string') {
        if (seen.has(id)) continue
        seen.add(id)
      }
      combined.push(event)
    }
    const summary = summarizeTelemetry(opts.version, requests, combined, traces, spans)
    const { maxLossRate } = config.policy.telemetry
    const loss = telemetryLoss(requests, summary, maxLossRate)
    const judged = judgeSmokeTelemetry({ version: opts.version, requests, summary, ceilings: SMOKE_LATENCY, maxLossRate })
    const judge = applyGates(judged, config.policy.gates)
    const markdown = telemetryMarkdown({ version: opts.version, from, to, judge, summary, loss })
    const stem = opts.live ? 'live-telemetry' : 'telemetry'
    await writeText(opts.runDir, `${stem}.md`, markdown)
    const failures = judge.kind === 'worker'
      ? judge.failures.map(failure => {
        if (failure.kind === 'unexpected-status') return `unexpected-status ${failure.id} ${failure.status}`
        if (failure.kind === 'latency') return `latency ${failure.metric} ${failure.p} ${failure.value} > ${failure.ceiling}`
        return `${failure.kind}: ${failure.detail}`
      })
      : judge.kind === 'harness_fault' ? [judge.reason] : []
    const verdict = {
      kind: judge.kind === 'pass' ? 'pass' : judge.kind,
      pass: judge.kind === 'pass',
      version: opts.version,
      failures,
      line: judge.line,
      loss,
      from,
      to,
    }
    await writeJson(opts.runDir, `${stem}.json`, verdict)
    const log = activeLog()
    if (log) {
      await log.observation({
        measurement: {
          source: 'telemetry-loss',
          live: opts.live,
          count: loss.count,
          total: loss.total,
          rate: loss.rate,
          maxLossRate: loss.maxLossRate,
          exceeded: loss.exceeded,
          ids: loss.ids.map(lost => ({ id: lost.id, step: lost.step, log: lost.log, trace: lost.trace })),
        },
        query: { logs: telemetryQuery('events', from, to, [serviceFilter(config.worker)], null) },
        from,
        to,
        raw: lossLine(loss),
      })
      const ref = await log.observation({
        measurement: { source: 'smoke-telemetry', pass: judge.kind === 'pass', line: judge.line },
        query: {
          traces: telemetryQuery('traces', from, to, [serviceFilter(config.worker)], null),
          spans: telemetryQuery('events', from, to, [serviceFilter(config.worker), spanTypeFilter()], null),
        },
        from,
        to,
        raw: JSON.stringify({ line: judge.line, failures }),
      })
      await log.decision({
        inputs: [ref],
        rules: [{
          name: judge.kind === 'harness_fault'
            ? (judge.checks.some(check => check.kind === 'join') ? 'span_join' : 'telemetry_evaluable')
            : 'smoke_telemetry',
          value: judge.kind === 'pass' ? 'pass' : judge.kind,
        }],
        outcome: judge.kind === 'pass' ? 'advance' : judge.kind === 'harness_fault' ? 'harness_fault' : opts.live ? 'rollback' : 'stop',
        reason: judge.line,
      })
    }
    if (judge.kind === 'harness_fault') return fail('telemetry', judge.reason, false, 'harness_fault')
    if (judge.kind === 'worker') return fail('telemetry', judge.line)
    return pass('telemetry', { version: opts.version, line: judge.line, from, to })
  } catch (error) {
    const fault = queryFault(`telemetry unavailable: ${errorMessage(error)}`)
    await activeLog()?.error(fault.reason, { stage: 'telemetry', fault: fault.kind })
    const stem = opts.live ? 'live-telemetry' : 'telemetry'
    await writeJson(opts.runDir, `${stem}.json`, { kind: fault.kind, pass: false, version: opts.version, failures: [fault.reason], line: fault.reason })
    return fail('telemetry', fault.reason, false, fault.kind)
  }
}

export function reportPath(runDir: string, live: boolean): string {
  return join(runDir, live ? 'live-smoke.json' : 'smoke.json')
}
