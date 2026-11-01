import type { VersionShare } from './deploy-plan.ts'
import { errorMessage } from './proc.ts'
import { fail, pass, type StageResult } from './result.ts'
import type { CdConfig } from './config.ts'
import { readShares, rollbackTo } from './traffic.ts'
import { HarnessFault } from './traffic-gate.ts'

export async function stageRollback(
  config: CdConfig,
  version: string,
  expected?: readonly VersionShare[],
): Promise<StageResult<{ readonly version: string }>> {
  try {
    const prior = expected ?? await readShares(config.worker)
    const applied = await rollbackTo(config.worker, version, prior)
    if (!applied.ok && applied.kind === 'state_conflict') return fail('rollback', applied.reason, false, 'state_conflict')
    if (!applied.ok) return fail('rollback', applied.reason)
    return pass('rollback', { version })
  } catch (error) {
    if (error instanceof HarnessFault) return fail('rollback', error.message, false, 'harness_fault')
    return fail('rollback', errorMessage(error))
  }
}
