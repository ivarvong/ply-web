import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CLEANUP_FILE, cleanupLeakNames } from './cleanup.ts'
import type { CdConfig } from './config.ts'
import { cfOk, ROOT } from './cf.ts'
import { fullSplit, isTrafficSplit, versionsFromList, type VersionShare } from './deploy-plan.ts'
import { asRecord, extractJson } from './json.ts'
import { isoOffset, type RunLog } from './log.ts'
import { liveVerdict, nextPhase, pipelineStart, type PhaseOutcome, type PipelineState } from './pipeline-plan.ts'
import { errorMessage } from './proc.ts'
import { liveSmokeAlreadyPassed, reconcile, reconcileReason, type Reconcile } from './reconcile.ts'
import { checkoutReason, readCheckout, releasePair, releaseTag, type ReleaseId } from './release.ts'
import { fail, type Fail, type StageResult } from './result.ts'
import { confirmRoute, failureFault, logRoute } from './route-confirm.ts'
import { writeJson } from './run-dir.ts'
import { stageBump } from './stage-bump.ts'
import { stageDeploy } from './stage-deploy.ts'
import { stageRamp } from './stage-ramp.ts'
import { stageRollback } from './stage-rollback.ts'
import { stageSmoke } from './stage-smoke.ts'
import { reportPath, stageTelemetry } from './stage-telemetry.ts'
import { stageVisual } from './stage-visual.ts'
import { readDeployment } from './traffic.ts'

export type PipelineExit = {
  readonly code: number
  readonly reason: string | null
}

async function recordedProbeLoss(runDir: string): Promise<readonly { readonly percent: number; readonly count: number; readonly rate: number; readonly ids: readonly string[] }[]> {
  let text: string
  try {
    text = await readFile(join(runDir, 'ramp.json'), 'utf8')
  } catch {
    return []
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return []
  }
  const rec = asRecord(value)
  if (!rec || !Array.isArray(rec.probeLoss)) return []
  const rows: { readonly percent: number; readonly count: number; readonly rate: number; readonly ids: readonly string[] }[] = []
  for (const item of rec.probeLoss) {
    const row = asRecord(item)
    if (!row) continue
    const ids = Array.isArray(row.ids) ? row.ids.filter(id => typeof id === 'string') : []
    if (typeof row.percent !== 'number' || typeof row.count !== 'number' || typeof row.rate !== 'number') continue
    rows.push({ percent: row.percent, count: row.count, rate: row.rate, ids })
  }
  return rows
}

async function recordedCleanupLeaks(runDir: string): Promise<readonly string[]> {
  let text: string
  try {
    text = await readFile(join(runDir, CLEANUP_FILE), 'utf8')
  } catch {
    return []
  }
  try {
    return cleanupLeakNames(JSON.parse(text) as unknown)
  } catch {
    return []
  }
}

