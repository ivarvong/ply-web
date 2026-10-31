// The only partition of GitCache's Workers Cache entries (crossVersionCache is on, so a deploy does not empty it). Bump
// when what GitCache stores, or the shape of its keys, changes. test/gitcache.test.ts checks a bump changes every key.
export const CACHE_VERSION = 1;
