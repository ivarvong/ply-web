// Pure evaluation. Order is deny, allow, attribute rules, percentage bucket, then the off variant.
// Deny wins over allow so a unit on both lists stays off while the percent grows.
import { bucketOf, inBucket } from './hash.ts';
import { DEFAULT_SALT } from './ttl.ts';
import { percentOf, type Flag, type FlagDocument, type FlagEvaluation, type Unit, type Variant } from './types.ts';

const MISSING_OFF: Variant = { kind: 'boolean', value: false };

function matches(rule: Flag['rules'][number], attributes: Readonly<Record<string, string>>): boolean {
  const actual = attributes[rule.attribute];
  if (actual === undefined) return false;
  if (rule.op === 'eq') return actual === rule.value;
  if (rule.op === 'neq') return actual !== rule.value;
  return Array.isArray(rule.value) && rule.value.includes(actual);
}

export function evaluateFlag(flag: Flag | null, key: string, unit: Unit): FlagEvaluation {
  const bucket = bucketOf(flag?.key ?? key, flag?.salt ?? DEFAULT_SALT, unit.id);
  if (!flag) return { key, variant: MISSING_OFF, reason: 'default', bucket };
  if (flag.deny.includes(unit.id)) return { key, variant: flag.off, reason: 'override', bucket };
  if (flag.allow.includes(unit.id)) return { key, variant: flag.on, reason: 'override', bucket };
  for (const rule of flag.rules) {
    if (matches(rule, unit.attributes)) return { key, variant: rule.variant, reason: 'rule', bucket };
  }
  if (inBucket(bucket, percentOf(flag.rollout))) return { key, variant: flag.on, reason: 'bucket', bucket };
  return { key, variant: flag.off, reason: 'default', bucket };
}

export function evaluateDocument(document: FlagDocument, unit: Unit, keys: readonly string[] | null): readonly FlagEvaluation[] {
  const wanted = keys ?? document.flags.map(flag => flag.key);
  return wanted.map(key => evaluateFlag(document.flags.find(flag => flag.key === key) ?? null, key, unit));
}
