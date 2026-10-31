import { join } from 'node:path'
import type { CdConfig } from './config.ts'
import { fullSplit, isTrafficSplit } from './deploy-plan.ts'
import { isoOffset, type RunLog } from './log.ts'
import { nextPhase, pipelineStart, type PhaseOutcome } from './pipeline-plan.ts'
import { fail, type Fail, type StageResult } from './result.ts'
import { writeJson } from './run-dir.ts'
import { stageBump } from './stage-bump.ts'
import { stageDeploy } from './stage-deploy.ts'
import { stageRamp } from './stage-ramp.ts'
import { stageRollback } from './stage-rollback.ts'
import { stageSmoke } from './stage-smoke.ts'
import { reportPath, stageTelemetry } from './stage-telemetry.ts'

export type PipelineExit = {
  readonly code: number
  readonly reason: string | null
}

function outcomeOf(result: StageResult<unknown>): PhaseOutcome {
  if (result.kind === 'pass') return 'pass'
  if (result.fault === 'harness_fault') return 'harness-stop'
  if (result.fault === 'state_conflict') return 'state-conflict'
  return result.rolledBack ? 'rolled-back' : 'fail'
}

async function plyMergedAt(sha: string): Promise<string | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/ivarvong/ply/commits/${sha}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ply-web-cd' },
    })
    if (!response.ok) return null
    const body = await response.json() as { commit?: { committer?: { date?: unknown } } }
    const date = body.commit?.committer?.date
    return typeof date === 'string' ? date : null
  } catch {
    return null
  }
}

async function span<T>(log: RunLog, name: string, fn: () => Promise<T>): Promise<T> {
  log.useStage(name)
  const started = Date.now()
  try {
    return await fn()
  } finally {
    log.addStage({
      name,
      startedAt: isoOffset(new Date(started)),
      finishedAt: isoOffset(new Date()),
      durationMs: Date.now() - started,
    })
  }
}

