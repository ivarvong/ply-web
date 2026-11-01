// Workers Cache sits in front of FlagsCache.fetch. The default entrypoint stays uncached and calls this
// over ctx.exports, so a ruleset hit does not run the Worker. Per-user evaluations are not cached.
import { parseIfNoneMatch, readHeader, type IfNoneMatch } from '../http/inbound.ts';
import { err, httpReply, isUnexpected, ok, responseOf, runRequest, type HttpReply, type Result, type UnexpectedFailure } from '../http/machine.ts';
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

function noneMatch(header: IfNoneMatch, etag: string): boolean {
  if (header.kind === 'absent') return false;
  const bare = etag.replace(/^"|"$/g, '');
  for (const token of header.tokens) {
    if (token.kind === 'any') return true;
    if (token.value === etag || token.value === bare) return true;
  }
  return false;
}

type RulesetMethod = 'GET' | 'HEAD';

type ParsedRuleset = { readonly method: RulesetMethod; readonly ifNoneMatch: IfNoneMatch };

type RulesetRead = ParsedRuleset & { readonly store: ReadableStore };

type RulesetFailure =
  | { readonly kind: 'method' }
  | { readonly kind: 'path' }
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'read_failed'; readonly name: string };

function plainReply(status: number, text: string, headers: Headers): HttpReply {
  return httpReply(status, text, headers);
}

function rulesetFailureReply(failure: RulesetFailure): HttpReply {
  switch (failure.kind) {
    case 'method':
      return plainReply(405, 'method not allowed\n', new Headers({ 'cache-control': 'no-store', allow: 'GET, HEAD' }));
    case 'path':
      return plainReply(404, 'not the flag ruleset\n', new Headers({ 'cache-control': 'no-store' }));
    case 'unconfigured':
      return plainReply(503, 'flag store is not configured\n', new Headers({ 'cache-control': 'no-store' }));
    case 'read_failed':
      return plainReply(503, 'flag store read failed\n', new Headers({ 'cache-control': 'no-store', 'x-ply-error-kind': failure.kind }));
    default:
      return assertRulesetFailure(failure);
  }
}

function assertRulesetFailure(failure: never): never {
  throw new Error(`unhandled ruleset failure ${JSON.stringify(failure)}`);
}

function thrownName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'Error';
}

export async function serveFlags(request: Request, env: FlagCacheEnv, store: ReadableStore | null): Promise<Response> {
  return runRequest(
    {
      parse: (): Result<ParsedRuleset, RulesetFailure> => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return err({ kind: 'method' });
        if (new URL(request.url).pathname !== FLAGS_CACHE_PATH) return err({ kind: 'path' });
        return ok({ method: request.method, ifNoneMatch: parseIfNoneMatch(readHeader(request.headers, 'if-none-match')) });
      },
      authorize: (parsed: ParsedRuleset): Result<RulesetRead, RulesetFailure> => {
        if (!store) return err({ kind: 'unconfigured' });
        return ok({ method: parsed.method, ifNoneMatch: parsed.ifNoneMatch, store });
      },
      execute: (read: RulesetRead) => readRuleset(env, read),
    },
    (result: Result<HttpReply, RulesetFailure | UnexpectedFailure>) => {
      if (!result.ok) {
        if (isUnexpected(result.error)) {
          console.log(JSON.stringify({ msg: 'ply.flags.cache', error_kind: result.error.kind, stage: result.error.stage, error_name: result.error.name }));
          return new Response('unexpected\n', {
            status: 500,
            headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'x-ply-error-kind': result.error.kind },
          });
        }
        if (result.error.kind === 'read_failed') {
          console.log(JSON.stringify({ msg: 'ply.flags.cache', error_kind: result.error.kind, error_name: result.error.name }));
        }
        return responseOf(rulesetFailureReply(result.error));
      }
      return responseOf(result.value);
    },
  );
}

async function readRuleset(env: FlagCacheEnv, read: RulesetRead): Promise<Result<HttpReply, RulesetFailure>> {
  const started = performance.now();
  let object: { etag: string; body: string } | null;
  try {
    object = await read.store.get(FLAGS_OBJECT_KEY);
  } catch (error) {
    return err({ kind: 'read_failed', name: thrownName(error) });
  }
  const r2ReadMs = Math.max(0, Math.round(performance.now() - started));
  // An absent object is the steady state before the first write. no-store here makes Workers Cache
  // BYPASS, so every GET / reads R2. The same Cache-Control and tag as a present ruleset lets the
  // empty answer hit; FlagControl.invalidate purges the tag when the object appears.
  if (!object) return ok(plainReply(404, 'no flag config\n', rulesetHeaders(env, r2ReadMs, null)));
  const parsed = parseDocumentText(object.body);
  if (parsed.kind === 'invalid') {
    return ok(plainReply(500, 'flag config is invalid\n', new Headers({ 'cache-control': 'no-store', [R2_HEADER]: String(r2ReadMs) })));
  }
  const headers = rulesetHeaders(env, r2ReadMs, object.etag);
  if (noneMatch(read.ifNoneMatch, object.etag)) return ok(httpReply(304, null, headers));
  headers.set('content-type', 'application/json; charset=utf-8');
  return ok(httpReply(200, read.method === 'HEAD' ? null : object.body, headers));
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
  const etag = readHeader(response.headers, 'etag');
  if (etag.kind === 'absent' || etag.value.length === 0) return { kind: 'unavailable', reason: 'flag cache response has no etag' };
  const revision = etag.value;
  return { kind: 'ready', revision, cache, r2ReadMs: readMs, document: parsed.document };
}
