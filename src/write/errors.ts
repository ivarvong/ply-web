// Worker-level codes. ply's fail() rejects anything outside its RETRY table, and Artifacts answers every lost
// compare-and-swap — create onto an existing ref, and delete with a stale old oid — with the same "stale ref".
// The distinction is made here, before the push, where the current oid is known.

export const CODE_REF_EXISTS = 'ref_exists';
export const CODE_STALE_EXPECTED = 'stale_expected';

export const WORKER_RETRY: Readonly<Record<string, string>> = Object.freeze({
  [CODE_REF_EXISTS]: 'no',
  [CODE_STALE_EXPECTED]: 'fresh',
});

export function isWorkerCode(code: unknown): code is string {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(WORKER_RETRY, code);
}

type RefExists = { oid: string };
type StaleExpected = { expected: string; actual: string };

export function refExists(ref: string, oid: string): Error {
  return Object.assign(new Error(`ref ${ref} already exists`), { code: CODE_REF_EXISTS, oid } satisfies RefExists & { code: string });
}

export function staleExpected(ref: string, expected: string, actual: string): Error {
  return Object.assign(new Error(`ref ${ref} is at ${actual}, not ${expected}`), {
    code: CODE_STALE_EXPECTED,
    expected,
    actual,
    oid: actual,
  } satisfies StaleExpected & { code: string; oid: string });
}
