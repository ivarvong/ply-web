// Flag config is one document. A rollout is an allocation in basis points, not a step list.
// Stepped ramps live in scripts/cd/cd.policy.json. This module does not import that file.

import type { AttributeName, AttributeValue, FlagKey, FlagSalt, UnitId } from './brand.ts';
import { BASIS_POINTS } from './ttl.ts';

export type EnvironmentName = 'production';

export type Variant =
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: AttributeValue }
  | { readonly kind: 'number'; readonly value: number };

export type Reason = 'override' | 'rule' | 'bucket' | 'default';

export type AttributeOp = 'eq' | 'neq' | 'in';

export type AttributeRule = {
  readonly attribute: AttributeName;
  readonly op: AttributeOp;
  readonly value: AttributeValue | readonly AttributeValue[];
  readonly variant: Variant;
};

/**
 * Traffic allocation for one flag. `ramping` is 1..9999 basis points, `complete` is 10000, `rolled-back` is 0.
 * Which of those values a release walks is the CD policy, not this type.
 */
export type Rollout =
  | { readonly kind: 'ramping'; readonly basisPoints: number }
  | { readonly kind: 'complete' }
  | { readonly kind: 'rolled-back'; readonly reason: string };

export type Flag = {
  readonly key: FlagKey;
  readonly salt: FlagSalt;
  readonly rollout: Rollout;
  readonly on: Variant;
  readonly off: Variant;
  readonly allow: readonly UnitId[];
  readonly deny: readonly UnitId[];
  readonly rules: readonly AttributeRule[];
};

export type FlagDocument = {
  readonly environment: EnvironmentName;
  readonly flags: readonly Flag[];
};

export const EMPTY_DOCUMENT: FlagDocument = { environment: 'production', flags: [] };

export type Targeting = {
  readonly allow: readonly UnitId[];
  readonly deny: readonly UnitId[];
  readonly rules: readonly AttributeRule[];
};

export type FlagEvaluation = {
  readonly key: FlagKey;
  readonly variant: Variant;
  readonly reason: Reason;
  readonly bucket: number;
};

export type Unit = {
  readonly id: UnitId;
  readonly attributes: Readonly<Record<AttributeName, AttributeValue>>;
};

/** Which flags an evaluation walks. Omitted keys at the HTTP boundary become `all`. */
export type FlagSelection =
  | { readonly kind: 'all' }
  | { readonly kind: 'listed'; readonly keys: readonly FlagKey[] };

/**
 * `CF-Cache-Status` tokens documented by the Cache API.
 * https://developers.cloudflare.com/cache/concepts/cache-responses/
 * Workers Cache reports the same set.
 * `NONE` and `UNKNOWN` are the two tokens of the documented NONE/UNKNOWN status.
 */
export const CACHE_STATUSES = [
  'HIT',
  'MISS',
  'EXPIRED',
  'STALE',
  'BYPASS',
  'REVALIDATED',
  'UPDATING',
  'DYNAMIC',
  'NONE',
  'UNKNOWN',
] as const;

export type CacheStatus = (typeof CACHE_STATUSES)[number];

export type ParsedCacheStatus =
  | { readonly kind: 'known'; readonly status: CacheStatus }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unrecognized'; readonly value: string };

/** A header or JSON field. Absence is a missing token. Anything outside {@link CACHE_STATUSES} stays unrecognized. */
export function parseCacheStatus(value: string | null): ParsedCacheStatus {
  if (value === null || value.length === 0) return { kind: 'absent' };
  switch (value) {
    case 'HIT':
    case 'MISS':
    case 'EXPIRED':
    case 'STALE':
    case 'BYPASS':
    case 'REVALIDATED':
    case 'UPDATING':
    case 'DYNAMIC':
    case 'NONE':
    case 'UNKNOWN':
      return { kind: 'known', status: value };
    default:
      return { kind: 'unrecognized', value };
  }
}

export type Invalid = { readonly kind: 'invalid'; readonly reason: string };

export type WriteResult =
  | { readonly kind: 'ok'; readonly revision: string; readonly config: FlagDocument; readonly unchanged: boolean; readonly invalidated: boolean }
  | { readonly kind: 'conflict'; readonly expected: string; readonly actual: string | null }
  | { readonly kind: 'invalid'; readonly reason: string; readonly revision: string | null }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type ReadResult =
  | { readonly kind: 'ok'; readonly revision: string; readonly config: FlagDocument }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly reason: string; readonly revision: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type DiffEntry =
  | { readonly op: 'create'; readonly key: string; readonly after: { readonly rollout: Rollout; readonly allow: readonly string[]; readonly deny: readonly string[] } }
  | { readonly op: 'rollout'; readonly key: string; readonly before: Rollout; readonly after: Rollout }
  | { readonly op: 'targeting'; readonly key: string; readonly before: Targeting; readonly after: Targeting };

/** Basis points in force: 0 when rolled back, 10000 when complete, otherwise the ramping allocation. */
export function basisPointsOf(rollout: Rollout): number {
  if (rollout.kind === 'rolled-back') return 0;
  if (rollout.kind === 'complete') return BASIS_POINTS;
  return rollout.basisPoints;
}

export function variantKind(variant: Variant): Variant['kind'] {
  return variant.kind;
}

export function variantValue(variant: Variant): string {
  if (variant.kind === 'boolean') return variant.value ? 'true' : 'false';
  if (variant.kind === 'number') return String(variant.value);
  return variant.value;
}

export function isEnabledVariant(variant: Variant): boolean {
  return variant.kind === 'boolean' && variant.value;
}
