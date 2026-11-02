// ply 0.2.0 returns every failure as a value (`Result<T, PlyError>`). The /v1 handlers and the write layer read those
// Results where they are returned (`if (!r.ok)`); status.ts maps a code to an HTTP status exhaustively.
// `unwrap` is what is left of the old convention, for the places where a throw still crosses a boundary on purpose:
// a helper inside an `operation()` body (ply turns a thrown PlyError into its Err and records it on the root span),
// a span-wrapped step (`tracer.span` records the throw), and the public viewer, whose error page is built from a catch.
// An Err's error is thrown exactly as ply 0.1 threw it (the same Error instance, the same code and fields).
import { CODES, DEFAULT_LIMITS, discover, parsePath, parseRefname, type Path, type Refname } from 'ply';
import { chainGet } from './absent.ts';
import type { Result } from './http/machine.ts';

type PlyResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** ply's error union. ply's index does not export it by name; every public Result carries it. */
export type PlyError = Extract<Awaited<ReturnType<typeof discover>>, { readonly ok: false }>['error'];
/** ply's closed set of error codes. */
export type PlyCode = (typeof CODES)[number];
/** The success value of a ply call's Result (or a Promise of one). */
export type OkOf<R> = Awaited<R> extends { readonly ok: true; readonly value: infer T } | { readonly ok: false } ? T : never;

export function unwrap<T>(r: PlyResult<T>): T {
  if (r.ok) return r.value;
  throw r.error;
}

export async function unwrapAsync<T>(p: Promise<PlyResult<T>>): Promise<T> {
  return unwrap(await p);
}

// ply 0.2.0 takes a ref name and a path as branded strings. The worker's request layer has validated both already
// (request.ts); these re-check through ply's own parser, so the brand is earned, not cast. A bad value throws ply's
// bad_request, as ply 0.1's push and editFile did when they validated the same string.
export const refname = (ref: string): Refname => unwrap(parseRefname(ref));
// `opts` is the call's options: its limits (ply's defaults when it names none, as operation() does) bound the path.
export function pathIn(path: string, opts: object): Result<Path, PlyError> {
  const given = chainGet(opts, 'limits');
  const limits = given.tag === 'some' && typeof given.value === 'object' && given.value !== null ? given.value : DEFAULT_LIMITS;
  const parsed = parsePath(path, limits);
  return parsed.ok ? { ok: true, value: parsed.value.path } : parsed;
}
