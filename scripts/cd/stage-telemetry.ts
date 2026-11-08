import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SMOKE_LATENCY, TELEMETRY_CHUNK, TELEMETRY_POLLS_MS, TELEMETRY_WAIT_MS } from './baseline.ts'
import { pollEditSpans, type SpanCheck } from './span-check.ts'
import { raysByRequestId } from './csv.ts'
import { asRecord } from './json.ts'
import { activeLog } from './log.ts'
import { queryAll, queryCapturedSliced, queryCounts, telemetryQueryRetry, type QueryRetry } from './o11y.ts'
import { countsFromRows, pollRate, queryRateRows, sendRateProbes, type ProbeResult, type RateVerdict } from './rate-gate.ts'
import { readTokenFile } from './token.ts'
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
  traceIdOf,
  telemetryMarkdown,
  telemetryQuery,
  versionFilter,
  type Filter,
  type SmokeRequest,
  dedupeRows,
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

async function logsFor(
  config: CdConfig,
  from: number,
  to: number,
  ids: readonly string[],
  version: string | null,
  retry: QueryRetry,
): Promise<unknown[]> {
  const filters: Filter[] = [serviceFilter(config.worker)]
  if (version) filters.push(versionFilter(version))
  const out: unknown[] = []
  for (const group of chunks(ids)) {
    out.push(...await queryAll('events', from, to, [
      ...filters,
      { key: 'msg', operation: 'eq', type: 'string', value: 'ply.request' },
      { key: 'id', operation: 'in', type: 'string', value: group.join(',') },
    ], retry))
  }
  return out
}

/**
 * Traces-view rows or span events of the smoke's own traces only. An unscoped query over the window pages through every
 * span the Worker emitted: under load that is over TELEMETRY_MAX_PAGES (run 2026-11-06T21-37-46-183Z: 50 pages in 80 s,
 * harness_fault). Span events carry no script version, so the scope is the traceIds on the smoke's own log lines.
 */
async function byTrace(config: CdConfig, view: 'events' | 'traces', from: number, to: number, traceIds: readonly string[], retry: QueryRetry): Promise<unknown[]> {
  const base: Filter[] = view === 'events' ? [serviceFilter(config.worker), spanTypeFilter()] : [serviceFilter(config.worker)]
  const groups = chunks(traceIds)
  const pages = await Promise.all(groups.map(group => queryAll(view, from, to, [
    ...base,
    { key: '$metadata.traceId', operation: 'in', type: 'string', value: group.join(',') },
  ], retry)))
  return pages.flat()
}

function traceIdsOf(events: readonly unknown[]): string[] {
  const ids = new Set<string>()
  for (const item of events) {
    const event = asRecord(item)
    if (!event) continue
    const id = traceIdOf(event)
    if (id) ids.add(id)
  }
  return [...ids]
}

/** The span check over the window, starting from the span events already queried; later polls query again. */
async function editSpans(config: CdConfig, requests: readonly SmokeRequest[], from: number, first: readonly unknown[], retry: QueryRetry, traceIds: readonly string[]): Promise<SpanCheck> {
  let page: readonly unknown[] | null = first
  return pollEditSpans(requests, {
    query: async () => {
      if (page !== null) {
        const ready = page
        page = null
        return ready
      }
      return byTrace(config, 'events', from, queryTo(Date.now()), traceIds, retry)
    },
    sleep,
    now: () => Date.now(),
    pollsMs: TELEMETRY_POLLS_MS,
    waitMs: TELEMETRY_WAIT_MS,
  })
}

/**
 * The rate limiter's silent-degradation gate (scripts/cd/rate-gate.ts): pinned probes as a load client, then the
 * version's own rate spans since `from`, polled until enough warm default-mode checks are in.
 */
export async function rateGate(config: CdConfig, opts: { readonly version: string; readonly from: number; readonly runDir: string; readonly live: boolean }): Promise<{ verdict: RateVerdict; probes: ProbeResult | null }> {
  const policy = config.policy.rate
  let probes: ProbeResult | null = null
  if (policy.probes > 0) {
    let loadToken: string
    try {
      loadToken = await readTokenFile(config.loadTokenFile, 'PLY_LOAD_TOKEN_FILE')
    } catch (error) {
      return { verdict: { kind: 'harness_fault', line: `rate: cannot send probes: ${errorMessage(error)}`, counts: null }, probes: null }
    }
    const label = `cd-rate:${opts.runDir.split('/').pop() || 'run'}:${opts.live ? 'live' : 'canary'}`
    probes = await sendRateProbes({ baseUrl: config.baseUrl, worker: config.worker, version: opts.version, loadToken, label, policy }, {
      fetch: (url, init) => fetch(url, init),
      sleep,
    })
  }
  const retry = telemetryQueryRetry(config.policy)
  const verdict = await pollRate(policy, {
    query: async () => countsFromRows(await queryRateRows(config.worker, opts.version, (filters, groupBys) => queryCounts(opts.from, queryTo(Date.now()), filters, groupBys, retry))),
    sleep,
    now: () => Date.now(),
    pollsMs: TELEMETRY_POLLS_MS,
    waitMs: TELEMETRY_WAIT_MS,
  })
  const probeLine = probes === null ? '' : ` [probes ${probes.answered}/${probes.sent} answered, ${probes.onVersion} on ${opts.version.slice(0, 8)}, ${JSON.stringify(probes.statuses)}]`
  return { verdict: { ...verdict, line: `${verdict.line}${probeLine}` }, probes }
}

