import { readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { publicRemote } from '../../src/public.ts'
import { SMOKE_HTTP_MS } from './baseline.ts'
import type { CdConfig } from './config.ts'
import { isTrafficSplit, trafficSplit, type VersionShare } from './deploy-plan.ts'
import { queryCaptured } from './o11y.ts'
import { errorMessage } from './proc.ts'
import { activeLog } from './log.ts'
import { readPassVerdict, runRamp, type Observation } from './ramp.ts'
import { fail, pass, type StageResult } from './result.ts'
import { writeJson } from './run-dir.ts'
import { percentile, queryTo, serviceFilter, statsFromEvents, versionFilter } from './telemetry.ts'
import { applySplit, readShares, rollbackTo } from './traffic.ts'

export type RampValue = {
  readonly version: string
  readonly previous: string
  readonly lines: readonly string[]
}

async function observe(config: CdConfig, version: string, previous: string, from: number, to: number, percent: number): Promise<Observation> {
  const service = serviceFilter(config.worker)
  const nextQuery = { view: 'events' as const, filters: [service, versionFilter(version)] }
  try {
    const [nextEvents, previousEvents, traces] = await Promise.all([
      queryCaptured('events', from, to, [service, versionFilter(version)]),
      queryCaptured('events', from, to, [service, versionFilter(previous)]),
      queryCaptured('traces', from, to, [service]),
    ])
    const next = statsFromEvents(nextEvents.events, traces.events)
    const prior = statsFromEvents(previousEvents.events, traces.events)
    const ref = await activeLog()?.observation({
      measurement: {
        source: 'ramp-step',
        available: true,
        percent,
        nextRequests: next.requests,
        previousRequests: prior.requests,
        observedPercent: next.requests + prior.requests === 0 ? null : (100 * next.requests) / (next.requests + prior.requests),
        nextWallP99: percentile(next.wallMs, 0.99),
        previousWallP99: percentile(prior.wallMs, 0.99),
      },
      query: { next: nextEvents.query, previous: previousEvents.query, traces: traces.query },
      from,
      to,
      raw: JSON.stringify({ next: nextEvents.raw, previous: previousEvents.raw, traces: traces.raw }),
    })
    return { kind: 'sample', next, previous: prior, ...(ref ? { ref } : {}) }
  } catch (error) {
    const reason = `telemetry unavailable: ${errorMessage(error)}`
    const ref = await activeLog()?.observation({
      measurement: { source: 'ramp-step', available: false, percent, reason },
      query: nextQuery,
      from,
      to,
      raw: JSON.stringify({ error: reason }),
    })
    return { kind: 'unavailable', reason, ...(ref ? { ref } : {}) }
  }
}

async function probeCall(
  config: CdConfig,
  version: string,
  pin: string,
  method: string,
  url: string,
  headers: Record<string, string>,
): Promise<{ readonly failures: number; readonly harness: number }> {
  const log = activeLog()
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method,
      headers: { ...headers, 'Cloudflare-Workers-Version-Overrides': `${config.worker}="${pin}"` },
      signal: AbortSignal.timeout(SMOKE_HTTP_MS),
    })
    const seen = response.headers.get('x-ply-version')
    const status = response.status
    await log?.request({
      method,
      url,
      status,
      version: seen,
      latencyMs: Date.now() - started,
      cfRay: response.headers.get('cf-ray'),
      requestId: response.headers.get('x-ply-request-id'),
      artifactsRay: response.headers.get('x-artifacts-ray'),
    })
    if (status === 0) return { failures: 0, harness: 1 }
    if (seen === version && (status < 200 || status >= 300)) return { failures: 1, harness: 0 }
    return { failures: 0, harness: 0 }
  } catch (error) {
    await log?.error(errorMessage(error), { stage: 'ramp', url })
    return { failures: 0, harness: 1 }
  }
}

/** Each arm is pinned, so the new version is sampled at the probe rate instead of the split. */
async function probeOnce(
  config: CdConfig,
  version: string,
  previous: string,
  token: string,
): Promise<{ readonly failures: number; readonly harness: number }> {
  const remote = publicRemote('ply')
  const discover = `${config.baseUrl}/v1/discover?remote=${encodeURIComponent(remote)}`
  let failures = 0
  let harness = 0
  await Promise.all([version, previous].map(async pin => {
    const root = await probeCall(config, version, pin, 'GET', `${config.baseUrl}/`, {})
    failures += root.failures
    harness += root.harness
    if (!token) return
    const read = await probeCall(config, version, pin, 'GET', discover, { authorization: `Bearer ${token}` })
    failures += read.failures
    harness += read.harness
  }))
  return { failures, harness }
}