export async function runPipeline(
  config: CdConfig,
  opts: { readonly token: string; readonly sha: string | null; readonly log: (line: string) => void; readonly runDir: string; readonly runLog: RunLog },
): Promise<PipelineExit> {
  const runDir = opts.runDir
  const runLog = opts.runLog
  opts.log(`run: ${runDir}`)
  let state = pipelineStart()
  let failure: Fail | null = null
  let version = ''
  let previous = ''
  const note = async (result: StageResult<unknown>) => {
    if (result.kind === 'fail' && !failure) {
      failure = result
      if (!runLog.facts.failedAt) runLog.patch({ failedAt: isoOffset(new Date()) })
      if (result.rolledBack) {
        runLog.patch({ rolledBack: true, rollbackReason: result.reason, restoredAt: isoOffset(new Date()) })
      }
      await runLog.error(result.reason, { stage: result.stage, rolledBack: result.rolledBack })
    }
  }
  while (state.phase !== 'halt' && state.phase !== 'done') {
    if (state.phase === 'bump') {
      const result = await span(runLog, 'bump', () => stageBump(config, opts.sha))
      await writeJson(runDir, 'bump.json', result)
      await note(result)
      if (result.kind === 'pass') {
        runLog.patch({ plySha: result.value.sha, plyMergedAt: await plyMergedAt(result.value.sha) })
      } else opts.log(`bump: ${result.reason}`)
      state = nextPhase(state, outcomeOf(result))
      continue
    }
    if (state.phase === 'deploy-canary') {
      const result = await span(runLog, 'deploy-canary', () => stageDeploy(config))
      await writeJson(runDir, 'deploy.json', result, [opts.token])
      await note(result)
      if (result.kind === 'pass') {
        version = result.value.version
        previous = result.value.previous
        runLog.patch({ versionId: version })
        opts.log(`version: ${version}`)
        opts.log(`previous: ${previous}`)
      } else opts.log(`deploy-canary: ${result.reason}`)
      state = nextPhase(state, outcomeOf(result))
      continue
    }
    if (state.phase === 'smoke-canary' || state.phase === 'smoke-live') {
      const live = state.phase === 'smoke-live'
      const started = Date.now()
      const result = await span(runLog, live ? 'smoke-live' : 'smoke', () => stageSmoke(config, { version, pin: !live, token: opts.token, runDir }))
      await note(result)
      if (result.kind === 'fail') opts.log(`smoke: ${result.reason}`)
      state = nextPhase(state, outcomeOf(result))
      if (state.phase === 'telemetry-canary' || state.phase === 'telemetry-live') {
        const telemetry = await span(runLog, live ? 'telemetry-live' : 'telemetry', () => stageTelemetry(config, {
          version,
          since: started,
          reportPath: reportPath(runDir, live),
          runDir,
          live,
        }))
        await writeJson(runDir, live ? 'live-telemetry-stage.json' : 'telemetry-stage.json', telemetry, [opts.token])
        await note(telemetry)
        if (telemetry.kind === 'fail') opts.log(`telemetry: ${telemetry.reason}`)
        else opts.log(telemetry.value.line)
        state = nextPhase(state, outcomeOf(telemetry))
      }
      continue
    }
    if (state.phase === 'ramp') {
      const result = await span(runLog, 'ramp', () => stageRamp(config, {
        version,
        previous,
        verdictPath: join(runDir, 'telemetry.json'),
        runDir,
        token: opts.token,
        log: opts.log,
      }))
      await note(result)
      if (result.kind === 'pass') runLog.patch({ liveAt: isoOffset(new Date()) })
      else opts.log(`ramp: ${result.reason}`)
      state = nextPhase(state, outcomeOf(result))
      continue
    }
    if (state.phase === 'rollback') {
      const expected = fullSplit(version)
      const prior = isTrafficSplit(expected) ? expected.versions : []
      const result = await span(runLog, 'rollback', () => stageRollback(config, previous, prior))
      await writeJson(runDir, 'rollback.json', result)
      if (result.kind === 'pass') {
        runLog.patch({ rolledBack: true, rollbackReason: failure?.reason ?? null, restoredAt: isoOffset(new Date()) })
        if (failure) {
          const current: Fail = failure
          failure = { ...current, rolledBack: true }
        }
      }
      if (result.kind === 'fail') {
        const reason = failure ? `${failure.reason}; ${result.reason}` : result.reason
        const fault = result.fault === 'state_conflict' ? 'state_conflict' : 'worker'
        failure = fail(failure?.stage ?? 'rollback', reason, false, fault)
        if (!runLog.facts.failedAt) runLog.patch({ failedAt: isoOffset(new Date()) })
        await runLog.error(result.reason, { stage: 'rollback' })
        opts.log(`rollback: ${result.reason}`)
      }
      state = nextPhase(state, outcomeOf(result))
      continue
    }
    state = { phase: 'halt', smoke: state.smoke }
  }
  const verdictKind = failure?.fault === 'harness_fault'
    ? 'harness_fault' as const
    : failure?.fault === 'state_conflict'
      ? 'state_conflict' as const
      : 'fail' as const
  const verdict = failure
    ? { kind: verdictKind, version, previous, stage: failure.stage, reason: failure.reason, rolledBack: failure.rolledBack, fault: failure.fault, failures: [failure.reason] }
    : { kind: 'pass' as const, version, previous, failures: [] as string[] }
  await writeJson(runDir, 'verdict.json', verdict, [opts.token])
  if (failure) {
    const label = failure.fault === 'worker' ? 'FAIL' : failure.fault
    opts.log(`cd: ${label} ${failure.stage}: ${failure.reason}`)
    return { code: 1, reason: `${failure.stage}: ${failure.reason}` }
  }
  opts.log(`cd: PASS ${version}`)
  return { code: 0, reason: null }
}
