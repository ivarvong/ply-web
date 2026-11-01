import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BASE_URL_DEFAULT,
  BUMP_BRANCH_DEFAULT,
  NAMESPACE_DEFAULT,
  RAMP_DWELL_MS,
  RAMP_PERCENTS,
  RAMP_PROBE_RPS,
  WORKER_DEFAULT,
  type RampSchedule,
} from './baseline.ts'
import { FAST_BURN, MIN_SAMPLES, QUANTILE_FLOOR, QUANTILE_P99_RATIO, SLOS } from './slo.ts'

export type CdConfig = {
  readonly worker: string
  readonly baseUrl: string
  readonly namespace: string
  readonly bumpBranch: string
  readonly runRoot: string
  readonly tokenFile: string
  readonly sha: string | null
  readonly schedule: RampSchedule
  readonly ledgerPath: string
}

const RETIRED = ['PLY_RAMP_MAX_HOLDS', 'PLY_RAMP_MIN_REQUESTS', 'PLY_RAMP_HOLD_MS'] as const

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer`)
  return Number(raw)
}

function numberEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${key} must be a non-negative number`)
  return Number(raw)
}

/** Comma-separated integers, strictly increasing, each in 1..100, ending at 100. */
export function parsePercents(raw: string): number[] {
  const parts = raw.split(',').map(part => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('PLY_RAMP_PERCENTS is empty')
  const nums = parts.map(part => {
    if (!/^\d+$/.test(part)) throw new Error(`PLY_RAMP_PERCENTS has ${part}`)
    return Number(part)
  })
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i] ?? 0
    if (n < 1 || n > 100) throw new Error(`PLY_RAMP_PERCENTS ${n} is outside 1..100`)
    if (i > 0 && n <= (nums[i - 1] ?? 0)) throw new Error('PLY_RAMP_PERCENTS must be strictly increasing')
  }
  if (nums[nums.length - 1] !== 100) throw new Error('PLY_RAMP_PERCENTS must end at 100')
  return nums
}

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
    schedule: config.schedule,
    fastBurn: FAST_BURN,
    minSamples: MIN_SAMPLES,
    quantileFloor: QUANTILE_FLOOR,
    quantileP99Ratio: QUANTILE_P99_RATIO,
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

export function loadConfig(env: NodeJS.ProcessEnv): CdConfig {
  for (const key of RETIRED) {
    if (env[key] !== undefined && env[key] !== '') {
      throw new Error(`${key} is no longer used; the ramp judges SLO burn`)
    }
  }
  const dwellMs = intEnv(env, 'PLY_RAMP_DWELL_MS', RAMP_DWELL_MS)
  if (dwellMs < 1) throw new Error('PLY_RAMP_DWELL_MS must be at least 1')
  return {
    worker: env.PLY_WORKER || WORKER_DEFAULT,
    baseUrl: (env.PLY_BASE_URL || BASE_URL_DEFAULT).replace(/\/+$/, ''),
    namespace: env.PLY_ARTIFACTS_NAMESPACE || NAMESPACE_DEFAULT,
    bumpBranch: env.PLY_BUMP_BRANCH || BUMP_BRANCH_DEFAULT,
    runRoot: env.PLY_CD_RUN_DIR || defaultRunRoot(),
    tokenFile: env.PLY_TOKEN_FILE || defaultTokenFile(),
    sha: env.PLY_SHA || null,
    ledgerPath: env.PLY_CD_LEDGER || defaultLedgerPath(),
    schedule: {
      percents: env.PLY_RAMP_PERCENTS ? parsePercents(env.PLY_RAMP_PERCENTS) : [...RAMP_PERCENTS],
      dwellMs,
      probeRps: numberEnv(env, 'PLY_RAMP_PROBE_RPS', RAMP_PROBE_RPS),
    },
  }
}
