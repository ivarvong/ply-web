import {
  assertSplit,
  deploymentBody,
  fullSplit,
  isFullRollback,
  isTrafficSplit,
  parseDeployment,
  type TrafficSplit,
  type VersionShare,
} from './deploy-plan.ts'
import { cfOk } from './cf.ts'
import { extractJson } from './json.ts'
import { activeLog } from './log.ts'
import { errorMessage } from './proc.ts'

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

/**
 * Read the deployment, apply `split`, read it back, and record the change.
 * Returns null when the live deployment matches. Does not call cf when `split` is a refusal;
 * callers must pass a TrafficSplit, which an empty or unbalanced body cannot be.
 */
export async function applySplit(worker: string, message: string, split: TrafficSplit, secrets: readonly string[] = []): Promise<string | null> {
  const before = await readDeployment(worker, secrets)
  await putSplit(worker, message, split, secrets)
  const after = await readDeployment(worker, secrets)
  await activeLog()?.stateChange({ before: before.versions, after: after.versions, deploymentId: after.id })
  return assertSplit(after.versions, split)
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
export async function rollbackTo(worker: string, previous: string, secrets: readonly string[] = []): Promise<string | null> {
  const split = fullSplit(previous)
  if (!isTrafficSplit(split)) return `rollback refused: ${split.reason}`
  try {
    const mismatch = await applySplit(worker, `rollback ${previous}`, split, secrets)
    if (mismatch) return mismatch
    const versions = await readShares(worker, secrets)
    if (isFullRollback(versions, previous)) return null
    return `rollback did not land on ${previous} at 100%`
  } catch (error) {
    return `rollback to ${previous} failed: ${errorMessage(error)}`
  }
}
