// Parse, validate, and edit the one ruleset. Edits are pure: the caller compare-and-swaps the encoded bytes.
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

const FLAG_KEY = /^[a-z][a-z0-9._-]{0,63}$/;
const UNIT_ID = /^[A-Za-z0-9._:@+/-]{1,128}$/;
const ATTR_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const ATTR_VALUE = /^[A-Za-z0-9._:@+/-]{1,128}$/;
const SALT = /^[A-Za-z0-9._:-]{1,64}$/;
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
    if (!exactKeys(value, ['kind', 'value']) || typeof value.value !== 'string' || !ATTR_VALUE.test(value.value)) return invalid('string variant is a short printable token');
    return { kind: 'string', value: value.value };
  }
  if (value.kind === 'number') {
    if (!exactKeys(value, ['kind', 'value']) || typeof value.value !== 'number' || !Number.isFinite(value.value)) return invalid('number variant must be finite');
    return { kind: 'number', value: value.value };
  }
  return invalid('variant kind must be boolean, string, or number');
}

function parseStringList(value: unknown, label: string): readonly string[] | Invalid {
  if (!Array.isArray(value)) return invalid(`${label} must be an array`);
  if (value.length > MAX_UNITS) return invalid(`${label} is longer than ${MAX_UNITS}`);
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !UNIT_ID.test(item)) return invalid(`${label} entries are unit ids`);
    if (seen.has(item)) return invalid(`${label} contains a duplicate`);
    seen.add(item);
  }
  return value;
}

function parseRule(value: unknown): AttributeRule | Invalid {
  if (!isObj(value)) return invalid('a rule must be an object');
  if (!exactKeys(value, ['attribute', 'op', 'value', 'variant'])) return invalid('a rule is {attribute, op, value, variant}');
  if (typeof value.attribute !== 'string' || !ATTR_NAME.test(value.attribute)) return invalid('rule attribute is a short name');
  if (value.op !== 'eq' && value.op !== 'neq' && value.op !== 'in') return invalid('rule op must be eq, neq, or in');
  const variant = parseVariant(value.variant);
  if ('kind' in variant && variant.kind === 'invalid') return variant;
  if (value.op === 'in') {
    if (!Array.isArray(value.value) || value.value.length < 1 || value.value.length > 32) return invalid('in rules need a value list');
    for (const item of value.value) {
      if (typeof item !== 'string' || !ATTR_VALUE.test(item)) return invalid('in-rule values are short tokens');
    }
    return { attribute: value.attribute, op: 'in', value: value.value.slice(), variant: variant as Variant };
  }
  if (typeof value.value !== 'string' || !ATTR_VALUE.test(value.value)) return invalid('eq and neq compare one token');
  return { attribute: value.attribute, op: value.op, value: value.value, variant: variant as Variant };
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
  if (typeof value.key !== 'string' || !FLAG_KEY.test(value.key)) return invalid('flag key must match ^[a-z][a-z0-9._-]{0,63}$');
  if (typeof value.salt !== 'string' || !SALT.test(value.salt)) return invalid('flag salt is a short token');
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
  return { key: value.key, salt: value.salt, rollout, on, off, allow, deny, rules };
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

export function parseUnit(id: string, attributes: Readonly<Record<string, string>> | undefined): { readonly kind: 'ok'; readonly id: string; readonly attributes: Readonly<Record<string, string>> } | Invalid {
  if (!UNIT_ID.test(id)) return invalid('unit id must be a short token');
  const source = attributes ?? {};
  const names = Object.keys(source);
  if (names.length > MAX_ATTRIBUTES) return invalid(`at most ${MAX_ATTRIBUTES} attributes`);
  const clean: Record<string, string> = {};
  for (const name of names) {
    if (!ATTR_NAME.test(name)) return invalid('attribute names are short tokens');
    const attr = source[name];
    if (typeof attr !== 'string' || !ATTR_VALUE.test(attr)) return invalid('attribute values are short tokens');
    clean[name] = attr;
  }
  return { kind: 'ok', id, attributes: clean };
}

export function freshFlag(key: string): Flag {
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

export function applyRollout(document: FlagDocument, key: string, basisPoints: number): Changed {
  if (!FLAG_KEY.test(key)) return invalid('flag key must match ^[a-z][a-z0-9._-]{0,63}$');
  const existing = document.flags.find(flag => flag.key === key);
  const base = existing ?? freshFlag(key);
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

export function applyTargeting(document: FlagDocument, key: string, targeting: Targeting): Changed {
  if (!FLAG_KEY.test(key)) return invalid('flag key must match ^[a-z][a-z0-9._-]{0,63}$');
  const existing = document.flags.find(flag => flag.key === key);
  if (!existing) return invalid(`unknown flag ${key}`);
  const parsed = parseTargeting(targeting);
  if (isInvalid(parsed)) return parsed;
  const next: Flag = { ...existing, allow: parsed.allow, deny: parsed.deny, rules: parsed.rules };
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
