// Thresholds that are not rollout policy. The ramp schedule, ingest wait, probe mix,
// and which signals are hard live in cd.policy.json. Edit that file, or pass --policy.

export const WORKER_DEFAULT = 'ply'
export const BASE_URL_DEFAULT = 'https://ply.ivar.workers.dev'
export const NAMESPACE_DEFAULT = 'ply-loadgen'
export const BUMP_BRANCH_DEFAULT = 'bump-ply'
export const REPO_PREFIX = 'ply-web-cd-'
/** How long a candidate Node binary may take to print its version during preflight. */
export const NODE_PROBE_MS = 5_000

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

/**
 * A span join that covers less than this share of the invocations the worker logged,
 * compared with the smoke requests, is the harness. Half is well under the ingest-loss
 * allowance, so a healthy loss still passes the gate.
 */
export const JOIN_MIN_SHARE = 0.5

/** The share check starts at this many logged invocations, the floor of the loss allowance. */
export const JOIN_MIN_LOGGED = 2

/** A cf-ray is 16 hex digits, a hyphen, and a colo. A span `rayId` may omit the colo. */
export const CF_RAY_HEX_LENGTH = 16

/** Artifacts answers a revoked bearer with 403. */
export const REVOKED_STATUS = 403

/** How long the post-revoke Artifacts call may take. A dead token answers well inside this. */
export const REVOKE_PROBE_MS = 15_000

export const MESSAGE_MAX = 100

export type LatencyCeiling = {
  readonly p50Ms: number
  readonly p99Ms: number
}

/**
 * Ceilings for the pinned smoke and the post-promote smoke. These are the first stored
 * baseline (2026-10-31): a tiny Artifacts repo, cold isolates included. Tighten them after
 * a few real runs. A sample over the ceiling fails telemetry only when the rollout
 * policy's latency mode is `gate`. `informational` and `off` record the percentiles.
 */
export const SMOKE_LATENCY = {
  cpuMs: { p50Ms: 250, p99Ms: 3_000 },
  wallMs: { p50Ms: 4_000, p99Ms: 25_000 },
  fetchMs: { p50Ms: 2_000, p99Ms: 15_000 },
} as const satisfies Record<string, LatencyCeiling>

