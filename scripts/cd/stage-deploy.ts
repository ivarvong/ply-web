import { PIN_ATTEMPTS, PIN_CONFIRMATIONS, PIN_INTERVAL_MS } from './baseline.ts'
import { cfOk, ROOT } from './cf.ts'
import { isTrafficSplit, parseVersionId, planCanary, trafficSplit } from './deploy-plan.ts'
import { errorMessage, run } from './proc.ts'
import { fail, pass, type StageResult } from './result.ts'
import type { CdConfig } from './config.ts'
import { applySplit, readShares, rollbackTo } from './traffic.ts'

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

export async function stageDeploy(config: CdConfig): Promise<StageResult<DeployValue>> {
  const status = await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT })
  if (status.code !== 0) return fail('deploy-canary', `git status failed: ${status.stderr.slice(0, 300)}`)
  if (status.stdout.trim()) return fail('deploy-canary', 'tracked files are modified; deploy a commit')
  const sha = await run('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT })
  if (sha.code !== 0) return fail('deploy-canary', 'git rev-parse failed')
  const tag = sha.stdout.trim()
  try {
    await cfOk(['build', '--mode', 'production'])
    const uploaded = await cfOk([
      'workers', 'versions', 'create', '--prebuilt', '--mode', 'production',
      '--worker', config.worker, '--tag', tag, '--message', `cd canary ${tag}`.slice(0, 100),
    ])
    const version = parseVersionId(uploaded)
    if (!version) return fail('deploy-canary', 'upload did not print a version id')
    const plan = planCanary(await readShares(config.worker), version)
    if (plan.kind === 'refuse') return fail('deploy-canary', plan.reason)
    const want = trafficSplit(0, version, plan.live)
    if (!isTrafficSplit(want)) return fail('deploy-canary', `${want.reason}; traffic was not changed`)
    const mismatch = await applySplit(config.worker, `canary ${tag}`, want)
    if (mismatch) {
      const rollbackError = await rollbackTo(config.worker, plan.live)
      return fail('deploy-canary', rollbackError ? `${mismatch}; ${rollbackError}` : mismatch, rollbackError === null)
    }
    const pinned = await pinReady(config, version)
    if (!pinned) return fail('deploy-canary', `pinned requests were not answered by ${version}; left the 0% canary in place`)
    return pass('deploy-canary', { version, previous: plan.live, dropped: plan.dropped })
  } catch (error) {
    return fail('deploy-canary', errorMessage(error))
  }
}
