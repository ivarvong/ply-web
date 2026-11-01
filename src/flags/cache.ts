// Workers Cache sits in front of FlagsCache.fetch. The default entrypoint stays uncached and calls this
// over ctx.exports, so a ruleset hit does not run the Worker. Per-user evaluations are not cached.
import { parseDocumentText } from './document.ts';
import { FLAGS_OBJECT_KEY } from './ttl.ts';
import {
  FLAGS_CACHE_PATH,
  FLAGS_CACHE_TAG,
  FLAGS_MAX_AGE_S,
  FLAGS_SWR_S,
  cacheControl,
  ttlFromEnv,
} from './ttl.ts';
import type { CacheStatus, FlagDocument } from './types.ts';

export type FlagCacheEnv = {
  FLAGS?: unknown;
  FLAGS_MAX_AGE_S?: string;
  FLAGS_SWR_S?: string;
};

export type ReadableStore = { get(key: string): Promise<{ etag: string; body: string } | null> };

export type LoadedRuleset =
  | { readonly kind: 'ready'; readonly revision: string; readonly cache: CacheStatus; readonly r2ReadMs: number | null; readonly document: FlagDocument }
  | { readonly kind: 'absent'; readonly cache: CacheStatus; readonly r2ReadMs: number | null }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type FlagsCacheBinding = { fetch(request: Request): Promise<Response> };

const R2_HEADER = 'x-ply-flags-r2-ms';

const CACHE_STATUS_SET: ReadonlySet<string> = new Set(['HIT', 'MISS', 'UPDATING', 'REVALIDATED', 'EXPIRED', 'STALE', 'BYPASS', 'NONE']);

export function normalizeCacheStatus(value: string | null): CacheStatus {
  if (value && CACHE_STATUS_SET.has(value)) return value as CacheStatus;
  return 'NONE';
}

function ttls(env: FlagCacheEnv): { maxAge: number; swr: number } {
  return {
    maxAge: ttlFromEnv(env.FLAGS_MAX_AGE_S, FLAGS_MAX_AGE_S),
    swr: ttlFromEnv(env.FLAGS_SWR_S, FLAGS_SWR_S),
  };
}

function noneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some(part => {
    const token = part.trim();
    return token === '*' || token === etag || token === etag.replace(/^"|"$/g, '');
  });
}

export async function serveFlags(request: Request, env: FlagCacheEnv, store: ReadableStore | null): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed\n', { status: 405, headers: { 'cache-control': 'no-store', allow: 'GET, HEAD' } });
  }
  if (new URL(request.url).pathname !== FLAGS_CACHE_PATH) {
    return new Response('not the flag ruleset\n', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  if (!store) return new Response('flag store is not configured\n', { status: 503, headers: { 'cache-control': 'no-store' } });
  const started = performance.now();
  let object: { etag: string; body: string } | null;
  try {
    object = await store.get(FLAGS_OBJECT_KEY);
  } catch {
    return new Response('flag store read failed\n', { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  const r2ReadMs = Math.max(0, Math.round(performance.now() - started));
  if (!object) return new Response('no flag config\n', { status: 404, headers: { 'cache-control': 'no-store', [R2_HEADER]: String(r2ReadMs) } });
  const parsed = parseDocumentText(object.body);
  if (parsed.kind === 'invalid') {
    return new Response('flag config is invalid\n', { status: 500, headers: { 'cache-control': 'no-store', [R2_HEADER]: String(r2ReadMs) } });
  }
  const { maxAge, swr } = ttls(env);
  const headers = new Headers({
    etag: object.etag,
    'cache-control': cacheControl(maxAge, swr),
    'cache-tag': FLAGS_CACHE_TAG,
    [R2_HEADER]: String(r2ReadMs),
  });
  if (noneMatch(request.headers.get('if-none-match'), object.etag)) return new Response(null, { status: 304, headers });
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

function r2ReadMs(response: Response, cache: CacheStatus): number | null {
  if (cache === 'HIT' || cache === 'BYPASS') return null;
  const raw = response.headers.get(R2_HEADER);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export async function loadRuleset(env: FlagCacheEnv, fetchRuleset: FlagsCacheBinding | null): Promise<LoadedRuleset> {
  if (!env.FLAGS) return { kind: 'unavailable', reason: 'FLAGS binding is not configured' };
  if (!fetchRuleset) return { kind: 'unavailable', reason: 'FlagsCache entrypoint is not configured' };
  let response: Response;
  try {
    response = await fetchRuleset.fetch(new Request('https://flags.internal/config', { method: 'GET' }));
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : 'flag cache read failed' };
  }
  const cache = normalizeCacheStatus(response.headers.get('cf-cache-status'));
  const readMs = r2ReadMs(response, cache);
  if (response.status === 404) {
    await response.body?.cancel();
    return { kind: 'absent', cache, r2ReadMs: readMs };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return { kind: 'unavailable', reason: `flag cache returned ${response.status}` };
  }
  const text = await response.text();
  const parsed = parseDocumentText(text);
  if (parsed.kind === 'invalid') return { kind: 'unavailable', reason: parsed.reason };
  const revision = response.headers.get('etag') ?? '';
  if (!revision) return { kind: 'unavailable', reason: 'flag cache response has no etag' };
  return { kind: 'ready', revision, cache, r2ReadMs: readMs, document: parsed.document };
}
