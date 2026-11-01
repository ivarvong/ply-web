// Workers Cache sits in front of FlagsCache.fetch. The default entrypoint stays uncached and calls this
// over ctx.exports, so a ruleset hit does not run the Worker. Per-user evaluations are not cached.
import { envBinding } from '../absent.ts';
import { parseDocumentText } from './document.ts';
import {
  FLAGS_CACHE_PATH,
  FLAGS_CACHE_TAG,
  FLAGS_CACHE_URL,
  FLAGS_MAX_AGE_S,
  FLAGS_OBJECT_KEY,
  FLAGS_SWR_S,
  cacheControl,
  ttlFromEnv,
} from './ttl.ts';
import { assertNever } from '../never.ts';
import { parseCacheStatus, type CacheStatus, type FlagDocument } from './types.ts';

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

/**
 * The only request FlagsCache is called with. Workers Cache keys a named entrypoint by path and query
 * (the host is not in the key), plus a few rewrite headers. This URL has no query and no such headers,
 * and it carries no Authorization (that bypasses the cache unless the response is explicitly public)
 * and no Cookie. The unit id stays off this request: it is not part of the ruleset.
 */
export function rulesetRequest(): Request {
  return new Request(FLAGS_CACHE_URL, { method: 'GET' });
}

const KEY_HEADERS = [
  'authorization',
  'cookie',
  'x-forwarded-host',
  'x-host',
  'x-forwarded-scheme',
  'x-original-url',
  'x-rewrite-url',
  'forwarded',
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
  'cloudflare-workers-version-key',
] as const;

/** Why this request would not share the one ruleset cache entry. Empty means it will. */
export function rulesetRequestProblems(request: Request): readonly string[] {
  const url = new URL(request.url);
  const problems: string[] = [];
  if (request.method !== 'GET' && request.method !== 'HEAD') problems.push(`method ${request.method}`);
  if (url.pathname !== FLAGS_CACHE_PATH) problems.push(`path ${url.pathname}`);
  if (url.search !== '') problems.push(`query ${url.search}`);
  for (const name of KEY_HEADERS) {
    if (request.headers.has(name)) problems.push(name);
  }
  return problems;
}

/**
 * Why Workers Cache would not store this ruleset response.
 * `s-maxage`, `must-revalidate`, and `proxy-revalidate` are rejected too: they disable stale-while-revalidate.
 * `Set-Cookie` and `Vary` bypass or split the one entry. `CDN-Cache-Control: no-store` wins over Cache-Control.
 */
export function rulesetCacheProblems(headers: Headers): readonly string[] {
  const problems: string[] = [];
  const control = headers.get('cache-control') ?? '';
  if (!/^public, max-age=[1-9]\d*, stale-while-revalidate=\d+$/.test(control)) problems.push(`cache-control ${control || 'missing'}`);
  if (headers.has('set-cookie')) problems.push('set-cookie');
  const vary = headers.get('vary');
  if (vary !== null) problems.push(`vary ${vary}`);
  if (headers.get('cache-tag') !== FLAGS_CACHE_TAG) problems.push('cache-tag');
  for (const name of ['cdn-cache-control', 'cloudflare-cdn-cache-control']) {
    if (headers.has(name)) problems.push(name);
  }
  return problems;
}

/** A missing header is `NONE`. A token the Cache API does not document is `UNKNOWN`. */
export function normalizeCacheStatus(value: string | null): CacheStatus {
  const parsed = parseCacheStatus(value);
  switch (parsed.kind) {
    case 'known':
      return parsed.status;
    case 'absent':
      return 'NONE';
    case 'unrecognized':
      return 'UNKNOWN';
    default:
      return assertNever(parsed);
  }
}

/** HIT did not run this Worker. BYPASS is not an R2 sample: the response was not stored. */
function countedR2Read(cache: CacheStatus): boolean {
  switch (cache) {
    case 'HIT':
    case 'BYPASS':
      return false;
    case 'MISS':
    case 'EXPIRED':
    case 'STALE':
    case 'REVALIDATED':
    case 'UPDATING':
    case 'DYNAMIC':
    case 'NONE':
    case 'UNKNOWN':
      return true;
    default:
      return assertNever(cache);
  }
}

function ttls(env: FlagCacheEnv): { maxAge: number; swr: number } {
  return {
    maxAge: ttlFromEnv(envBinding(env.FLAGS_MAX_AGE_S), FLAGS_MAX_AGE_S),
    swr: ttlFromEnv(envBinding(env.FLAGS_SWR_S), FLAGS_SWR_S),
  };
}

function rulesetHeaders(env: FlagCacheEnv, r2ReadMs: number, etag: string | null): Headers {
  const { maxAge, swr } = ttls(env);
  const headers = new Headers({
    'cache-control': cacheControl(maxAge, swr),
    'cache-tag': FLAGS_CACHE_TAG,
    [R2_HEADER]: String(r2ReadMs),
  });
  if (etag !== null) headers.set('etag', etag);
  return headers;
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
  // An absent object is the steady state before the first write. no-store here makes Workers Cache
  // BYPASS, so every GET / reads R2. The same Cache-Control and tag as a present ruleset lets the
  // empty answer hit; FlagControl.invalidate purges the tag when the object appears.
  if (!object) return new Response('no flag config\n', { status: 404, headers: rulesetHeaders(env, r2ReadMs, null) });
  const parsed = parseDocumentText(object.body);
  if (parsed.kind === 'invalid') {
    return new Response('flag config is invalid\n', { status: 500, headers: { 'cache-control': 'no-store', [R2_HEADER]: String(r2ReadMs) } });
  }
  const headers = rulesetHeaders(env, r2ReadMs, object.etag);
  if (noneMatch(request.headers.get('if-none-match'), object.etag)) return new Response(null, { status: 304, headers });
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

function r2ReadMs(response: Response, cache: CacheStatus): number | null {
  if (!countedR2Read(cache)) return null;
  const raw = response.headers.get(R2_HEADER);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export async function loadRuleset(env: FlagCacheEnv, fetchRuleset: FlagsCacheBinding | null): Promise<LoadedRuleset> {
  if (!env.FLAGS) return { kind: 'unavailable', reason: 'FLAGS binding is not configured' };
  if (!fetchRuleset) return { kind: 'unavailable', reason: 'FlagsCache entrypoint is not configured' };
  let response: Response;
  try {
    response = await fetchRuleset.fetch(rulesetRequest());
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
