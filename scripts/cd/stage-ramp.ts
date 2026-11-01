import { readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { none, orNull, some, type Option } from '../../src/option.ts'
import type { CdConfig } from './config.ts'
import { isTrafficSplit, sameSplit, trafficSplit, type VersionShare } from './deploy-plan.ts'
import { queryCaptured, telemetryQueryRetry } from './o11y.ts'
import { errorMessage } from './proc.ts'
import { activeLog } from './log.ts'
import { readPassVerdict, runRamp, type Observation } from './ramp.ts'
import { fail, pass, type StageResult } from './result.ts'
import type { RolloutPolicy } from './policy.ts'
import { accountProbeLoss, classifyProbe, probeLossRecord, rayOf, type ProbeOutcome } from './probe.ts'
import { runProbeSchedule } from './probe-schedule.ts'
import { writeJson } from './run-dir.ts'
import { routedShare } from './slo.ts'
import { percentile, queryTo, scriptVersionId, serviceFilter, spanTypeFilter, statsFromEvents } from './telemetry.ts'
import { applySplit, readShares, rollbackTo } from './traffic.ts'
import { armStep, beginRamp, endRamp, HarnessFault, noteStepApplied } from './traffic-gate.ts'

export type RampValue = {
  readonly version: string
  readonly previous: string
  readonly lines: readonly string[]
}

function eventsFor(events: readonly unknown[], version: string): unknown[] {
  return events.filter(event => scriptVersionId(event) === version)
}

async function observe(config: CdConfig, version: string, previous: string, from: number, to: number, percent: number): Promise<Observation> {
  const service = serviceFilter(config.worker)
  const query = { view: 'events' as const, filters: [service] }
  try {
    const spansQuery = [service, spanTypeFilter()]
    const retry = telemetryQueryRetry(config.policy)
    const [all, spans] = await Promise.all([
      queryCaptured('events', from, to, [service], retry),
      queryCaptured('events', from, to, spansQuery, retry),
    ])
    const next = statsFromEvents(eventsFor(all.events, version), spans.events)
    const prior = statsFromEvents(eventsFor(all.events, previous), spans.events)
    const aggregate = statsFromEvents(all.events, spans.events)
    const share = routedShare(next.invocations, aggregate.invocations, percent, config.policy.split.z)
    const log = activeLog()
    if (!log) throw new HarnessFault('ramp observation with no active log')
    const ref = await log.observation({
      measurement: {
        source: 'ramp-step',
        available: true,
        percent,
        targetPercent: percent,
        nextRequests: next.invocations,
        previousRequests: prior.invocations,
        aggregateRequests: aggregate.invocations,
        routedNewShare: share.share === null ? null : 100 * share.share,
        toleranceLow: share.low === null ? null : 100 * share.low,
        toleranceHigh: share.high === null ? null : 100 * share.high,
        latency: config.policy.gates.latency.mode,
        nextWallP99: percentile(next.wallMs, 0.99),
        previousWallP99: percentile(prior.wallMs, 0.99),
        nextCpuP99: percentile(next.cpuMs, 0.99),
        previousCpuP99: percentile(prior.cpuMs, 0.99),
        internalInvocations: {
          next: next.internal,
          previous: prior.internal,
          aggregate: aggregate.internal,
        },
      },
      query: { events: all.query, spans: spans.query },
      from,
      to,
      raw: JSON.stringify({ events: all.raw, spans: spans.raw }),
    })
    return { kind: 'sample', next, previous: prior, aggregate, ref }
  } catch (error) {
    if (error instanceof HarnessFault) throw error
    const reason = `telemetry unavailable: ${errorMessage(error)}`
    const log = activeLog()
    if (!log) throw new HarnessFault('ramp observation with no active log')
    const ref = await log.observation({
      measurement: { source: 'ramp-step', available: false, percent, targetPercent: percent, reason },
      query,
      from,
      to,
      raw: JSON.stringify({ error: reason }),
    })
    return { kind: 'unavailable', reason, ref }
  }
}

function versionOf(header: string | null): Option<string> {
  if (header === null || header.length === 0) return none()
  return some(header)
}

/** Unpinned. A policy timeout is `timed_out`. Any other throw is a transport loss. */
async function probeCall(
  id: string,
  method: string,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  parent: AbortSignal,
): Promise<ProbeOutcome> {
  const log = activeLog()
  const started = Date.now()
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), parent])
  try {
    const response = await fetch(url, { method, headers, signal })
    const latencyMs = Date.now() - started
    const version = versionOf(response.headers.get('x-ply-version'))
    const outcome = classifyProbe(id, { kind: 'response', status: response.status, ray: rayOf(response.headers.get('cf-ray')), latencyMs, version })
    if (outcome.kind === 'responded' && log) {
      await log.request({
        method,
        url,
        status: outcome.status,
        version: response.headers.get('x-ply-version'),
        latencyMs,
        cfRay: orNull(outcome.ray),
        requestId: response.headers.get('x-ply-request-id'),
        artifactsRay: response.headers.get('x-artifacts-ray'),
      })
    }
    return outcome
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error'
    if (name === 'TimeoutError') return classifyProbe(id, { kind: 'timeout' })
    const message = error instanceof Error ? error.message : 'probe failed'
    return classifyProbe(id, { kind: 'thrown', name, message })
  }
}