function outcomeOf(result: StageResult<unknown>): PhaseOutcome {
  if (result.kind === 'pass') return 'pass'
  if (result.fault === 'harness_fault' || result.fault === 'harness_unhealthy') return 'harness-stop'
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

async function previousFromDeploy(runDir: string, version: string): Promise<string | null> {
  try {
    const rec = asRecord(JSON.parse(await readFile(join(runDir, 'deploy.json'), 'utf8')))
    if (!rec || rec.kind !== 'pass') return null
    const value = asRecord(rec.value)
    if (!value || value.version !== version || typeof value.previous !== 'string' || value.previous === '') return null
    return value.previous
  } catch {
    return null
  }
}

async function readReconcile(config: CdConfig, release: ReleaseId, runLog: RunLog): Promise<Reconcile> {
  const at = Date.now()
  const pair = releasePair(release)
  const tag = releaseTag(release)
  let versionId: string | null = null
  let split: VersionShare[] = []
  let liveSmokePassed = false
  let error: string | null = null
  let versions: ReturnType<typeof versionsFromList> = []
  try {
    const listed = await cfOk(['workers', 'versions', 'list', '--worker-id', config.worker, '--page', '1', '--per-page', '100'])
    let payload: unknown = listed
    try {
      payload = extractJson(listed)
    } catch {
      payload = listed
    }
    versions = versionsFromList(payload)
    versionId = versions.find(version => version.tag === tag)?.id ?? null
    split = (await readDeployment(config.worker)).versions.map(share => ({ versionId: share.versionId, percentage: share.percentage }))
    if (versionId) liveSmokePassed = await liveSmokeAlreadyPassed(config.runRoot, versionId)
  } catch (caught) {
    error = errorMessage(caught)
  }
  const decision = error
    ? { stage: 'refuse' as const, reason: error }
    : reconcile({ release, versions, split, liveSmokePassed, rampPercents: config.policy.steps.map(step => step.percent) })
  runLog.useStage('reconcile')
  const ref = await runLog.observation({
    measurement: {
      source: 'reconcile',
      sha: release.ply,
      release: pair,
      versionId,
      split,
      liveSmokePassed,
      ...(error ? { error } : {}),
    },
    query: { source: 'cf workers deployments list', worker: config.worker, tag },
    from: at,
    to: Date.now(),
    raw: JSON.stringify({ release: pair, versionId, split, liveSmokePassed, error }),
  })
  await runLog.decision({
    inputs: [ref],
    rules: [{ name: 'reconcile', value: decision.stage }],
    outcome: decision.stage === 'refuse' ? 'harness_fault' : 'advance',
    reason: reconcileReason(decision),
  })
  return decision
}

function jumpedState(next: Exclude<Reconcile, { stage: 'upload' | 'refuse' }>): PipelineState {
  switch (next.stage) {
    case 'smoke-canary':
      return { phase: 'smoke-canary', smoke: null }
    case 'ramp':
      return { phase: 'ramp', smoke: 'pass' }
    case 'smoke-live':
      return { phase: 'smoke-live', smoke: 'pass' }
    case 'done':
      return { phase: 'done', smoke: 'pass' }
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

/**
 * After promotion: the live lifecycle smoke and its telemetry, beside the CDP visual smoke.
 * Each failure is returned in the order the checks finished; a pass is an empty list.
 */
async function liveChecks(
  config: CdConfig,
  runLog: RunLog,
  opts: { readonly version: string; readonly token: string; readonly runDir: string; readonly log: (line: string) => void },
): Promise<readonly StageResult<unknown>[]> {
  // The split write returns before every colo serves it (98.74% at 100% on run 2026-11-06T20-11-49-685Z). The unpinned
  // smoke asserts x-ply-version, so first confirm unpinned traffic the same way the pin is confirmed (route-confirm.ts:
  // fresh connections, a sustained all-new window). A routing failure is a harness fault, never a product verdict; a 5xx
  // served by the new version is the Worker and rolls back (ply-web#146).
  const converged = async (): Promise<StageResult<unknown> | null> => {
    const started = Date.now()
    const verdict = await confirmRoute({ url: `${config.baseUrl}/`, version: opts.version, headers: {}, since: started })
    opts.log(await logRoute({ purpose: 'live', version: opts.version, since: started, started }, verdict))
    if (verdict.kind === 'confirmed') return null
    return fail('smoke', `live: ${verdict.reason}; prod is already at 100% on ${opts.version}`, false, failureFault(verdict))
  }
  const smokeAndTelemetry = async (): Promise<StageResult<unknown>[]> => {
    const route = await converged()
    if (route !== null) {
      opts.log(`smoke: ${route.kind === 'fail' ? route.reason : 'route'}`)
      return [route]
    }
    const started = Date.now()
    const smoke = await span(runLog, 'smoke-live', () => stageSmoke(config, { version: opts.version, pin: false, token: opts.token, runDir: opts.runDir }))
    if (smoke.kind === 'fail') {
      opts.log(`smoke: ${smoke.reason}`)
      return [smoke]
    }
    const telemetry = await span(runLog, 'telemetry-live', () => stageTelemetry(config, {
      version: opts.version,
      since: started,
      reportPath: reportPath(opts.runDir, true),
      runDir: opts.runDir,
      live: true,
    }))
    await writeJson(opts.runDir, 'live-telemetry-stage.json', telemetry, [opts.token])
    if (telemetry.kind === 'fail') opts.log(`telemetry: ${telemetry.reason}`)
    else opts.log(telemetry.value.line)
    return [smoke, telemetry]
  }
  const visual = async (): Promise<StageResult<unknown>[]> => {
    const result = await span(runLog, 'visual', () => stageVisual(config, { runDir: opts.runDir, version: opts.version }))
    opts.log(result.kind === 'pass' ? (result.value.skipped ? `visual: skipped (${result.value.skipped})` : `visual smoke: ${result.value.pages} views ok`) : `visual: ${result.reason}`)
    return [result]
  }
  const settled = await Promise.all([smokeAndTelemetry(), visual()])
  return settled.flat()
}

export async function runPipeline(
  config: CdConfig,
  opts: {
    readonly token: string
    readonly sha: string | null
    readonly noBump: boolean
    /** A 0% version this run may replace in the canary slot (`--replace-canary <id>`). Null refuses any foreign one. */
    readonly replaceCanary: string | null
    readonly release: ReleaseId
    readonly log: (line: string) => void
    readonly runDir: string
    readonly runLog: RunLog
  },
): Promise<PipelineExit> {
  const runDir = opts.runDir
  const runLog = opts.runLog
  runLog.patch({ plySha: opts.release.ply, plyWebSha: opts.release.web, release: releasePair(opts.release) })
  opts.log(`run: ${runDir}`)
  let state = pipelineStart()
  let failure: Fail | null = null
  let version = ''
  let previous = ''
  let fromPercent: number | undefined
  let reconciled = false
  const note = async (result: StageResult<unknown>) => {
    if (result.kind === 'fail' && !failure) {
      failure = result
      if (!runLog.facts.failedAt) runLog.patch({ failedAt: isoOffset(new Date()) })
      if (result.rolledBack) {
        runLog.patch({ rolledBack: true, rollbackReason: result.reason, restoredAt: isoOffset(new Date()) })
      }
      runLog.patch({ fault: result.fault })
      await runLog.error(result.reason, { stage: result.stage, rolledBack: result.rolledBack, fault: result.fault })
    }
  }
  const rampOpts = () => ({
    version,
    previous,
    verdictPath: join(runDir, 'telemetry.json'),
    runDir,
    token: opts.token,
    log: opts.log,
    ...(fromPercent === undefined ? {} : { fromPercent }),
  })
  while (state.phase !== 'halt' && state.phase !== 'done') {
    if (state.phase === 'bump') {
      if (opts.noBump) {
        const at = Date.now()
        const ref = await runLog.observation({
          measurement: { source: 'bump', skipped: true },
          query: { source: 'no-bump' },
          from: at,
          to: at,
          raw: '{"noBump":true}',
        })
        await runLog.decision({
          inputs: [ref],
          rules: [{ name: 'no_bump', value: 1 }],
          outcome: 'advance',
          reason: 'no-bump: deploy the current main as it is',
        })
        state = nextPhase(state, 'pass')
        continue
      }
      const result = await span(runLog, 'bump', () => stageBump(config, opts.sha))
      await writeJson(runDir, 'bump.json', result)
      await note(result)
      if (result.kind === 'pass' && result.value.sha !== opts.release.ply) {
        await note(fail('bump', 'bad-ply-sha: bump resolved a different ply sha than this release', false, 'harness_fault'))
        state = { phase: 'halt', smoke: null }
        continue
      }
      if (result.kind === 'pass') {
        runLog.patch({ plySha: result.value.sha, plyMergedAt: await plyMergedAt(result.value.sha) })
      } else opts.log(`bump: ${result.reason}`)
      state = nextPhase(state, outcomeOf(result))
      continue
    }
    if (state.phase === 'deploy-canary') {
      if (!reconciled) {
        reconciled = true
        const checkout = await readCheckout(ROOT)
        if (!checkout.ok || checkout.web !== opts.release.web) {
          const reason = !checkout.ok
            ? checkoutReason(checkout)
            : `checkout-unavailable: HEAD ${checkout.web} is not the release ply-web sha`
          await note(fail('deploy-canary', reason, false, 'harness_fault'))
          state = { phase: 'halt', smoke: null }
          continue
        }
        const next = await readReconcile(config, opts.release, runLog)
        opts.log(`reconcile: ${reconcileReason(next)}`)
        if (next.stage === 'refuse') {
          await note(fail('deploy-canary', next.reason, false, 'harness_fault'))
          state = { phase: 'halt', smoke: null }
          continue
        }
        if (next.stage !== 'upload') {
          version = next.versionId
          runLog.patch({ versionId: version })
          opts.log(`version: ${version}`)
          if (next.stage === 'smoke-canary' || next.stage === 'ramp') {
            previous = next.previous
            opts.log(`previous: ${previous}`)
          }
          if (next.stage === 'smoke-live') {
            previous = await previousFromDeploy(runDir, next.versionId) ?? ''
            if (previous) opts.log(`previous: ${previous}`)
          }
          if (next.stage === 'ramp') fromPercent = next.percent
          state = jumpedState(next)
          continue
        }
      }
      const result = await span(runLog, 'deploy-canary', () => stageDeploy(config, opts.release, { replaceCanary: opts.replaceCanary }))
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
      // The stepped ramp is the only promotion path (Ivar, 2026-11-08: "Ramp should be the only option."). The live
      // smoke, its telemetry (with the rate gate) and the visual smoke start the moment the 100% step's split is written
      // and run during that step's dwell, which is the live watch: a new-version regression in it rolls back.
      let live: Promise<readonly StageResult<unknown>[]> | null = null
      const result = await span(runLog, 'ramp', () => stageRamp(config, rampOpts(), {
        policy: config.policy,
        onApplied: percent => {
          if (percent < 100 || live) return
          const last = config.policy.steps[config.policy.steps.length - 1]
          opts.log(`ramp: ${version} at 100% (previous ${previous}); live watch ${last ? last.dwellMs : 0} ms beside live smoke + visual smoke`)
          live = liveChecks(config, runLog, { version, token: opts.token, runDir, log: opts.log })
        },
      }))
      const promoted: Promise<readonly StageResult<unknown>[]> | null = live
      if (result.kind === 'fail') {
        // Settle the live checks before the verdict so nothing writes into a sealed log; the watch decided.
        if (promoted) await promoted
        await note(result)
        opts.log(`ramp: ${result.reason}`)
        state = nextPhase(state, outcomeOf(result))
        continue
      }
      runLog.patch({ liveAt: isoOffset(new Date()) })
      // A resumed run whose 100% split was already in place still calls onApplied; this is the belt to that brace.
      const checks = await (promoted === null ? liveChecks(config, runLog, { version, token: opts.token, runDir, log: opts.log }) : promoted)
      // A Worker failure in any live check rolls back; a harness fault stops with the new version live and says so.
      const verdict = liveVerdict(checks)
      const decisive = checks.find(check => check.kind === 'fail' && (verdict !== 'rollback' || check.fault === 'worker'))
      if (decisive) await note(decisive)
      state = { phase: verdict, smoke: state.smoke }
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
        runLog.patch({ fault, failedAt: runLog.facts.failedAt ?? isoOffset(new Date()) })
        await runLog.error(result.reason, { stage: 'rollback' })
        opts.log(`rollback: ${result.reason}`)
      }
      state = nextPhase(state, outcomeOf(result))
      continue
    }
    state = { phase: 'halt', smoke: state.smoke }
  }
  const fault = failure === null ? null : failure.fault
  const verdictKind = fault === 'harness_fault'
    ? 'harness_fault' as const
    : fault === 'state_conflict'
      ? 'state_conflict' as const
      : fault === 'insufficient_samples'
        ? 'insufficient_samples' as const
        : fault === 'harness_unhealthy'
          ? 'harness_unhealthy' as const
          : 'fail' as const
  const probeLoss = await recordedProbeLoss(runDir)
  const cleanupLeak = await recordedCleanupLeaks(runDir)
  const verdict = failure
    ? { kind: verdictKind, version, previous, stage: failure.stage, reason: failure.reason, rolledBack: failure.rolledBack, fault: failure.fault, failures: [failure.reason], probe_loss: probeLoss, cleanup_leak: cleanupLeak }
    : { kind: 'pass' as const, version, previous, failures: [] as string[], probe_loss: probeLoss, cleanup_leak: cleanupLeak }
  await writeJson(runDir, 'verdict.json', verdict, [opts.token])
  if (failure) {
    const label = failure.fault === 'worker' ? 'FAIL' : failure.fault
    opts.log(`cd: ${label} ${failure.stage}: ${failure.reason}`)
    return { code: 1, reason: `${failure.stage}: ${failure.reason}` }
  }
  opts.log(`cd: PASS ${version} ply ${opts.release.ply} web ${opts.release.web}`)
  return { code: 0, reason: null }
}
