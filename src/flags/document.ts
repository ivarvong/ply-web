// Parse, validate, and edit the one ruleset. Edits are pure: the caller compare-and-swaps the encoded bytes.
// Flag keys, unit ids, attribute tokens, and salts are branded once, in brand.ts.
import {
  parseAttributeName,
  parseAttributeValue,
  parseFlagKey,
  parseFlagSalt,
  parseUnitId,
  type AttributeName,
  type AttributeValue,
  type FlagKey,
  type UnitId,
} from './brand.ts';
import { BASIS_POINTS, DEFAULT_SALT, MAX_ATTRIBUTES, MAX_DOCUMENT_BYTES, MAX_FLAGS, MAX_RULES, MAX_UNITS } from './ttl.ts';
import {
  EMPTY_DOCUMENT,
  type AttributeRule,
  type DiffEntry,
  type Flag,
  type FlagDocument,
  type Invalid,
  type Rollout,
  type Targeting,
  type Variant,
} from './types.ts';

const ROLLBACK_REASON = /^[\x20-\x7e]{1,200}$/;

type Obj = Record<string, unknown>;

function invalid(reason: string): Invalid {
  return { kind: 'invalid', reason };
}

function isInvalid(value: unknown): value is Invalid {
  return !!value && typeof value === 'object' && (value as Invalid).kind === 'invalid' && typeof (value as Invalid).reason === 'string';
}

function isObj(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Obj, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && allowed.every(key => keys.includes(key));
}

function parseVariant(value: unknown): Variant | Invalid {
  if (!isObj(value) || typeof value.kind !== 'string') return invalid('variant must be a typed object');
  if (value.kind === 'boolean') {
    if (!exactKeys(value, ['kind', 'value']) || typeof value.value !== 'boolean') return invalid('boolean variant is {kind, value}');
    return { kind: 'boolean', value: value.value };
  }
  if (value.kind === 'string') {
    if (!exactKeys(value, ['kind', 'value']) || typeof value.value !== 'string') return invalid('string variant is a short printable token');
    const parsed = parseAttributeValue(value.value);
    if (parsed.kind !== 'value') return invalid('string variant is a short printable token');
    return { kind: 'string', value: parsed.value };
  }
  if (value.kind === 'number') {
    if (!exactKeys(value, ['kind', 'value']) || typeof value.value !== 'number' || !Number.isFinite(value.value)) return invalid('number variant must be finite');
    return { kind: 'number', value: value.value };
  }
  return invalid('variant kind must be boolean, string, or number');
}

function parseStringList(value: unknown, label: string): readonly UnitId[] | Invalid {
  if (!Array.isArray(value)) return invalid(`${label} must be an array`);
  if (value.length > MAX_UNITS) return invalid(`${label} is longer than ${MAX_UNITS}`);
  const seen = new Set<UnitId>();
  const ids: UnitId[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return invalid(`${label} entries are unit ids`);
    const parsed = parseUnitId(item);
    if (parsed.kind !== 'id') return invalid(`${label} entries are unit ids`);
    if (seen.has(parsed.value)) return invalid(`${label} contains a duplicate`);
    seen.add(parsed.value);
    ids.push(parsed.value);
  }
  return ids;
}

function parseRule(value: unknown): AttributeRule | Invalid {
  if (!isObj(value)) return invalid('a rule must be an object');
  if (!exactKeys(value, ['attribute', 'op', 'value', 'variant'])) return invalid('a rule is {attribute, op, value, variant}');
  if (typeof value.attribute !== 'string') return invalid('rule attribute is a short name');
  const attribute = parseAttributeName(value.attribute);
  if (attribute.kind !== 'name') return invalid('rule attribute is a short name');
  if (value.op !== 'eq' && value.op !== 'neq' && value.op !== 'in') return invalid('rule op must be eq, neq, or in');
  const variant = parseVariant(value.variant);
  if ('kind' in variant && variant.kind === 'invalid') return variant;
  if (value.op === 'in') {
    if (!Array.isArray(value.value) || value.value.length < 1 || value.value.length > 32) return invalid('in rules need a value list');
    const items: AttributeValue[] = [];
    for (const item of value.value) {
      if (typeof item !== 'string') return invalid('in-rule values are short tokens');
      const parsed = parseAttributeValue(item);
      if (parsed.kind !== 'value') return invalid('in-rule values are short tokens');
      items.push(parsed.value);
    }
    return { attribute: attribute.value, op: 'in', value: items, variant: variant as Variant };
  }
  if (typeof value.value !== 'string') return invalid('eq and neq compare one token');
  const compared = parseAttributeValue(value.value);
  if (compared.kind !== 'value') return invalid('eq and neq compare one token');
  return { attribute: attribute.value, op: value.op, value: compared.value, variant: variant as Variant };
}

