import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  BASE_URL_DEFAULT,
  BUMP_BRANCH_DEFAULT,
  NAMESPACE_DEFAULT,
  WORKER_DEFAULT,
} from './baseline.ts'
import type { Json } from './log.ts'
import { DEFAULT_POLICY_PATH, loadPolicy, type RolloutPolicy } from './policy.ts'
import { SLOS } from './slo.ts'

export type CdConfig = {
  readonly worker: string
  readonly baseUrl: string
  readonly namespace: string
  readonly bumpBranch: string
  readonly runRoot: string
  readonly tokenFile: string
  readonly sha: string | null
  readonly policy: RolloutPolicy
  readonly policyPath: string
  readonly policySha256: string
  readonly policyBody: Json
  readonly ledgerPath: string
}

const RETIRED = [
  'PLY_RAMP_MAX_HOLDS',
  'PLY_RAMP_MIN_REQUESTS',
  'PLY_RAMP_HOLD_MS',
  'PLY_RAMP_PERCENTS',
  'PLY_RAMP_DWELL_MS',
  'PLY_RAMP_PROBE_RPS',
] as const

/** ISO-8601, epoch milliseconds, or epoch seconds (a value under 1e12). */
export function parseSince(raw: string): number {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    return n < 1e12 ? n * 1000 : n
  }
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) throw new Error('since is not a timestamp')
  return parsed
}

export function defaultLedgerPath(): string {
  return join(homedir(), '.local', 'state', 'ply-cd', 'ledger.jsonl')
}

/** Scratch run directories. Override with `PLY_CD_RUN_DIR`. */
export function defaultRunRoot(): string {
  return join(homedir(), '.local', 'state', 'ply-cd', 'runs')
}

/** Worker bearer, mode 0600. Override with `PLY_TOKEN_FILE`. The file is read and never printed. */
export function defaultTokenFile(): string {
  return join(homedir(), '.ply-token')
}

/** What run_started records. Paths only; never a token. */
export function publicConfig(config: CdConfig) {
  return {
    worker: config.worker,
    baseUrl: config.baseUrl,
    namespace: config.namespace,
    bumpBranch: config.bumpBranch,
    runRoot: config.runRoot,
    tokenFile: config.tokenFile,
    sha: config.sha,
    ledgerPath: config.ledgerPath,
    policyPath: config.policyPath,
    policySha256: config.policySha256,
    slos: SLOS.map(slo => ({
      id: slo.id,
      statement: slo.statement,
      target: slo.target,
      windowDays: slo.windowDays,
      initial: slo.initial,
      ceilingMs: slo.ceilingMs,
    })),
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, policyPath?: string): CdConfig {
  for (const key of RETIRED) {
    if (env[key] !== undefined && env[key] !== '') {
      throw new Error(`${key} is no longer used; put it in the rollout policy (--policy)`)
    }
  }
  const path = policyPath ? resolve(policyPath) : DEFAULT_POLICY_PATH
  const loaded = loadPolicy(path)
  return {
    worker: env.PLY_WORKER || WORKER_DEFAULT,
    baseUrl: (env.PLY_BASE_URL || BASE_URL_DEFAULT).replace(/\/+$/, ''),
    namespace: env.PLY_ARTIFACTS_NAMESPACE || NAMESPACE_DEFAULT,
    bumpBranch: env.PLY_BUMP_BRANCH || BUMP_BRANCH_DEFAULT,
    runRoot: env.PLY_CD_RUN_DIR || defaultRunRoot(),
    tokenFile: env.PLY_TOKEN_FILE || defaultTokenFile(),
    sha: env.PLY_SHA || null,
    ledgerPath: env.PLY_CD_LEDGER || defaultLedgerPath(),
    policy: loaded.policy,
    policyPath: path,
    policySha256: loaded.sha256,
    policyBody: loaded.body,
  }
}
