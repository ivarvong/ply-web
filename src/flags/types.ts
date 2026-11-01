// Flag config is one document. A rollout is the CD ramp: a strictly increasing percent schedule and a step index.
// scripts/cd is not imported here. test/flags/eval.test.ts locks these values to RAMP_PERCENTS.

export const ROLLOUT_PERCENTS = [1, 5, 10, 25, 50, 75, 100] as const;

export type EnvironmentName = 'production';

export type Variant =
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number };

export type Reason = 'override' | 'rule' | 'bucket' | 'default';

export type AttributeOp = 'eq' | 'neq' | 'in';

export type AttributeRule = {
  readonly attribute: string;
  readonly op: AttributeOp;
  readonly value: string | readonly string[];
  readonly variant: Variant;
};

/** Same shape as the CD ramp state, without the harness-fault arm (that stays in the CD runner). */
export type Rollout =
  | { readonly kind: 'ramping'; readonly step: number; readonly percents: readonly number[] }
  | { readonly kind: 'complete'; readonly percents: readonly number[] }
  | { readonly kind: 'rolled-back'; readonly reason: string; readonly percents: readonly number[] };

export type Flag = {
  readonly key: string;
  readonly salt: string;
  readonly rollout: Rollout;
  readonly on: Variant;
  readonly off: Variant;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly rules: readonly AttributeRule[];
};

export type FlagDocument = {
  readonly environment: EnvironmentName;
  readonly flags: readonly Flag[];
};

export const EMPTY_DOCUMENT: FlagDocument = { environment: 'production', flags: [] };

export type Targeting = {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly rules: readonly AttributeRule[];
};

export type FlagEvaluation = {
  readonly key: string;
  readonly variant: Variant;
  readonly reason: Reason;
  readonly bucket: number;
};

export type Unit = {
  readonly id: string;
  readonly attributes: Readonly<Record<string, string>>;
};

export type CacheStatus = 'HIT' | 'MISS' | 'UPDATING' | 'REVALIDATED' | 'EXPIRED' | 'STALE' | 'BYPASS' | 'NONE';

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

export function percentOf(rollout: Rollout): number {
  if (rollout.kind === 'rolled-back') return 0;
  if (rollout.kind === 'complete') return 100;
  const percent = rollout.percents[rollout.step];
  return typeof percent === 'number' ? percent : 0;
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
