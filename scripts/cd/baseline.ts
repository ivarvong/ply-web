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
export const REVOKE_ATTEMPTS = 5
export const REVOKE_WAIT_MS = 1_000

/**
 * Route confirmation (route-confirm.ts): after a split write, requests must come back from the wanted version on fresh
 * connections, every one of them, for PIN_SUSTAIN_MS. Used for the pinned canary (version override) and for the
 * unpinned 100% split before the live smoke.
 *
 * source: run 2026-11-10T20-48-18-470Z (c8403e57 at 0% beside 480225db, written 15:49:10.6 EST). The old check (5
 * sequential requests on one keep-alive connection, 1 s apart) passed; a pinned smoke row 9.9 s after the write
 * (flags-rules, ray a587ec564e0da476-IAD) was answered by 480225db, between two rows answered by c8403e57. Cloudflare
 * applies an override only where the edge already has the deployment ("up to a couple of seconds" per the docs); a
 * request that lands on a machine without it is routed by the split, which is 100% old. Every earlier run's pinned rows
 * (19 runs, 2026-11-08T15-39-56-033Z through 2026-11-10T14-56-52-021Z, ~1,000 rows from +8.3 s after the write) and
 * every unpinned request after a 100% write (22,492 requests from +0.9 s, 10 runs) came from the wanted version.
 * date: 2026-11-10. n: 1 straggler in ~1,000 pinned rows; 0 in 22,492 unpinned.
 * prediction (2026-11-10): stragglers end within 15 s of a split write. With 10 fresh connections a second and 10 s
 * sustained, confirmation ends 11-25 s after the write on >= 100 samples, and a run's smoke sees 0 wrong-version rows.
 * Any that do occur are re-issued (SMOKE_REISSUE_*) and logged as routing events, never counted as a pass. Re-check the
 * offsets each route-confirm observation records after 5 runs.
 */
export const PIN_BATCH = 10
export const PIN_INTERVAL_MS = 1_000
export const PIN_SUSTAIN_MS = 10_000
/** Give up (a routing harness fault, traffic unchanged) when no sustained window has formed by then. PRIOR: 8x the predicted 15 s. */
export const PIN_MAX_MS = 120_000
/** One confirmation request. PRIOR: the probe timeout (cd.policy.json probe.timeoutMs). */
export const PIN_REQUEST_MS = 2_000

/**
 * A smoke row answered by the wrong version, or lost (status 0) while the client stalled, is re-issued after a wait,
 * at most this many times. Only a GET is re-issued; a write that reached the wrong version (or may have landed during a
 * stall) restarts the lifecycle on a fresh scratch repo after a new route confirmation, at most SMOKE_RESTARTS times.
 * PRIOR (2026-11-10): 3 x 2 s covers the one observed straggler window (9.9 s after the write, smoke 0.2 s behind it)
 * once confirmation has passed; exhausting them is a routing or client harness fault, prod untouched.
 */
export const SMOKE_REISSUE_ATTEMPTS = 3
export const SMOKE_REISSUE_WAIT_MS = 2_000
export const SMOKE_RESTARTS = 2

/**
 * Client stall detection (client-health.ts). The monitor ticks every CLIENT_TICK_MS; a gap in the wall or monotonic
 * clock above CLIENT_STALL_MS is a client stall.
 * source: runs 2026-11-08T17-24-32-774Z through 2026-11-10T20-54-06-051Z (6 ramps, 627 s of probe dwell at 50 req/s):
 * 0 gaps over 500 ms between logged probes on a healthy client. Two stalls observed: 69,830 ms (run
 * 2026-11-01T19-40-35-485Z, both versions answered together at the end) and 53,733 ms (run 2026-11-10T20-54-06-051Z,
 * 16:00:07.8 to 16:01:01.6 EST: no event written, 58 of ~2,000 probes issued, the last 5 timed out client-side; dmesg
 * "crng reseeded due to virtual machine fork" and virtio_balloon "Out of puff" at the same time; server telemetry for the
 * window all outcome ok, none over 3 s). The box logged 69 VM forks in the 38 h before 2026-11-10 16:13, about one per
 * 33 min, so a ~6 min ramp meets one about 1 run in 6.
 * date: 2026-11-10. n: 627 s healthy, 2 stalls.
 * prediction (2026-11-10): 0 false stalls on a healthy run (CLIENT_STALL_MS is 2x the largest healthy gap bound and 10x
 * the tick). PRIOR tick.
 */
export const CLIENT_TICK_MS = 100
export const CLIENT_STALL_MS = 1_000
/**
 * How far a ramp step may run past its dwell to replace the time the client spent stalled and reach probe.minSamples
 * real samples. Past it, the step ends as `harness_unhealthy`, and its traffic is settled through `probe.onHarnessFault` (ply-web#145).
 * source: the two stalls above (53.7 s, 69.8 s) plus 1,000 samples at 50 req/s (20 s).
 * prediction (2026-11-10): a single VM pause (<= 70 s observed) recovers inside 120 s; harness_unhealthy needs stalls
 * totalling over ~100 s in one step, which no run so far has had.
 */
export const CLIENT_MAX_EXTENSION_MS = 120_000

/** One Worker HTTP call. A tiny repo finishes well under this; the paid CPU ceiling is 5 minutes. */
export const SMOKE_HTTP_MS = 120_000

export const TELEMETRY_PAGE = 1_000
export const TELEMETRY_CHUNK = 50
export const TELEMETRY_MAX_PAGES = 50
/** Ingest lag observed on 2026-10-31 was 10–30s. Wait this long before calling a missing id lost. */
export const TELEMETRY_WAIT_MS = 60_000
/** Re-query periods while smoke ids are missing. Ingest typically lands in 5–15 s, so poll tight then back off. */
export const TELEMETRY_POLLS_MS = [3_000, 3_000, 3_000, 5_000, 5_000, 10_000] as const
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

/** `workers/tag` on a version upload. The API rejects a longer tag. */
export const VERSION_TAG_MAX = 100

/** A full git object id, the only sha a release will carry. */
export const GIT_SHA_HEX = 40

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

