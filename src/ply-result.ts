// ply 0.2.0 returns every failure as a value (`Result<T, PlyError>`). The worker's convention is older and simpler:
// a ply error is thrown and mapped to an HTTP status by its `code` (status.ts). This is the one edge between the two:
// an Err's error is thrown exactly as ply 0.1 threw it (the same Error instance, the same code and fields).
import { DEFAULT_LIMITS, parsePath, parseRefname, type Path, type Refname } from 'ply';
import { chainGet } from './absent.ts';

type PlyResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

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
export function pathOf(path: string, opts: object): Path {
  const given = chainGet(opts, 'limits');
  const limits = given.tag === 'some' && typeof given.value === 'object' && given.value !== null ? given.value : DEFAULT_LIMITS;
  return unwrap(parsePath(path, limits)).path;
}