async function dwell(
  token: string,
  baseUrl: string,
  ms: number,
  probe: RolloutPolicy['probe'],
): Promise<readonly ProbeOutcome[]> {
  const live = probe.calls.filter(call => !call.auth || token.length > 0)
  if (probe.rps <= 0 || live.length === 0) {
    await new Promise(resolve => setTimeout(resolve, ms))
    return []
  }
  const controller = new AbortController()
  return runProbeSchedule({
    clock: {
      now: () => Date.now(),
      sleep: wait => new Promise(resolve => setTimeout(resolve, wait)),
    },
    dwellMs: ms,
    periodMs: 1000 / probe.rps,
    maxInFlight: probe.maxInFlight,
    batch: live.length,
    issue: seq => {
      const call = live[(seq - 1) % live.length]
      if (!call) throw new Error('probe call missing')
      const url = `${baseUrl}${call.path}`
      const id = `${seq} ${call.method} ${url}`
      const headers: Record<string, string> = call.auth ? { authorization: `Bearer ${token}` } : {}
      return { id, promise: probeCall(id, call.method, url, headers, probe.timeoutMs, controller.signal) }
    },
    shed: seq => ({ kind: 'shed', id: `${seq} shed` }),
    stop: () => {
      controller.abort(new DOMException('probe dwell deadline', 'TimeoutError'))
    },
  })
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
    /** When set, the version is already at this ramp percent. Do not write it again. */
    readonly fromPercent?: number
  },
): Promise<StageResult<RampValue>> {
  // Traffic already on a ramp step means an earlier run opened the canary gate.
  if (opts.fromPercent === undefined) {
    if (!opts.verdictPath) return fail('ramp', 'ramp needs a PASS verdict file (--verdict); traffic was not changed')
    let verdictText = ''
    try {
      verdictText = await readFile(opts.verdictPath, 'utf8')
    } catch {
      return fail('ramp', `cannot read ${opts.verdictPath}; traffic was not changed`)
    }
    const verdict = readPassVerdict(verdictText, opts.version)
    if (!verdict.ok) return fail('ramp', `${verdict.reason}; traffic was not changed`)
  }
  let previous = opts.previous
  let expected: VersionShare[]
  const fromPercent = opts.fromPercent
  try {
    const shares = await readShares(config.worker)
    if (fromPercent !== undefined) {
      const mine = shares.find(share => share.versionId === opts.version)
      const beside = shares.filter(share => share.versionId !== opts.version)
      const other = beside[0]
      if (!mine || !other || shares.length !== 2 || mine.percentage !== fromPercent || other.percentage !== 100 - fromPercent) {
        return fail('ramp', `expected ${opts.version} at ${fromPercent}% beside the previous version; traffic was not changed`)
      }
      if (previous && previous !== other.versionId) {
        return fail('ramp', `expected ${previous} beside ${opts.version}; traffic was not changed`)
      }
      previous = other.versionId
    } else {
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
    }
    expected = shares.map(share => ({ versionId: share.versionId, percentage: share.percentage }))
  } catch (error) {
    return fail('ramp', `${errorMessage(error)}; traffic was not changed`)
  }
  if (!previous) return fail('ramp', 'no previous version; traffic was not changed')
  const target = previous
  const steps = fromPercent === undefined
    ? config.policy.steps
    : config.policy.steps.filter(step => step.percent >= fromPercent)
  if (fromPercent !== undefined && steps.length === 0) {
    return fail('ramp', `schedule has no step at or above ${fromPercent}%`)
  }
  const policy = { ...config.policy, steps }
  const logPath = join(opts.runDir, 'ramp.jsonl')
  const first = steps[0]
  if (!first) return fail('ramp', 'schedule has no step; traffic was not changed')
  beginRamp(first.percent)
  try {
    const result = await runRamp(policy, {
      now: () => Date.now(),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      dwell: async (ms, percent) => {
        const outcomes = await dwell(opts.token, config.baseUrl, ms, config.policy.probe)
        const loss = accountProbeLoss(outcomes, config.policy.probe.maxLossRate)
        const log = activeLog()
        if (!log) throw new HarnessFault('probe-loss observation with no active log')
        const at = Date.now()
        await log.observation({
          measurement: {
            source: 'probe-loss',
            percent,
            count: loss.count,
            rate: loss.rate,
            total: loss.total,
            responded: loss.responded,
            serverErrors: loss.serverErrors,
            timedOut: loss.timedOut,
            shed: loss.shed,
            aborted: loss.aborted,
            network: loss.network,
            maxLossRate: loss.maxLossRate,
            exceeded: loss.exceeded,
            ids: [...loss.ids],
          },
          query: { source: 'probe' },
          from: at,
          to: at,
          raw: JSON.stringify({ ids: loss.ids }),
        })
        return { outcomes }
      },
      applySplit: async percent => {
        const want = trafficSplit(percent, opts.version, target)
        if (!isTrafficSplit(want)) return want.reason
        if (sameSplit(expected, want.versions)) {
          noteStepApplied(percent)
          return null
        }
        try {
          const applied = await applySplit(config.worker, `ramp ${opts.version} ${percent}%`, want, expected, { kind: 'step', percent })
          if (applied.ok) {
            expected = want.versions.map(share => ({ versionId: share.versionId, percentage: share.percentage }))
            noteStepApplied(percent)
          }
          if (!applied.ok && applied.kind === 'state_conflict') return { kind: 'state_conflict', reason: applied.reason }
          if (!applied.ok) return applied.reason
          return null
        } catch (error) {
          if (error instanceof HarnessFault) throw error
          return errorMessage(error)
        }
      },
      observe: (from, to, percent) => observe(config, opts.version, target, from, queryTo(to), percent),
      onDecision: async (ref, decision, percent) => {
        const log = activeLog()
        if (!log) throw new HarnessFault('ramp decision with no active log')
        log.addStep({ percent, burns: decision.burns })
        await log.decision({
          inputs: [ref],
          rules: decision.rules,
          outcome: decision.outcome,
          reason: decision.reason,
        })
        if (decision.outcome !== 'advance') return
        const index = steps.findIndex(step => step.percent === percent)
        const next = steps[index + 1]
        if (next) armStep(next.percent)
      },
      rollback: async () => {
        const applied = await rollbackTo(config.worker, target, expected)
        if (applied.ok) return null
        if (applied.kind === 'state_conflict') return { kind: 'state_conflict', reason: applied.reason }
        return applied.reason
      },
    })
    const probeLoss = result.steps.map(step => probeLossRecord(step.percent, step.probeLoss))
    for (const step of result.steps) {
      opts.log(step.line)
      await appendFile(logPath, JSON.stringify({ line: step.line, probe_loss: probeLossRecord(step.percent, step.probeLoss) }) + '\n')
    }
    await writeJson(opts.runDir, 'ramp.json', {
      state: result.state,
      lines: result.lines,
      steps: result.steps,
      probeLoss,
      rollbackError: result.rollbackError,
      version: opts.version,
      previous: target,
    })
    if (result.state.kind === 'complete') return pass('ramp', { version: opts.version, previous: target, lines: result.lines })
    if (result.state.kind === 'held') {
      if (result.state.outcome === 'insufficient_samples') return fail('ramp', result.state.reason, false, 'insufficient_samples')
      return fail('ramp', result.state.reason, false)
    }
    if (result.state.kind === 'stopped') {
      if (result.state.fault === 'harness_fault') {
        const rolledBack = result.state.traffic === 'rolled_back' && result.rollbackError === null
        const reason = result.rollbackError ? `${result.state.reason}; traffic change failed: ${result.rollbackError}` : result.state.reason
        return fail('ramp', reason, rolledBack, 'harness_fault')
      }
      return fail('ramp', result.state.reason, false, result.state.fault)
    }
    const reason = result.state.kind === 'rolled-back' ? result.state.reason : 'ramp stopped'
    if (result.rollbackError) return fail('ramp', `${reason}; rollback to ${target} failed: ${result.rollbackError}`)
    return fail('ramp', reason, true)
  } catch (error) {
    if (!(error instanceof HarnessFault)) throw error
    let rolled = false
    try {
      const applied = await rollbackTo(config.worker, target, expected)
      rolled = applied.ok
    } catch (rollbackError) {
      return fail('ramp', `${error.message}; rollback failed: ${errorMessage(rollbackError)}`, false, 'harness_fault')
    }
    return fail('ramp', error.message, rolled, 'harness_fault')
  } finally {
    endRamp()
  }
}
