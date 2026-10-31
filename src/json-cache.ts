// Cache-Control for /v1 JSON. A branch name moves, so it is not stored. A full oid names one commit,
// but the request may have carried a credential, so the browser cache is private and short.
import { isFullOid } from './abbrev.ts';

export const JSON_CACHE_NO_STORE = 'no-store';

/** Seconds a successful JSON read of a full oid may sit in a private cache. */
export const JSON_PINNED_REF_MAX_AGE_S = 60;

export const JSON_PINNED_REF_CACHE = `private, max-age=${JSON_PINNED_REF_MAX_AGE_S}`;

export function jsonCacheControl(status: number, ref: string | null): string {
  if (status === 200 && ref !== null && isFullOid(ref)) return JSON_PINNED_REF_CACHE;
  return JSON_CACHE_NO_STORE;
}
