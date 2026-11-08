// Workers Cache API accessor for inflated-blob caching (ply openBlob).
// The Cache API is otherwise banned in src/ (test/gitcache.test.ts); this file is the sole
// allowlisted reader of caches.default for blob fills. Pack/refs caching stays on the GitCache
// HTTP-cache entrypoint (cloudflare.config.ts cache:enabled) — blob fetches have no filter line
// and bypass that path when authenticated.
import type { BlobCacheBinding } from 'ply';
import { BLOB_CACHE_MAX_AGE_SECONDS, BLOB_CACHE_MAX_BYTES } from 'ply';
import { chainGet } from './absent.ts';

type CacheStore = {
  readonly match: (key: string) => ReturnType<Cache['match']>;
  readonly put: (key: string, res: Response) => Promise<unknown>;
  readonly delete: (key: string) => Promise<unknown>;
};

/** Workers Cache API default store when the runtime exposes it; null on Node tests without a polyfill. */
export function workersBlobCacheStore(): CacheStore | null {
  const bag = chainGet(globalThis, 'caches');
  if (bag.tag === 'none') return null;
  const def = chainGet(bag.value, 'default');
  if (def.tag === 'none' || def.value === null) return null;
  return def.value as CacheStore;
}

export function blobCacheBinding(waitUntil: ((p: Promise<unknown>) => void) | null): BlobCacheBinding | null {
  const store = workersBlobCacheStore();
  if (store === null) return null;
  return {
    store,
    waitUntil,
    maxBytes: BLOB_CACHE_MAX_BYTES,
    maxAge: BLOB_CACHE_MAX_AGE_SECONDS,
  };
}