async function dwell(
  config: CdConfig,
  version: string,
  previous: string,
  token: string,
  ms: number,
  rps: number,
): Promise<{ probeFailures: number; harnessFaults: number }> {
  if (rps <= 0) {
    await new Promise(resolve => setTimeout(resolve, ms))
    return { probeFailures: 0, harnessFaults: 0 }
  }
  const deadline = Date.now() + ms
  const period = 1000 / rps
  let probeFailures = 0
  let harnessFaults = 0
  while (Date.now() < deadline) {
    const tick = Date.now()
    const probed = await probeOnce(config, version, previous, token)
    probeFailures += probed.failures
    harnessFaults += probed.harness
    const remain = Math.min(period - (Date.now() - tick), deadline - Date.now())
    if (remain > 0) await new Promise(resolve => setTimeout(resolve, remain))
  }
  return { probeFailures, harnessFaults }
}

export async function stageRamp(
  config: CdConfig,
  opts: {
    readonly version: string
    readonly previous: string | null
    readonly verdictPath: string | null
    readonly runDir: string
    readonly token: string
    readonly log: (line: string) => void
  },
): Promise<StageResult<RampValue>> {
  if (!opts.verdictPath) return fail('ramp', 'ramp needs a PASS verdict file (--verdict); traffic was not changed')
  let verdictText = ''
  try {
    verdictText = await readFile(opts.verdictPath, 'utf8')
  } catch {
    return fail('ramp', `cannot read ${opts.verdictPath}; traffic was not changed`)
  }
  const verdict = readPassVerdict(verdictText, opts.version)
  if (!verdict.ok) return fail('ramp', `${verdict.reason}; traffic was not changed`)
  let previous = opts.previous
  let expected: VersionShare[]
  try {
    const shares = await readShares(config.worker)
    const live = shares.find(share => share.percentage === 100)
    const dark = shares.find(share => share.versionId === opts.version)
    if (!live) return fail('ramp', 'no version at 100%; traffic was not changed')
    if (!previous) previous = live.versionId
    if (live.versionId !== previous || live.percentage !== 100) {
      return fail('ramp', `expected ${previous} at 100% before the ramp; traffic was not changed`)
    }
    if (!dark || dark.percentage !== 0 || shares.length !== 2) {
      return fail('ramp', `expected ${opts.version} at 0% beside ${previous}; traffic was not changed`)
    }
    expected = shares.map(share => ({ versionId: share.versionId, percentage: share.percentage }))
  } catch (error) {
    return fail('ramp', `${errorMessage(error)}; traffic was not changed`)
  }
  const target = previous
  const logPath = join(opts.runDir, 'ramp.jsonl')
  const result = await runRamp(config.schedule, {
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    dwell: ms => dwell(config, opts.version, target, opts.token, ms, config.schedule.probeRps),
    applySplit: async percent => {
      const want = trafficSplit(percent, opts.version, target)
      if (!isTrafficSplit(want)) return want.reason
      try {
        const applied = await applySplit(config.worker, `ramp ${opts.version} ${percent}%`, want, expected)
        if (applied.ok) expected = want.versions.map(share => ({ versionId: share.versionId, percentage: share.percentage }))
        if (!applied.ok && applied.kind === 'state_conflict') return { kind: 'state_conflict', reason: applied.reason }
        if (!applied.ok) return applied.reason
        return null
      } catch (error) {
        return errorMessage(error)
      }
    },
    observe: (from, to, percent) => observe(config, opts.version, target, from, queryTo(to), percent),
    onDecision: async (ref, decision, percent) => {
      const log = activeLog()
      if (!log) return
      log.addStep({ percent, burns: decision.burns })
      await log.decision({
        inputs: [ref],
        rules: decision.rules,
        outcome: decision.outcome,
        reason: decision.reason,
      })
    },
    rollback: async () => {
      const applied = await rollbackTo(config.worker, target, expected)
      if (applied.ok) return null
      if (applied.kind === 'state_conflict') return { kind: 'state_conflict', reason: applied.reason }
      return applied.reason
    },
  })
  for (const line of result.lines) {
    opts.log(line)
    await appendFile(logPath, JSON.stringify({ line }) + '\n')
  }
  await writeJson(opts.runDir, 'ramp.json', {
    state: result.state,
    lines: result.lines,
    steps: result.steps,
    rollbackError: result.rollbackError,
    version: opts.version,
    previous: target,
  })
  if (result.state.kind === 'complete') return pass('ramp', { version: opts.version, previous: target, lines: result.lines })
  if (result.state.kind === 'stopped') return fail('ramp', result.state.reason, false, result.state.fault)
  const reason = result.state.kind === 'rolled-back' ? result.state.reason : 'ramp stopped'
  if (result.rollbackError) return fail('ramp', `${reason}; rollback to ${target} failed: ${result.rollbackError}`)
  return fail('ramp', reason, true)
}
