// Absence as a value. `{ tag: "some", value }` or `{ tag: "none" }`.
//
// ply does not export this type at the pinned commit (package.json) or at ply main
// on 2026-11-01. This module is the local copy of that shape. When a pin does export
// it, re-export ply's module from this file and delete the local definitions.
// Callers keep importing `src/option.ts` either way.
//
// The platform's absent value is not a member of this type. Convert at `src/absent.ts`.

export type Some<T> = { readonly tag: "some"; readonly value: T };

export type None = { readonly tag: "none" };

export type Option<T> = Some<T> | None;

const NONE: None = Object.freeze({ tag: "none" });

export function some<T>(value: T): Some<T> {
  return Object.freeze({ tag: "some", value });
}

export function none<T = never>(): Option<T> {
  return NONE;
}

export function isSome<T>(option: Option<T>): option is Some<T> {
  return option.tag === "some";
}

export function isNone<T>(option: Option<T>): option is None {
  return option.tag === "none";
}

export function map<T, U>(option: Option<T>, fn: (value: T) => U): Option<U> {
  if (option.tag === "none") return none();
  return some(fn(option.value));
}

export function flatMap<T, U>(option: Option<T>, fn: (value: T) => Option<U>): Option<U> {
  if (option.tag === "none") return none();
  return fn(option.value);
}

export function filter<T>(option: Option<T>, keep: (value: T) => boolean): Option<T> {
  if (option.tag === "none") return none();
  if (!keep(option.value)) return none();
  return option;
}

export function unwrapOr<T>(option: Option<T>, fallback: T): T {
  if (option.tag === "none") return fallback;
  return option.value;
}

export function orElse<T>(first: Option<T>, second: Option<T>): Option<T> {
  if (first.tag === "some") return first;
  return second;
}

/** JSON and other hosts that use null for absence. A present value is returned as itself. */
export function orNull<T>(option: Option<T>): T | null {
  if (option.tag === "none") return null;
  return option.value;
}

export function match<T, U>(option: Option<T>, onSome: (value: T) => U, onNone: () => U): U {
  if (option.tag === "some") return onSome(option.value);
  if (option.tag === "none") return onNone();
  return absurd(option);
}

/** First element for which `keep` holds. A finished scan is none; the host's find is not used. */
export function find<T>(items: readonly T[], keep: (item: T) => boolean): Option<T> {
  for (const item of items) {
    if (keep(item)) return some(item);
  }
  return none();
}

function absurd(value: never): never {
  throw new Error(`unhandled option: ${JSON.stringify(value)}`);
}
