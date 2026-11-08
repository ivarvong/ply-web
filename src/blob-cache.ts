// Compatibility surface: inflated-blob caching is ObjectCache in the CAS graph (src/cas-cache.ts).
// Never caches.default — Workers Caching only.
export {
  BLOB_CACHE_HEADER,
  BLOB_CACHE_MAX_AGE_SECONDS,
  BLOB_CACHE_MAX_BYTES,
  BLOB_OID_HEADER,
  CAS_AUTH_HEADER as BLOB_AUTH_HEADER,
  gitAuthorizationValue,
  isBlobEntry,
  splitFilePath,
  serveObject as serveBlobCache,
  viaCas,
  type CasBinding as BlobCacheBinding,
  type CasProps as BlobCacheProps,
} from './cas-cache.ts';

import { viaCas, type CasBinding } from './cas-cache.ts';

/** @deprecated Prefer viaCas(binding, 'object', oid, scope, auth). */
export async function viaBlobCache(
  binding: CasBinding,
  oid: string,
  scope: string,
  gitAuthorization: string | null,
): Promise<Response> {
  return viaCas(binding, 'object', oid, scope, gitAuthorization);
}
