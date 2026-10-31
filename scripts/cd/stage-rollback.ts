import { errorMessage } from './proc.ts'
import { fail, pass, type StageResult } from './result.ts'
import type { CdConfig } from './config.ts'
import { rollbackTo } from './traffic.ts'

export async function stageRollback(config: CdConfig, version: string): Promise<StageResult<{ readonly version: string }>> {
  try {
    const rollbackError = await rollbackTo(config.worker, version)
    if (rollbackError) return fail('rollback', rollbackError)
    return pass('rollback', { version })
  } catch (error) {
    return fail('rollback', errorMessage(error))
  }
}
