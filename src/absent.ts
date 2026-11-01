// The only module allowed to spell JavaScript's `undefined`, optional members (`?:`),
// optional chaining (`?.`), or nullish coalescing (`??`). `scripts/absence-gate.ts`
// exempts this path and no other. Grep here.
//
// Host APIs (Request, URL, headers, Worker env, the Cache API, R2 get, JSON, OTel)
// speak null and `undefined`. Domain code speaks Option or a closed union. Convert once, here.
// `undefined` leaves this file only as the branded `PlatformAbsent` value inside a converter.

import { none, some, type Option } from "./option.ts";

declare const platformAbsentBrand: unique symbol;

/**
 * JavaScript's `undefined`, branded so a mention is a boundary crossing.
 * The brand is a unique symbol: another module cannot forge the type without this symbol.
 * The runtime value is still the host's absent value. Only this module reads or writes it.
 * Also published globally so an ambient host declaration can name it without becoming a module.
 */
export type PlatformAbsent = undefined & { readonly [platformAbsentBrand]: "platform-absent" };

declare global {
  type PlatformAbsent = undefined & { readonly [platformAbsentBrand]: "platform-absent" };
}

/** True for the host's absent value. Tests use this. Domain code matches on Option. */
export function isPlatformAbsent(value: unknown): value is PlatformAbsent {
  return value === undefined;
}

/**
 * Map the host's absent value to none. Null stays a present value (`some(null)`),
 * which is what JSON null and a stored null mean.
 */
export function fromAbsent<T>(value: T): Option<Exclude<T, undefined>> {
  if (value === undefined) return none();
  return some(value as Exclude<T, undefined>);
}

/**
 * Map null and the host's absent value to none. This is the converter for APIs that
 * use the two interchangeably (headers, query strings, R2 get, Cache.match).
 */
export function fromNullable<T>(value: T): Option<NonNullable<T>> {
  if (value === undefined || value === null) return none();
  return some(value as NonNullable<T>);
}

export function mapGet<K, V>(map: ReadonlyMap<K, V>, key: K): Option<Exclude<V, undefined>> {
  // Map#get cannot tell a missing key from a stored absent value. This codebase does not store one.
  return fromAbsent(map.get(key));
}

export function recordGet<V>(record: Readonly<Record<string, V>> | null | undefined, key: string): Option<Exclude<V, undefined>> {
  if (record === undefined || record === null) return none();
  if (!Object.hasOwn(record, key)) return none();
  return fromAbsent(record[key]);
}

/** One property, the way `?.` reads it: a null receiver, a missing key, and a null property are all none. */
export function chainGet(value: unknown, key: string): Option<unknown> {
  if (value === undefined || value === null) return none();
  if (typeof value !== "object" && typeof value !== "function") return none();
  if (!(key in value)) return none();
  return fromNullable((value as Record<string, unknown>)[key]);
}

/** `a?.b?.c`, as one Option. An empty key list is the value itself, with null counted as none. */
export function dig(value: unknown, keys: readonly string[]): Option<unknown> {
  let current: Option<unknown> = fromNullable(value);
  for (const key of keys) {
    if (current.tag === "none") return none();
    current = chainGet(current.value, key);
  }
  return current;
}

/**
 * Index into a list. Out of range is none. A hole (the host's absent element, including an
 * unmatched capture group) is none. A stored null is `some(null)`.
 */
export function atIndex<T>(items: readonly T[], index: number): Option<Exclude<T, undefined>> {
  if (!Number.isInteger(index) || index < 0 || index >= items.length) return none();
  return fromAbsent(items[index]);
}

export function captureGroup(match: RegExpMatchArray | RegExpExecArray | null, index: number): Option<string> {
  if (match === null) return none();
  return atIndex(match, index);
}

export function header(headers: Headers, name: string): Option<string> {
  return fromNullable(headers.get(name));
}

export function queryParam(params: URLSearchParams, name: string): Option<string> {
  return fromNullable(params.get(name));
}

export function requestHeader(request: Request, name: string): Option<string> {
  return header(request.headers, name);
}

export function requestQuery(request: Request, name: string): Option<string> {
  return queryParam(new URL(request.url).searchParams, name);
}

