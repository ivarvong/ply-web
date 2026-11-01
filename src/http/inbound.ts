// Inbound HTTP values as closed unions. Headers.get yields null when the field is missing.
// The one boundary module owns platform absence; this file does not mention it.

declare const bearerTokenBrand: unique symbol;

export type BearerToken = string & { readonly [bearerTokenBrand]: 'BearerToken' };

export type HeaderField =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly value: string };

export type BearerCredential =
  | { readonly kind: 'absent' }
  | { readonly kind: 'bearer'; readonly token: BearerToken };

export type IfNoneMatchToken =
  | { readonly kind: 'any' }
  | { readonly kind: 'tag'; readonly value: string };

export type IfNoneMatch =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly tokens: readonly IfNoneMatchToken[] };

export type JsonField =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly value: unknown };

export type JsonRecord =
  | { readonly kind: 'record'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: 'invalid' };

export function readHeader(headers: Headers, name: string): HeaderField {
  const value = headers.get(name);
  if (value === null) return { kind: 'absent' };
  return { kind: 'present', value };
}

export function headerNumber(field: HeaderField): number {
  if (field.kind === 'absent') return 0;
  return Number(field.value);
}

/** `pattern` must capture the token in group 1. Each caller keeps its own bearer shape. */
export function parseBearer(field: HeaderField, pattern: RegExp): BearerCredential {
  if (field.kind === 'absent') return { kind: 'absent' };
  const match = pattern.exec(field.value);
  if (match === null) return { kind: 'absent' };
  const token = match[1];
  if (typeof token !== 'string' || token.length === 0) return { kind: 'absent' };
  return { kind: 'bearer', token: token as BearerToken };
}

export function parseIfNoneMatch(field: HeaderField): IfNoneMatch {
  if (field.kind === 'absent' || field.value.length === 0) return { kind: 'absent' };
  const tokens: IfNoneMatchToken[] = [];
  for (const part of field.value.split(',')) {
    const token = part.trim();
    if (token.length === 0) continue;
    tokens.push(token === '*' ? { kind: 'any' } : { kind: 'tag', value: token });
  }
  return { kind: 'present', tokens };
}

export function jsonField(record: Readonly<Record<string, unknown>>, name: string): JsonField {
  if (!Object.hasOwn(record, name)) return { kind: 'absent' };
  return { kind: 'present', value: record[name] };
}

export function jsonRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid' };
  return { kind: 'record', value: value as Readonly<Record<string, unknown>> };
}