function basisPoint(value: unknown): number | Invalid {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value >= BASIS_POINTS) return invalid(`ramping basisPoints is an integer from 1 to ${BASIS_POINTS - 1}`);
  return value;
}

function parseRollout(value: unknown): Rollout | Invalid {
  if (!isObj(value) || typeof value.kind !== 'string') return invalid('rollout must be an object');
  if (value.kind === 'rolled-back') {
    if (!exactKeys(value, ['kind', 'reason'])) return invalid('rolled-back rollout is {kind, reason}');
    if (typeof value.reason !== 'string' || !ROLLBACK_REASON.test(value.reason)) return invalid('rollback reason must be printable');
    return { kind: 'rolled-back', reason: value.reason };
  }
  if (value.kind === 'complete') {
    if (!exactKeys(value, ['kind'])) return invalid('complete rollout is {kind}');
    return { kind: 'complete' };
  }
  if (value.kind === 'ramping') {
    if (!exactKeys(value, ['kind', 'basisPoints'])) return invalid('ramping rollout is {kind, basisPoints}');
    const basisPoints = basisPoint(value.basisPoints);
    if (typeof basisPoints !== 'number') return basisPoints;
    return { kind: 'ramping', basisPoints };
  }
  return invalid('rollout kind must be ramping, complete, or rolled-back');
}

function parseFlag(value: unknown): Flag | Invalid {
  if (!isObj(value)) return invalid('a flag must be an object');
  if (!exactKeys(value, ['key', 'salt', 'rollout', 'on', 'off', 'allow', 'deny', 'rules'])) return invalid('a flag has key, salt, rollout, on, off, allow, deny, rules');
  if (typeof value.key !== 'string') return invalid('flag key must match ^[a-z][a-z0-9._-]{0,63}$');
  const key = parseFlagKey(value.key);
  if (key.kind !== 'key') return key;
  if (typeof value.salt !== 'string') return invalid('flag salt is a short token');
  const salt = parseFlagSalt(value.salt);
  if (salt.kind !== 'salt') return invalid('flag salt is a short token');
  const rollout = parseRollout(value.rollout);
  if (isInvalid(rollout)) return rollout;
  const on = parseVariant(value.on);
  if (isInvalid(on)) return on;
  const off = parseVariant(value.off);
  if (isInvalid(off)) return off;
  const allow = parseStringList(value.allow, 'allow');
  if (isInvalid(allow)) return allow;
  const deny = parseStringList(value.deny, 'deny');
  if (isInvalid(deny)) return deny;
  if (!Array.isArray(value.rules)) return invalid('rules must be an array');
  if (value.rules.length > MAX_RULES) return invalid(`a flag has at most ${MAX_RULES} rules`);
  const rules: AttributeRule[] = [];
  for (const rule of value.rules) {
    const parsed = parseRule(rule);
    if (isInvalid(parsed)) return parsed;
    rules.push(parsed);
  }
  return { key: key.value, salt: salt.value, rollout, on, off, allow, deny, rules };
}

export type ParsedDocument = { readonly kind: 'ok'; readonly document: FlagDocument } | Invalid;

export function parseDocument(value: unknown): ParsedDocument {
  if (!isObj(value)) return invalid('flag config must be an object');
  if (!exactKeys(value, ['environment', 'flags'])) return invalid('flag config is {environment, flags}');
  if (value.environment !== 'production') return invalid('environment must be production');
  if (!Array.isArray(value.flags)) return invalid('flags must be an array');
  if (value.flags.length > MAX_FLAGS) return invalid(`at most ${MAX_FLAGS} flags`);
  const flags: Flag[] = [];
  const seen = new Set<string>();
  for (const item of value.flags) {
    const flag = parseFlag(item);
    if (isInvalid(flag)) return flag;
    if (seen.has(flag.key)) return invalid(`duplicate flag ${flag.key}`);
    seen.add(flag.key);
    flags.push(flag);
  }
  return { kind: 'ok', document: { environment: 'production', flags } };
}

export function parseDocumentText(text: string): ParsedDocument {
  if (text.length > MAX_DOCUMENT_BYTES) return invalid('flag config is over 64 KiB');
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return invalid('flag config is not JSON');
  }
  return parseDocument(value);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Obj;
    const keys = Object.keys(record).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function encodeDocument(document: FlagDocument): string {
  return stableStringify(document);
}

export type AttributeInput =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly value: Readonly<Record<string, unknown>> };