/** A Worker binding or text var. Both null and a missing binding are none. Empty text stays present. */
export function envBinding<T>(value: T): Option<NonNullable<T>> {
  return fromNullable(value);
}

/** Cache.match returns the host's absent value on a miss. A hit is the Response. */
export async function cacheMatch(
  cache: { match(request: RequestInfo | URL): Promise<Response | null | undefined> },
  request: RequestInfo | URL,
): Promise<Option<Response>> {
  return fromNullable(await cache.match(request));
}

/** R2 get returns null when the key is absent. */
export async function r2Get<T>(
  bucket: { get(key: string): Promise<T | null> },
  key: string,
): Promise<Option<NonNullable<T>>> {
  return fromNullable(await bucket.get(key));
}

export type JsonDecoded =
  | { readonly tag: "value"; readonly value: unknown }
  | { readonly tag: "invalid"; readonly reason: "syntax" };

/** A JSON value, or syntax failure. Failure is not absence: the text was not JSON. */
export function decodeJson(text: string): JsonDecoded {
  try {
    const value: unknown = JSON.parse(text);
    if (value === undefined) return { tag: "invalid", reason: "syntax" };
    return { tag: "value", value };
  } catch {
    return { tag: "invalid", reason: "syntax" };
  }
}

/**
 * One own field of a JSON object. A missing field is none. JSON null is `some(null)`.
 * Arrays and non-objects are none: index with `atIndex` instead.
 */
export function jsonField(value: unknown, key: string): Option<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return none();
  if (!Object.hasOwn(value, key)) return none();
  return fromAbsent((value as Record<string, unknown>)[key]);
}

export type OtelAttribute = string | number | boolean;

/** One OTel attribute on a string-keyed bag. A missing key, null, or a non-attribute type is none. */
export function otelAttribute(attrs: unknown, key: string): Option<OtelAttribute> {
  const field = jsonField(attrs, key);
  if (field.tag === "none") return none();
  const value = field.value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return some(value);
  return none();
}

/**
 * One OTLP attribute from a `{ key, value }` list (span.attributes). The first matching key wins.
 * A missing list, key, or value is none. JSON null is `some(null)`.
 */
export function otelListField(list: unknown, key: string): Option<unknown> {
  if (!Array.isArray(list)) return none();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!Object.hasOwn(record, "key") || record.key !== key) continue;
    if (!Object.hasOwn(record, "value")) return none();
    return fromAbsent(record.value);
  }
  return none();
}

/** `error.code` / `error.message`, including fields that live on the prototype. Null and missing are none. */
export function thrownField(value: unknown, key: string): Option<unknown> {
  return chainGet(value, key);
}

export type ManualInit = {
  readonly method: string;
  readonly headers: HeadersInit;
  readonly body: Option<BodyInit>;
  readonly signal: Option<AbortSignal>;
};

/**
 * Fetch init for a manual-redirect hop. `none` becomes the host's absent value, which is what
 * `body ?? undefined` and `signal ?? undefined` pass today (null is not a body and not a signal).
 */
export function manualInit(parts: ManualInit): RequestInit {
  const body = parts.body.tag === "some" ? parts.body.value : undefined;
  const signal = parts.signal.tag === "some" ? parts.signal.value : undefined;
  return {
    method: parts.method,
    headers: parts.headers,
    body,
    redirect: "manual",
    signal,
  };
}

/**
 * `span.setAttribute`, when the tracer gave us a span and when it did not.
 * A throw is swallowed: telemetry must not change the request.
 */
export function writeSpanAttribute(span: unknown, key: string, value: OtelAttribute): void {
  try {
    const write = chainGet(span, "setAttribute");
    if (write.tag === "none" || typeof write.value !== "function") return;
    write.value.call(span, key, value);
  } catch {
    // Telemetry must not change the request.
  }
}

/** `span.end`, with the same swallow as `writeSpanAttribute`. */
export function endOptionalSpan(span: unknown): void {
  try {
    const end = chainGet(span, "end");
    if (end.tag === "none" || typeof end.value !== "function") return;
    end.value.call(span);
  } catch {
    // Telemetry must not change the request.
  }
}
