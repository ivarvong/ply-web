// Named TTLs for the one cached ruleset. cloudflare.config.ts publishes the same numbers as text bindings.
import { parseFlagKey, parseFlagSalt, type FlagKey, type FlagSalt } from './brand.ts';

function knownFlagKey(raw: string): FlagKey {
  const parsed = parseFlagKey(raw);
  if (parsed.kind === 'key') return parsed.value;
  throw new Error(parsed.reason);
}

function knownFlagSalt(raw: string): FlagSalt {
  const parsed = parseFlagSalt(raw);
  if (parsed.kind === 'salt') return parsed.value;
  throw new Error(parsed.reason);
}

// max-age is the fresh window. stale-while-revalidate is how long a failed revalidation may still be served.
// Neither value is an s-maxage, and the response must not say must-revalidate: those directives
// disable stale-while-revalidate. An absent ruleset uses this same header. no-store is a bypass.

export const FLAGS_MAX_AGE_S = 5;
export const FLAGS_SWR_S = 60;
/** One tag for the one cached ruleset. Invalidation is this tag, from the FlagsCache entrypoint. */
export const FLAGS_CACHE_TAG = 'flags';
/** The only R2 object. Its ETag is the revision. History is the write log, not more objects. */
export const FLAGS_OBJECT_KEY = 'flags/config.json';
export const FLAGS_CACHE_PATH = '/config';
export const FLAGS_CACHE_URL = 'https://flags.internal/config';

/** 10_000 buckets. One basis point is one bucket, so an allocation needs no rounding. */
export const BUCKETS = 10_000;
/** Inclusive top of a rollout: 10_000 basis points is 100% of units. */
export const BASIS_POINTS = BUCKETS;

/** Salt assigned when setRollout creates a flag. Changing it would rebucket everyone, so it stays put. */
export const DEFAULT_SALT: FlagSalt = knownFlagSalt('v1');

/**
 * The example gate on GET /. Off unless this flag's variant is boolean true.
 * Missing config, a missing flag, and percent 0 all leave the usage text unchanged.
 */
export const USAGE_NOTE_FLAG: FlagKey = knownFlagKey('ply.usage.note');

/** The one line GET / appends when ply.usage.note resolves to boolean true. Off leaves GET / unchanged. */
export const USAGE_NOTE_LINE = 'ply.usage.note is on for this unit.';

export const MAX_FLAGS = 64;
export const MAX_RULES = 16;
export const MAX_UNITS = 128;
export const MAX_ATTRIBUTES = 32;
export const MAX_DOCUMENT_BYTES = 64 * 1024;

/** Expected revision for the first create. The conditional put uses If-None-Match: *. */
export const ABSENT_REVISION = '';

export function cacheControl(maxAgeS: number, swrS: number): string {
  return `public, max-age=${maxAgeS}, stale-while-revalidate=${swrS}`;
}

export function ttlFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9]\d{0,6}$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
}