export function parseUnit(id: string, attributes: AttributeInput): { readonly kind: 'ok'; readonly id: UnitId; readonly attributes: Readonly<Record<AttributeName, AttributeValue>> } | Invalid {
  const parsedId = parseUnitId(id);
  if (parsedId.kind !== 'id') return invalid(parsedId.reason);
  const source = attributes.kind === 'present' ? attributes.value : {};
  const names = Object.keys(source);
  if (names.length > MAX_ATTRIBUTES) return invalid(`at most ${MAX_ATTRIBUTES} attributes`);
  const clean: Record<AttributeName, AttributeValue> = {};
  for (const name of names) {
    const parsedName = parseAttributeName(name);
    if (parsedName.kind !== 'name') return invalid('attribute names are short tokens');
    const attr = source[name];
    if (typeof attr !== 'string') return invalid('attribute values are short tokens');
    const parsedValue = parseAttributeValue(attr);
    if (parsedValue.kind !== 'value') return invalid('attribute values are short tokens');
    clean[parsedName.value] = parsedValue.value;
  }
  return { kind: 'ok', id: parsedId.value, attributes: clean };
}

function findFlag(document: FlagDocument, key: FlagKey): Flag | null {
  for (const flag of document.flags) {
    if (flag.key === key) return flag;
  }
  return null;
}

export function freshFlag(key: FlagKey): Flag {
  return {
    key,
    salt: DEFAULT_SALT,
    rollout: { kind: 'rolled-back', reason: 'created' },
    on: { kind: 'boolean', value: true },
    off: { kind: 'boolean', value: false },
    allow: [],
    deny: [],
    rules: [],
  };
}

export function applyBasisPoints(basisPoints: number): { readonly kind: 'ok'; readonly rollout: Rollout } | Invalid {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > BASIS_POINTS) return invalid(`basis points must be an integer from 0 to ${BASIS_POINTS}`);
  if (basisPoints === 0) return { kind: 'ok', rollout: { kind: 'rolled-back', reason: 'basis points 0' } };
  if (basisPoints === BASIS_POINTS) return { kind: 'ok', rollout: { kind: 'complete' } };
  return { kind: 'ok', rollout: { kind: 'ramping', basisPoints } };
}

export type Changed = { readonly kind: 'ok'; readonly document: FlagDocument } | Invalid;

export function applyRollout(document: FlagDocument, key: FlagKey, basisPoints: number): Changed {
  const existing = findFlag(document, key);
  const base = existing === null ? freshFlag(key) : existing;
  const applied = applyBasisPoints(basisPoints);
  if (applied.kind === 'invalid') return applied;
  const next: Flag = { ...base, rollout: applied.rollout };
  const flags = existing ? document.flags.map(flag => flag.key === key ? next : flag) : [...document.flags, next];
  if (flags.length > MAX_FLAGS) return invalid(`at most ${MAX_FLAGS} flags`);
  return { kind: 'ok', document: { environment: document.environment, flags } };
}

export function parseTargeting(value: unknown): Targeting | Invalid {
  if (!isObj(value) || !exactKeys(value, ['allow', 'deny', 'rules'])) return invalid('targeting is {allow, deny, rules}');
  const allow = parseStringList(value.allow, 'allow');
  if (isInvalid(allow)) return allow;
  const deny = parseStringList(value.deny, 'deny');
  if (isInvalid(deny)) return deny;
  if (!Array.isArray(value.rules)) return invalid('rules must be an array');
  if (value.rules.length > MAX_RULES) return invalid(`a flag has at most ${MAX_RULES} rules`);
  const rules: AttributeRule[] = [];
  for (const rule of value.rules) {
    const parsed = parseRule(rule);
    if (isInvalid(parsed)) return parsed;
    rules.push(parsed);
  }
  return { allow, deny, rules };
}

export function applyTargeting(document: FlagDocument, key: FlagKey, targeting: Targeting): Changed {
  const existing = findFlag(document, key);
  if (existing === null) return invalid(`unknown flag ${key}`);
  const next: Flag = { ...existing, allow: targeting.allow, deny: targeting.deny, rules: targeting.rules };
  return { kind: 'ok', document: { environment: document.environment, flags: document.flags.map(flag => flag.key === key ? next : flag) } };
}

function targetingOf(flag: Flag): Targeting {
  return { allow: flag.allow, deny: flag.deny, rules: flag.rules };
}

export function diffDocuments(before: FlagDocument, after: FlagDocument): readonly DiffEntry[] {
  const previous = new Map(before.flags.map(flag => [flag.key, flag]));
  const diffs: DiffEntry[] = [];
  for (const flag of after.flags) {
    const old = previous.get(flag.key);
    if (!old) {
      diffs.push({ op: 'create', key: flag.key, after: { rollout: flag.rollout, allow: flag.allow, deny: flag.deny } });
      continue;
    }
    if (stableStringify(old.rollout) !== stableStringify(flag.rollout)) diffs.push({ op: 'rollout', key: flag.key, before: old.rollout, after: flag.rollout });
    if (stableStringify(targetingOf(old)) !== stableStringify(targetingOf(flag))) diffs.push({ op: 'targeting', key: flag.key, before: targetingOf(old), after: targetingOf(flag) });
  }
  return diffs;
}

export function emptyDocument(): FlagDocument {
  return EMPTY_DOCUMENT;
}
