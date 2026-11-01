// Pure evaluation. Order is deny, allow, attribute rules, percentage bucket, then the off variant.
// Deny wins over allow so a unit on both lists stays off while the percent grows.
import type { AttributeValue, FlagKey } from './brand.ts';
import { bucketOf, inBucket } from './hash.ts';
import { DEFAULT_SALT } from './ttl.ts';
import { basisPointsOf, type Flag, type FlagDocument, type FlagEvaluation, type FlagSelection, type Unit, type Variant } from './types.ts';

const MISSING_OFF: Variant = { kind: 'boolean', value: false };

function attributeOf(attributes: Unit['attributes'], name: Flag['rules'][number]['attribute']): AttributeValue | null {
  if (!Object.hasOwn(attributes, name)) return null;
  return attributes[name];
}

function matches(rule: Flag['rules'][number], attributes: Unit['attributes']): boolean {
  const actual = attributeOf(attributes, rule.attribute);
  if (actual === null) return false;
  if (rule.op === 'eq') return actual === rule.value;
  if (rule.op === 'neq') return actual !== rule.value;
  return Array.isArray(rule.value) && rule.value.includes(actual);
}

export function evaluateFlag(flag: Flag | null, key: FlagKey, unit: Unit): FlagEvaluation {
  const named = flag === null ? key : flag.key;
  const salt = flag === null ? DEFAULT_SALT : flag.salt;
  const bucket = bucketOf(named, salt, unit.id);
  if (flag === null) return { key, variant: MISSING_OFF, reason: 'default', bucket };
  if (flag.deny.includes(unit.id)) return { key, variant: flag.off, reason: 'override', bucket };
  if (flag.allow.includes(unit.id)) return { key, variant: flag.on, reason: 'override', bucket };
  for (const rule of flag.rules) {
    if (matches(rule, unit.attributes)) return { key, variant: rule.variant, reason: 'rule', bucket };
  }
  if (inBucket(bucket, basisPointsOf(flag.rollout))) return { key, variant: flag.on, reason: 'bucket', bucket };
  return { key, variant: flag.off, reason: 'default', bucket };
}

export function evaluateDocument(document: FlagDocument, unit: Unit, keys: FlagSelection): readonly FlagEvaluation[] {
  const wanted = keys.kind === 'all' ? document.flags.map(flag => flag.key) : keys.keys;
  return wanted.map(key => {
    let found: Flag | null = null;
    for (const flag of document.flags) {
      if (flag.key === key) found = flag;
    }
    return evaluateFlag(found, key, unit);
  });
}
