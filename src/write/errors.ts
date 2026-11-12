// Worker-level codes. ply's plyError() rejects anything outside its RETRY table, and Artifacts answers every lost
// compare-and-swap — create onto an existing ref, and delete with a stale old oid — with the same "stale ref".
// The distinction is made here, before the push, where the current oid is known.
import { err, ok, type Result } from '../http/machine.ts';
import { assertNever } from '../never.ts';

export const CODE_REF_EXISTS = 'ref_exists';
export const CODE_STALE_EXPECTED = 'stale_expected';

/** The Worker's own codes, beside ply's. status.ts maps each to an HTTP status. */
export type WorkerCode = typeof CODE_REF_EXISTS | typeof CODE_STALE_EXPECTED;

export const WORKER_RETRY: Readonly<Record<WorkerCode, string>> = Object.freeze({
  [CODE_REF_EXISTS]: 'no',
  [CODE_STALE_EXPECTED]: 'fresh',
});

export function isWorkerCode(code: unknown): code is WorkerCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(WORKER_RETRY, code);
}

export { assertNever };

type RefExists = { oid: string };
type StaleExpected = { expected: string; actual: string };

export function refExists(ref: string, oid: string): WorkerError {
  return Object.assign(new Error(`ref ${ref} already exists`), { code: CODE_REF_EXISTS, oid } as const satisfies RefExists & { code: WorkerCode });
}

export function staleExpected(ref: string, expected: string, actual: string): WorkerError {
  return Object.assign(new Error(`ref ${ref} is at ${actual}, not ${expected}`), {
    code: CODE_STALE_EXPECTED,
    expected,
    actual,
    oid: actual,
  } as const satisfies StaleExpected & { code: WorkerCode; oid: string });
}

/** A thrown-shape Worker error: what index.js's errorBody and status.ts answer (409, with the documented body). */
export type WorkerError = Error & { readonly code: WorkerCode; readonly oid: string };

/**
 * A ref compare-and-swap the Worker lost, as a value. An operation() body returns it (ply turns a throw from the
 * body into bad_request 'callback', or 'ambiguous' once a push was handed to the transport — ply #277), and the
 * caller turns it into the Worker error after operation() has returned. A conflict learnt from a definite
 * cas_conflict rejection is therefore still a definite 409.
 */
export type RefConflict =
  | { readonly kind: typeof CODE_REF_EXISTS; readonly ref: string; readonly oid: string }
  | { readonly kind: typeof CODE_STALE_EXPECTED; readonly ref: string; readonly expected: string; readonly actual: string };

/** An operation() body's answer: the write landed (or was a noop), or a ref conflict to report as 409. */
export type Written<T> = { readonly kind: 'done'; readonly value: T } | RefConflict;

export const done = <T>(value: T): Written<T> => ({ kind: 'done', value });
export const refExistsAt = (ref: string, oid: string): RefConflict => ({ kind: CODE_REF_EXISTS, ref, oid });
export const staleAt = (ref: string, expected: string, actual: string): RefConflict => ({ kind: CODE_STALE_EXPECTED, ref, expected, actual });

export function conflictError(c: RefConflict): WorkerError {
  switch (c.kind) {
    case CODE_REF_EXISTS: return refExists(c.ref, c.oid);
    case CODE_STALE_EXPECTED: return staleExpected(c.ref, c.expected, c.actual);
    default: return assertNever(c);
  }
}

/** operation()'s Result over a Written body, as the write's Result: a conflict becomes its Worker error. */
export function settle<T, E>(r: Result<Written<T>, E>): Result<T, E | WorkerError> {
  if (!r.ok) return r;
  const w = r.value;
  return w.kind === 'done' ? ok(w.value) : err(conflictError(w));
}
