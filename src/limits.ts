// ply limits ply-web sets: the /v1 API (src/index.js), the mirror cron (src/mirror.ts), and GitCache's pack
// verification (src/gitcache.ts). The viewer's caps are src/viewer/limits.ts. Every number in these objects has a
// provenance entry in scripts/calibrate/thresholds.json (a cited distribution, or `PRIOR (uncalibrated)`);
// test/calibrate-provenance.test.ts fails on a cap without one, and on an entry whose value no longer matches.
//
// API_CAPS:
// A Worker isolate has 128 MiB. A buffered pack holds the wire bytes and every inflated object,
// including delta results resolvePack allocates on top of the instructions (ply #9). Four
// maximum-sized objects cover a merge-base triple plus the commit that names them, and
// wire + inflated stays under the isolate. The blob itself is streamed and is not in this total.
import { withLimits } from 'ply'

const KIB = 1024
const MIB = KIB * KIB
const API_INFLATED_OBJECTS = 4

export const API_CAPS = Object.freeze({
  maxObjectSize: 16 * MIB,
  maxPackBytes: 32 * MIB,
  maxHarvestBytes: 16 * MIB,
  maxInflatedTotal: 16 * MIB * API_INFLATED_OBJECTS,
  // ply's buffered-pack object ceiling. The inflated-byte cap above is the memory bound.
  maxPackObjects: 100_000,
  // One ref listing is buffered, so it shares the pack byte cap.
  maxLsRefsBytes: 32 * MIB,
  requestTimeoutMs: 30_000,
  /** A JSON request body (src/index.js readJson). */
  maxBodyBytes: MIB,
})

export const API_LIMITS = withLimits({
  maxPackBytes: API_CAPS.maxPackBytes,
  maxObjectSize: API_CAPS.maxObjectSize,
  maxHarvestBytes: API_CAPS.maxHarvestBytes,
  maxInflatedTotal: API_CAPS.maxInflatedTotal,
  maxPackObjects: API_CAPS.maxPackObjects,
  maxLsRefsBytes: API_CAPS.maxLsRefsBytes,
  requestTimeoutMs: API_CAPS.requestTimeoutMs,
})

/**
 * The mirror cron (src/mirror.ts). An update larger than maxPackBytes is refused and logged; publish it with
 * scripts/publish.mjs instead.
 */
export const MIRROR_CAPS = Object.freeze({
  maxPackBytes: 32 * MIB,
  maxObjectSize: 16 * MIB,
  maxInflatedTotal: 96 * MIB,
  maxHarvestBytes: 16 * MIB,
  maxPackObjects: 50_000,
  requestTimeoutMs: 30_000,
})

export const MIRROR_LIMITS = withLimits(MIRROR_CAPS)

/** A pack is stored only after GitCache has verified it, and it buffers the pack to do so; bigger ones pass through unstored. */
export const VERIFY_CAPS = Object.freeze({
  maxPackBytes: 16 * MIB,
  maxObjectSize: 16 * MIB,
  maxInflatedTotal: 4 * 16 * MIB,
  maxHarvestBytes: 16 * MIB,
  maxPackObjects: 100_000,
  maxTreeEntries: 1_000_000,
  requestTimeoutMs: 30_000,
})

export const VERIFY_LIMITS = withLimits(VERIFY_CAPS)
