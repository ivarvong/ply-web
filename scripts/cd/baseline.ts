// Every threshold and dwell the operator pipeline uses. The decision functions take these
// values as arguments; they do not embed numbers of their own. Edit this file to change a gate.
// A clean ramp is RAMP_PERCENTS.length * RAMP_DWELL_MS = 7 * 40s = 280s, plus the queries.

export const WORKER_DEFAULT = 'ply'
export const BASE_URL_DEFAULT = 'https://ply.ivar.workers.dev'
export const NAMESPACE_DEFAULT = 'ply-loadgen'
export const BUMP_BRANCH_DEFAULT = 'bump-ply'
export const RUN_ROOT_DEFAULT = 'cd-runs'
export const REPO_PREFIX = 'ply-web-cd-'

/** Write-token lifetime for the scratch repo. The smoke must finish inside this window. */
export const TOKEN_TTL_SECONDS = 600
/** Scratch repos older than this are deleted at the start of the next smoke. */
export const STALE_REPO_MS = 3_600_000
export const REVOKE_ATTEMPTS = 5
export const REVOKE_WAIT_MS = 1_000

/** Pinned requests must come back as the new version this many times in a row. */
export const PIN_CONFIRMATIONS = 5
export const PIN_ATTEMPTS = 60
export const PIN_INTERVAL_MS = 1_000

/** One Worker HTTP call. A tiny repo finishes well under this; the paid CPU ceiling is 5 minutes. */
export const SMOKE_HTTP_MS = 120_000

export const TELEMETRY_PAGE = 1_000
export const TELEMETRY_CHUNK = 50
export const TELEMETRY_MAX_PAGES = 50
/** Ingest lag observed on 2026-10-31 was 10–30s. Wait this long before calling a missing id lost. */
export const TELEMETRY_WAIT_MS = 60_000
export const TELEMETRY_POLLS_MS = [5_000, 10_000, 15_000] as const
/** `to` is now plus this, matching scripts/canary-o11y.mjs, so the last events are inside the window. */
export const QUERY_SLACK_MS = 60_000

export const MESSAGE_MAX = 100

export type LatencyCeiling = {
  readonly p50Ms: number
  readonly p99Ms: number
}

/**
 * Ceilings for the pinned smoke and the post-promote smoke. These are the first stored
 * baseline (2026-10-31): a tiny Artifacts repo, cold isolates included. Tighten them after
 * a few real runs; a sample over the ceiling fails the gate.
 */
export const SMOKE_LATENCY = {
  cpuMs: { p50Ms: 250, p99Ms: 3_000 },
  wallMs: { p50Ms: 4_000, p99Ms: 25_000 },
  fetchMs: { p50Ms: 2_000, p99Ms: 15_000 },
} as const satisfies Record<string, LatencyCeiling>

/** Traffic percentages in order. The last step is 100, which drops the previous version. */
export const RAMP_PERCENTS = [1, 5, 10, 25, 50, 75, 100] as const

export const RAMP_DWELL_MS = 40_000
/** Probes per second during a dwell: GET / and one authenticated /v1 read. 0 dwells without probing. */
export const RAMP_PROBE_RPS = 2

export type RampSchedule = {
  readonly percents: readonly number[]
  readonly dwellMs: number
  readonly probeRps: number
}

export function defaultSchedule(): RampSchedule {
  return {
    percents: [...RAMP_PERCENTS],
    dwellMs: RAMP_DWELL_MS,
    probeRps: RAMP_PROBE_RPS,
  }
}
