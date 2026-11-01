import {
  assertSplit,
  deploymentBody,
  fullSplit,
  isFullRollback,
  isTrafficSplit,
  parseDeployment,
  sameSplit,
  type TrafficSplit,
  type VersionShare,
} from './deploy-plan.ts'
import { cfOk } from './cf.ts'
import { extractJson } from './json.ts'
import { activeLog } from './log.ts'
import { errorMessage } from './proc.ts'
import { HarnessFault, withTrafficLock, withWriteIntent, type WriteIntent } from './traffic-gate.ts'

export type Deployment = {
  readonly id: string | null
  readonly versions: readonly VersionShare[]
}

export async function readDeployment(worker: string, secrets: readonly string[] = []): Promise<Deployment> {
  const stdout = await cfOk(['workers', 'deployments', 'list', '--worker', worker], secrets)
  return parseDeployment(extractJson(stdout))
}

export async function readShares(worker: string, secrets: readonly string[] = []): Promise<VersionShare[]> {
  return [...(await readDeployment(worker, secrets)).versions]
}

export async function putSplit(worker: string, message: string, split: TrafficSplit, secrets: readonly string[] = []): Promise<void> {
  const body = deploymentBody(message, split)
  await cfOk(['workers', 'deployments', 'create', '--worker', worker, '--body', JSON.stringify(body)], secrets)
}

export type ApplyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'state_conflict'; readonly reason: string }
  | { readonly ok: false; readonly kind: 'rejected'; readonly reason: string }

/**
 * Compare-and-swap. Read the deployment and put `split` only when it is still `expected`.
 * A mismatch emits `state_conflict` and does not call cf. The caller stops; it does not roll back.
 * The write runs under the process lock, and only for `intent`.
 */
export async function applySplit(
  worker: string,
  message: string,
  split: TrafficSplit,
  expected: readonly VersionShare[],
  intent: WriteIntent,
  secrets: readonly string[] = [],
): Promise<ApplyResult> {
  return withTrafficLock(() => withWriteIntent(intent, () => writeSplit(worker, message, split, expected, secrets)))
}

async function requireLog(reason: string) {
  const log = activeLog()
  if (!log) throw new HarnessFault(reason)
  return log
}

async function writeSplit(
  worker: string,
  message: string,
  split: TrafficSplit,
  expected: readonly VersionShare[],
  secrets: readonly string[],
): Promise<ApplyResult> {
  const before = await readDeployment(worker, secrets)
  if (!sameSplit(before.versions, expected)) {
    const reason = 'deployment does not match the expected prior state'
    const log = await requireLog('state conflict with no active log')
    const at = Date.now()
    const ref = await log.observation({
      measurement: { source: 'state_conflict', expected: [...expected], actual: [...before.versions] },
      query: { source: 'cf workers deployments list', worker },
      from: at,
      to: at,
      raw: JSON.stringify({ expected, actual: before.versions }),
    })
    await log.decision({
      inputs: [ref],
      rules: [{ name: 'deployment_cas', value: 'expected_prior' }],
      outcome: 'state_conflict',
      reason,
    })
    return { ok: false, kind: 'state_conflict', reason }
  }
  await putSplit(worker, message, split, secrets)
  const after = await readDeployment(worker, secrets)
  const log = await requireLog('deployment read-back with no active log')
  await log.stateChange({ before: before.versions, after: after.versions, deploymentId: after.id })
  const mismatch = assertSplit(after.versions, split)
  if (mismatch) return { ok: false, kind: 'rejected', reason: mismatch }
  return { ok: true }
}

/** Null when the deployment matches. Otherwise why it does not. */
export async function confirmSplit(worker: string, split: TrafficSplit, secrets: readonly string[] = []): Promise<string | null> {
  const versions = await readShares(worker, secrets)
  return assertSplit(versions, split)
}

/**
 * Move the previous version to 100% alone and read the deployment back.
 * Returns null when that is what is live. The error names the version that should be at 100%.
 */
export async function rollbackTo(
  worker: string,
  previous: string,
  expected: readonly VersionShare[],
  secrets: readonly string[] = [],
): Promise<ApplyResult> {
  const split = fullSplit(previous)
  if (!isTrafficSplit(split)) return { ok: false, kind: 'rejected', reason: `rollback refused: ${split.reason}` }
  try {
    const applied = await withTrafficLock(() => withWriteIntent({ kind: 'rollback' }, () => writeSplit(worker, `rollback ${previous}`, split, expected, secrets)))
    if (!applied.ok) return applied
    const versions = await readShares(worker, secrets)
    if (isFullRollback(versions, previous)) return { ok: true }
    return { ok: false, kind: 'rejected', reason: `rollback did not land on ${previous} at 100%` }
  } catch (error) {
    if (error instanceof HarnessFault) throw error
    return { ok: false, kind: 'rejected', reason: `rollback to ${previous} failed: ${errorMessage(error)}` }
  }
}