export async function stageTelemetry(
  config: CdConfig,
  opts: { readonly version: string; readonly since: number; readonly reportPath: string; readonly runDir: string; readonly live: boolean },
): Promise<StageResult<TelemetryValue>> {
  try {
    const requests = await withRays(opts.reportPath, readSmokeRequests(await readFile(opts.reportPath, 'utf8')))
    const retry = telemetryQueryRetry(config.policy)
    const from = opts.since
    // Runs beside the smoke telemetry: its probes and its own ingest wait overlap the smoke's.
    const rate = rateGate(config, { version: opts.version, from, runDir: opts.runDir, live: opts.live }).catch((error: unknown): { verdict: RateVerdict; probes: null } => ({
      verdict: { kind: 'harness_fault', line: `rate: telemetry unavailable: ${errorMessage(error)}`, counts: null },
      probes: null,
    }))
    let events: unknown[] = []
    const started = Date.now()
    for (let attempt = 0; ; attempt++) {
      events = await logsFor(config, from, queryTo(Date.now()), requests.map(request => request.id), opts.version, retry)
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
    if (missing.length) events.push(...await logsFor(config, from, queryTo(Date.now()), missing, null, retry))
    const to = queryTo(Date.now())
    const scoped = [serviceFilter(config.worker), versionFilter(opts.version)]
    // Sliced: on the live version this is every invocation in the window (≈370 non-span events/s under load, 2026-11-06).
    const health = (await queryCapturedSliced('events', from, to, scoped, retry)).events
    // The traces view is one summary row per trace and has no child spans. Fetch durations come from span events.
    const traceIds = traceIdsOf(events)
    const [traces, spans] = await Promise.all([
      byTrace(config, 'traces', from, to, traceIds, retry),
      byTrace(config, 'events', from, to, traceIds, retry),
    ])
    const combined = dedupeRows([...events, ...health])
    const summary = summarizeTelemetry(opts.version, requests, combined, traces, spans)
    const { maxLossRate } = config.policy.telemetry
    const loss = telemetryLoss(requests, summary, maxLossRate)
    const judged = judgeSmokeTelemetry({ version: opts.version, requests, summary, ceilings: SMOKE_LATENCY, maxLossRate })
    const judge = applyGates(judged, config.policy.gates)
    // #67: the pinned smoke's edit-traced request must show ply's spans in Workers tracing. Pinned only: it gates the 0%
    // canary, and a tracing regression found after 100% is not a reason to roll back.
    const spanCheck: SpanCheck | null = opts.live ? null : await editSpans(config, requests, from, spans, retry, traceIds)
    const rateResult = await rate
    const rateVerdict = rateResult.verdict
    const stem = opts.live ? 'live-telemetry' : 'telemetry'
    const spanLine = spanCheck === null ? '' : `\n\n${spanCheck.line}\n`
    await writeText(opts.runDir, `${stem}.md`, `${telemetryMarkdown({ version: opts.version, from, to, judge, summary, loss })}${spanLine}\n\n${rateVerdict.line}\n`)
    const failures = judge.kind === 'worker'
      ? judge.failures.map(failure => {
        if (failure.kind === 'unexpected-status') return `unexpected-status ${failure.id} ${failure.status}`
        if (failure.kind === 'latency') return `latency ${failure.metric} ${failure.p} ${failure.value} > ${failure.ceiling}`
        return `${failure.kind}: ${failure.detail}`
      })
      : judge.kind === 'harness_fault' ? [judge.reason] : []
    // The span check decides only when everything else passed: a worker fault or a harness fault above is reported first.
    const spanVerdict = judge.kind === 'pass' && spanCheck !== null && spanCheck.kind !== 'pass' ? spanCheck : null
    if (spanVerdict) failures.push(spanVerdict.line)
    // The rate gate decides after the smoke and span checks. A rate worker verdict is a silent degradation: canary stops,
    // live rolls back. A rate harness fault (too few checks ingested, probes unsendable) is unevaluable, not a pass.
    const rateDecides = judge.kind === 'pass' && spanVerdict === null && rateVerdict.kind !== 'pass' ? rateVerdict : null
    if (rateDecides) failures.push(rateDecides.line)
    const kind = spanVerdict ? spanVerdict.kind : rateDecides ? rateDecides.kind : judge.kind
    const line = `${spanCheck === null ? judge.line : `${judge.line}\n${spanCheck.line}`}\n${rateVerdict.line}`
    const verdict = {
      kind,
      pass: kind === 'pass',
      version: opts.version,
      failures,
      line,
      loss,
      spans: spanCheck,
      rate: { kind: rateVerdict.kind, line: rateVerdict.line, counts: rateVerdict.counts, probes: rateResult.probes },
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
        }, ...(spanCheck === null ? [] : [{ name: 'ply_spans', value: spanCheck.kind }]), { name: 'rate_degradation', value: rateVerdict.kind }],
        outcome: kind === 'pass' ? 'advance' : kind === 'harness_fault' ? 'harness_fault' : opts.live ? 'rollback' : 'stop',
        reason: spanVerdict ? spanVerdict.line : rateDecides ? rateDecides.line : judge.line,
      })
    }
    if (judge.kind === 'harness_fault') return fail('telemetry', judge.reason, false, 'harness_fault')
    if (judge.kind === 'worker') return fail('telemetry', judge.line)
    if (spanVerdict && spanVerdict.kind === 'harness_fault') return fail('telemetry', spanVerdict.line, false, 'harness_fault')
    if (spanVerdict) return fail('telemetry', spanVerdict.line)
    if (rateDecides && rateDecides.kind === 'harness_fault') return fail('telemetry', rateDecides.line, false, 'harness_fault')
    if (rateDecides) return fail('telemetry', rateDecides.line)
    return pass('telemetry', { version: opts.version, line, from, to })
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
