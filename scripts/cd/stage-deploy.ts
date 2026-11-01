import { MESSAGE_MAX, PIN_ATTEMPTS, PIN_CONFIRMATIONS, PIN_INTERVAL_MS } from './baseline.ts'
import { cfOk, ROOT } from './cf.ts'
import { isTrafficSplit, planCanary, trafficSplit, versionByTag } from './deploy-plan.ts'
import { extractJson } from './json.ts'
import { activeLog } from './log.ts'
import { originMainReason, requireOriginMain } from './preflight.ts'
import { errorMessage } from './proc.ts'
import { checkoutReason, readCheckout, releaseTag, type ReleaseId } from './release.ts'
import { fail, pass, type StageResult } from './result.ts'
import type { CdConfig } from './config.ts'
import { applySplit, readShares, rollbackTo } from './traffic.ts'

const CANARY_PREFIX = 'cd canary '

export type DeployValue = {
  readonly version: string
  readonly previous: string
  readonly dropped: string | null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function pinReady(config: CdConfig, version: string): Promise<boolean> {
  let streak = 0
  for (let attempt = 0; attempt < PIN_ATTEMPTS && streak < PIN_CONFIRMATIONS; attempt++) {
    const response = await fetch(`${config.baseUrl}/`, {
      headers: { 'Cloudflare-Workers-Version-Overrides': `${config.worker}="${version}"` },
    })
    streak = response.headers.get('x-ply-version') === version ? streak + 1 : 0
    if (streak < PIN_CONFIRMATIONS) await sleep(PIN_INTERVAL_MS)
  }
  return streak >= PIN_CONFIRMATIONS
}

async function versionTagged(worker: string, tag: string): Promise<string | null> {
  const listed = await cfOk(['workers', 'versions', 'list', '--worker-id', worker, '--page', '1', '--per-page', '100'])
  let payload: unknown = listed
  try {
    payload = extractJson(listed)
  } catch {
    payload = listed
  }
  const found = versionByTag(payload, tag)
  return found.ok ? found.versionId : null
}

function canaryMessage(tag: string): string {
  const message = `${CANARY_PREFIX}${tag}`
  if (message.length > MESSAGE_MAX) throw new Error('canary message exceeds workers/message')
  return message
}

export async function stageDeploy(config: CdConfig, release: ReleaseId): Promise<StageResult<DeployValue>> {
  const mainRef = await requireOriginMain(ROOT)
  if (!mainRef.ok) {
    const reason = originMainReason(mainRef)
    const context = mainRef.kind === 'not-on-origin-main'
      ? { kind: mainRef.kind, head: mainRef.head, main: mainRef.main }
      : { kind: mainRef.kind, reason: mainRef.reason }
    await activeLog()?.error(reason, context)
    return fail('deploy-canary', reason, false, 'harness_fault')
  }
  const checkout = await readCheckout(ROOT)
  if (!checkout.ok) return fail('deploy-canary', checkoutReason(checkout), false, 'harness_fault')
  if (checkout.web !== release.web) {
    return fail('deploy-canary', `checkout-unavailable: HEAD ${checkout.web} is not the release ply-web sha`, false, 'harness_fault')
  }
  const resolved = releaseTag(release)
  try {
    let version = await versionTagged(config.worker, resolved)
    if (!version) {
      await cfOk(['build', '--mode', 'production'])
      await cfOk([
        'workers', 'versions', 'create', '--prebuilt', '--mode', 'production',
        '--worker', config.worker, '--tag', resolved, '--message', canaryMessage(resolved),
      ])
      version = await versionTagged(config.worker, resolved)
    }
    if (!version) return fail('deploy-canary', `version-not-found: no version tagged ${resolved}`, false, 'harness_fault')
    const shares = await readShares(config.worker)
    const plan = planCanary(shares, version)
    if (plan.kind === 'refuse') return fail('deploy-canary', plan.reason, false, 'harness_fault')
    const want = trafficSplit(0, version, plan.live)
    if (!isTrafficSplit(want)) return fail('deploy-canary', `${want.reason}; traffic was not changed`, false, 'harness_fault')
    const applied = await applySplit(config.worker, canaryMessage(resolved), want, shares, { kind: 'canary' })
    if (!applied.ok && applied.kind === 'state_conflict') return fail('deploy-canary', applied.reason, false, 'state_conflict')
    if (!applied.ok) {
      const seen = await readShares(config.worker)
      const rolled = await rollbackTo(config.worker, plan.live, seen)
      const rollbackError = rolled.ok ? null : rolled.reason
      return fail('deploy-canary', rollbackError ? `${applied.reason}; ${rollbackError}` : applied.reason, rollbackError === null)
    }
    const pinned = await pinReady(config, version)
    if (!pinned) return fail('deploy-canary', `pinned requests were not answered by ${version}; left the 0% canary in place`)
    return pass('deploy-canary', { version, previous: plan.live, dropped: plan.dropped })
  } catch (error) {
    return fail('deploy-canary', errorMessage(error), false, 'harness_fault')
  }
}
