// The thresholds in force: the checked-in rollout policy and ply-web's limits, keyed as scripts/calibrate/thresholds.json
// keys them. The one place that reads the files; scripts/calibrate/provenance.ts stays pure.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { API_CAPS, MIRROR_CAPS, VERIFY_CAPS } from '../../src/limits.ts'
import { VIEWER_CAPS } from '../../src/viewer/limits.ts'
import { DEFAULT_POLICY_PATH } from '../cd/policy.ts'
import { capThresholds, policyThresholds, readRegistry, type Problem, type Registry } from './provenance.ts'

export const REGISTRY_PATH = fileURLToPath(new URL('./thresholds.json', import.meta.url))

/** Every threshold by registry key. `policyPath` defaults to scripts/cd/cd.policy.json. */
export function currentThresholds(policyPath: string = DEFAULT_POLICY_PATH): Map<string, number> {
  const out = policyThresholds(JSON.parse(readFileSync(policyPath, 'utf8')) as unknown)
  for (const [source, caps] of [['api', API_CAPS], ['mirror', MIRROR_CAPS], ['verify', VERIFY_CAPS], ['viewer', VIEWER_CAPS]] as const) {
    for (const [key, value] of capThresholds(source, caps)) out.set(key, value)
  }
  return out
}

export function loadRegistry(path: string = REGISTRY_PATH): { readonly registry: Registry; readonly problems: readonly Problem[] } {
  return readRegistry(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}
