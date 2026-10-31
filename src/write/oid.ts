// A SHA-1 object name. The zero oid is a real oid (git's "ref does not exist" compare-and-swap value) and a
// different type at the boundary where a caller meant a commit: parseCommitOid rejects it, parseOid allows it.
import { ZERO_OID as PLY_ZERO_OID } from 'ply';
import { fail } from 'ply';
import { OID_HEX_CHARS } from './constants.ts';

declare const oidBrand: unique symbol;
export type Oid = string & { readonly [oidBrand]: 'Oid' };

/** git's all-zero object name: the old oid of a ref that does not exist yet, and the new oid of a delete. */
export const ZERO_OID = PLY_ZERO_OID as Oid;

const OID_TEXT = new RegExp(`^[0-9a-f]{${OID_HEX_CHARS}}$`);

export function isOid(value: unknown): value is Oid {
  return typeof value === 'string' && OID_TEXT.test(value);
}

export function isZeroOid(value: unknown): value is Oid {
  return value === ZERO_OID;
}

export function asOid(value: string): Oid {
  if (!isOid(value)) throw fail('bad_request', `expected a ${OID_HEX_CHARS}-hex object id`);
  return value;
}

/** A commit id. The zero oid is not a commit; callers that mean "no parent" omit the field. */
export function parseCommitOid(value: unknown, field: string): Oid {
  if (isZeroOid(value)) throw fail('bad_request', `${field} must not be the zero oid`);
  if (!isOid(value)) throw fail('bad_request', `${field} must be a ${OID_HEX_CHARS}-hex commit id`);
  return value;
}
