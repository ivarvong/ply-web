// Workers Cache for public git reads (never the Cache API). The default entrypoint has caching off and always runs: rate
// limit, logs, scrubbing, traces. For an upload-pack exchange whose answer is public, it calls the cache-enabled
// `GitCache` entrypoint over ctx.exports instead of the upstream; GitCache performs the upstream request and returns it
// with a Cache-Control decided by what the exchange is:
//
//   pack      POST git-upload-pack, command=fetch, wants only (no have / shallow / want-ref / deepen-since / deepen-not):
//             a pure function of (url, body). Objects are named by their hash, so  public, max-age=31536000, immutable.
//   refs      POST git-upload-pack, command=ls-refs: refs move.           public, max-age=REFS_MAX_AGE_S, swr=REFS_SWR_S
//   discover  GET info/refs?service=git-upload-pack: a v2 answer is the capability list (no refs), so it is long-lived;
//             a v0 answer carries the refs, so it gets the refs policy.
//
// What is public, and so may be cached (`cacheableUpstream`): the request carries no Authorization (a caller's Git-Token
// or Git-Authorization always bypasses the cache), and the URL is either exactly a public-namespace repo endpoint
// (publicUploadPackRepo) or an upload-pack endpoint on one of the viewer's built-in allowlisted forges.
//
// Key: /v<CACHE_VERSION>/<kind>/<sha256(kind, url, git-protocol, body)>. The upstream request rides in headers, which are
// not part of a Workers Cache key; GitCache recomputes the hash from them and refuses a mismatch, so no request can
// store an answer under another request's key. crossVersionCache is on, so CACHE_VERSION is the only partition: bump it
// when what GitCache stores changes.
//
// ply's retry after a corrupt cached pack sends `x-ply-cache: bust`; the loopback then purges that key (GitCache, which
// owns it) and fetches again.
import { CACHE_VERSION } from './cache-version.ts';
import { extractRequestPath, rawPathHasUnsafeSegment } from './pathguard.ts';
import { publicUploadPackRepo, scrubSecrets, type TokenSource, withPublicReadCredential, type FetchLike } from './public.ts';
import { ALLOWED_HOSTS } from './viewer/url.ts';
import { withLimits } from 'ply';
import { createGitTransport, makeTracer, readPack } from './viewer/ply.ts';

export type CacheKind = 'pack' | 'refs' | 'discover';

export const REFS_MAX_AGE_S = 5;
export const REFS_SWR_S = 10;
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REFS_CACHE = `public, max-age=${REFS_MAX_AGE_S}, stale-while-revalidate=${REFS_SWR_S}`;
export const DISCOVER_V2_CACHE = 'public, max-age=300, stale-while-revalidate=3600';
export const NO_STORE = 'no-store';

/** The request body travels base64 in a header; a larger body (many wants) is not routed through the cache. */
export const MAX_ROUTED_BODY = 4096;
const MAX_ERROR_BODY = 64 * 1024;
/** A pack is stored only after GitCache has verified it, and it buffers the pack to do so; bigger ones pass through unstored. */
export const MAX_VERIFIED_PACK = 16 * 1024 * 1024;
const VERIFY_LIMITS = withLimits({ maxPackBytes: MAX_VERIFIED_PACK, maxObjectSize: MAX_VERIFIED_PACK, maxInflatedTotal: 4 * MAX_VERIFIED_PACK, maxHarvestBytes: MAX_VERIFIED_PACK, maxPackObjects: 100_000, maxTreeEntries: 1_000_000, requestTimeoutMs: 30_000 });

const wantsOf = (body: Uint8Array) => [...latin1(body).matchAll(/[0-9a-f]{4}want ([0-9a-f]{40})\n/g)].map(m => m[1] as string);

/**
 * Verify a buffered upload-pack fetch answer with ply's own parser: frame it, parse the pack, resolve every delta and
 * hash every object, and require every wanted oid among the results. ply's streamed blob read (openBlob) has no
 * retry-past-the-cache, so an unverified pack must never be stored as immutable.
 */
export async function verifyPackResponse(url: string, body: Uint8Array, bytes: Uint8Array, contentType: string): Promise<{ ok: true; objects: number } | { ok: false; reason: string }> {
  const wants = wantsOf(body);
  if (!wants.length) return { ok: false, reason: 'no wants' };
  const deepen = /[0-9a-f]{4}deepen (\d+)\n/.exec(latin1(body))?.[1];
  const filter = /[0-9a-f]{4}filter ([^\n]+)\n/.exec(latin1(body))?.[1];
  const replay = async () => new Response(bytes.slice(), { status: 200, headers: { 'content-type': contentType } });
  try {
    const t = createGitTransport(url, { tracer: makeTracer(() => {}, { maxEvents: 0, resource: {} }), fetchImpl: replay, userAgent: 'ply-gitcache', limits: VERIFY_LIMITS, signal: AbortSignal.timeout(30_000), quirks: {} });
    const r = await readPack(t, { wants, ...(deepen ? { deepen: Number(deepen) } : {}), ...(filter ? { filter } : {}), ofsDelta: true }, { resolve: true }) as { parsed: unknown; objects?: Map<string, unknown> | null };
    const objects = r.objects;
    if (!objects) return { ok: false, reason: 'no pack in the answer' };
    const missing = wants.filter(w => !objects.has(w));
    return missing.length ? { ok: false, reason: `wanted ${missing.length} oid(s) not in the pack` } : { ok: true, objects: objects.size };
  } catch (e) {
    return { ok: false, reason: String((e as { code?: string; message?: string })?.code ?? (e as Error)?.message ?? e).slice(0, 120) };
  }
}

const H_URL = 'x-ply-gc-url';
const H_BODY = 'x-ply-gc-body';
const H_PROTO = 'x-ply-gc-proto';
const H_UA = 'x-ply-gc-ua';
/** Set by GitCache on its upstream request, so tests can tell a cached path from a direct one. Carries no secret. */
export const VIA_HEADER = 'x-ply-via';

const BUILTIN = new Set<string>(ALLOWED_HOSTS);

function forgeUploadPack(method: string, raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > 2048 || raw.includes('\\') || raw.includes('#')) return false;
  if (rawPathHasUnsafeSegment(extractRequestPath(raw))) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password || !BUILTIN.has(u.hostname)) return false;
  if (!raw.startsWith(`https://${u.hostname}/`)) return false;
  const verb = method.toUpperCase();
  if (u.pathname.endsWith('/info/refs')) return verb === 'GET' && u.search === '?service=git-upload-pack';
  return u.pathname.endsWith('/git-upload-pack') && verb === 'POST' && u.search === '';
}

/** Is (method, url) an upload-pack endpoint whose anonymous answer is public? (Authorization is checked by the caller.) */
export function cacheableUpstream(method: string, url: string): boolean {
  return publicUploadPackRepo(method, url) !== null || forgeUploadPack(method, url);
}

const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] as number); return s; };

/** Which cache policy an upload-pack exchange gets, or null when it is not a pure function of its request. */
export function classify(method: string, url: string, body: Uint8Array | null): CacheKind | null {
  if (method.toUpperCase() === 'GET') return url.endsWith('/info/refs?service=git-upload-pack') && !body ? 'discover' : null;
  if (!body) return null;
  const t = latin1(body);
  // pkt-lines: 4 hex length, then the payload; anchor to the length prefix so text inside a payload can't match.
  const has = (re: RegExp) => re.test(t);
  if (has(/[0-9a-f]{4}command=ls-refs\n/)) return 'refs';
  if (!has(/[0-9a-f]{4}command=fetch\n/)) return null;
  if (has(/[0-9a-f]{4}have [0-9a-f]{40}\n/) || has(/[0-9a-f]{4}want-ref /) || has(/[0-9a-f]{4}deepen-(since|not) /) || has(/[0-9a-f]{4}shallow [0-9a-f]{40}\n/)) return null;
  return has(/[0-9a-f]{4}want [0-9a-f]{40}\n/) ? 'pack' : null;
}

function toBase64(b: Uint8Array): string { return btoa(latin1(b)); }
function fromBase64(s: string): Uint8Array { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

export async function keyHash(kind: CacheKind, url: string, gitProtocol: string, body: Uint8Array | null): Promise<string> {
  const head = new TextEncoder().encode(`ply-gitcache\n${kind}\n${url}\n${gitProtocol}\n`);
  const all = new Uint8Array(head.length + (body?.length ?? 0));
  all.set(head);
  if (body) all.set(body, head.length);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  let hex = '';
  for (const x of d) hex += x.toString(16).padStart(2, '0');
  return hex;
}

export function keyPath(kind: CacheKind, hash: string, version: number = CACHE_VERSION): string {
  return `/v${version}/${kind}/${hash}`;
}

export type LoopbackBinding = { fetch(req: Request): Promise<Response> };

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * The fetch that sits under the redirect guards (createGuardedFetch, createViewerFetch). A public, cacheable exchange
 * with no Authorization goes to GitCache; everything else goes to `direct` unchanged. `loopback` is null when the
 * cache is off (PACK_CACHE=off) or there is no ctx.exports (node tests).
 */
export function createLoopbackFetch(direct: FetchLike, loopback: (() => LoopbackBinding | null | undefined) | null): FetchLike {
  return async (input, init) => {
    const binding = loopback?.();
    if (!binding) return direct(input, init);
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    if (headers.has('authorization')) return direct(input, init);
    if (!cacheableUpstream(method, url)) return direct(input, init);
    const body = init?.body instanceof Uint8Array ? init.body : null;
    if (init?.body && !body) return direct(input, init);
    if (body && body.length > MAX_ROUTED_BODY) return direct(input, init);
    const kind = classify(method, url, body);
    if (!kind) return direct(input, init);
    const proto = headers.get('git-protocol') ?? '';
    const hash = await keyHash(kind, url, proto, body);
    const carry = new Headers({ [H_URL]: url, [H_PROTO]: proto, [H_UA]: headers.get('user-agent') ?? '' });
    if (body) carry.set(H_BODY, toBase64(body));
    const signal = init?.signal ?? undefined;
    if (headers.get('x-ply-cache') === 'bust') {
      const purged = await binding.fetch(new Request(`https://gitcache.internal/v${CACHE_VERSION}/bust/${kind}/${hash}`, { headers: carry, signal, redirect: 'manual' }));
      await purged.body?.cancel().catch(() => {});
    }
    // redirect: 'manual' — a 3xx from upstream must reach the guard above, which re-validates every hop. Followed here,
    // a relative Location would resolve against gitcache.internal and skip that check.
    const res = await binding.fetch(new Request(`https://gitcache.internal${keyPath(kind, hash)}`, { headers: carry, signal, redirect: 'manual' }));
    // The cache tier, in the header ply turns into the `git.response.cache` span attribute.
    const out = new Headers(res.headers);
    out.set('x-ply-pack-cache', res.headers.get('cf-cache-status') ?? 'NONE');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  };
}

export type GitCacheEnv = { PUBLIC_REPOS?: unknown };
export type PurgeCtx = { cache?: { purge?: (opts: { pathPrefixes: string[] }) => Promise<unknown> } };

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': NO_STORE } });
}

/**
 * GitCache's fetch: verify the key binds the carried request, re-check that it is public, fetch upstream (the public
 * namespace's read token is attached here, by withPublicReadCredential), and label the answer.
 */
export async function serveGitCache(req: Request, tokens: TokenSource | null, ctx: PurgeCtx, upstream: FetchLike = (i, n) => fetch(i, n)): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed');
  const path = new URL(req.url).pathname;
  const m = /^\/v(\d+)\/(?:(bust)\/)?(pack|refs|discover)\/([0-9a-f]{64})$/.exec(path);
  if (!m || Number(m[1]) !== CACHE_VERSION) return plain(404, 'not a cache key');
  const bust = m[2] === 'bust';
  const kind = m[3] as CacheKind;
  const url = req.headers.get(H_URL) ?? '';
  const proto = req.headers.get(H_PROTO) ?? '';
  let body: Uint8Array | null = null;
  const b64 = req.headers.get(H_BODY);
  if (b64 !== null) { try { body = fromBase64(b64); } catch { return plain(400, 'bad body'); } }
  const method = kind === 'discover' ? 'GET' : 'POST';
  if (!cacheableUpstream(method, url) || classify(method, url, body) !== kind) return plain(403, 'not a public upload-pack exchange');
  if ((await keyHash(kind, url, proto, body)) !== m[4]) return plain(400, 'key does not match the request');
  if (bust) {
    try { await ctx.cache?.purge?.({ pathPrefixes: [keyPath(kind, m[4] as string)] }); } catch { /* best effort */ }
    return new Response(null, { status: 204, headers: { 'cache-control': NO_STORE } });
  }
  const headers = new Headers({ [VIA_HEADER]: 'gitcache' });
  if (proto) headers.set('git-protocol', proto);
  const ua = req.headers.get(H_UA);
  if (ua) headers.set('user-agent', ua);
  if (body) { headers.set('content-type', 'application/x-git-upload-pack-request'); headers.set('accept', 'application/x-git-upload-pack-result'); }
  const fetchUp = withPublicReadCredential(upstream, tokens);
  const res = await fetchUp(url, { method, headers, body: (body ?? undefined) as BodyInit | undefined, redirect: 'manual', signal: req.signal });
  const ct = res.headers.get('content-type') ?? '';
  const out = new Headers({ 'content-type': ct || 'application/octet-stream', 'x-ply-gc-kind': kind, 'cache-tag': `ply-gc-v${CACHE_VERSION},ply-gc-${kind}` });
  const location = res.headers.get('location');
  if (location) out.set('location', location);
  const ok = res.status === 200 && /^application\/x-git-upload-pack-(result|advertisement)/.test(ct) && res.body;
  if (!ok) {
    // Not stored. An error body is small; scrub it with this isolate's tokens before it leaves (the caller scrubs too,
    // but may be another isolate that never saw this token).
    out.set('cache-control', NO_STORE);
    const text = res.body ? (await res.text()).slice(0, MAX_ERROR_BODY) : '';
    return new Response(res.status >= 300 && res.status < 400 ? null : scrubSecrets(tokens?.secrets() ?? [])(text), { status: res.status, headers: out });
  }
  if (kind === 'pack') {
    // Buffer up to the cap, verify, and only then call it immutable. Over the cap, or unverified: passed on, not stored.
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      parts.push(step.value);
      total += step.value.byteLength;
      if (total > MAX_VERIFIED_PACK) {
        out.set('cache-control', NO_STORE);
        out.set('x-ply-gc-verified', 'too-big');
        const rest = new ReadableStream<Uint8Array>({
          start(c) { for (const p of parts) c.enqueue(p); },
          async pull(c) { const n = await reader.read(); if (n.done) c.close(); else c.enqueue(n.value); },
          cancel(r) { return reader.cancel(r); },
        });
        return new Response(rest, { status: 200, headers: out });
      }
    }
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.byteLength; }
    const v = await verifyPackResponse(url, body as Uint8Array, bytes, ct);
    out.set('cache-control', v.ok ? IMMUTABLE : NO_STORE);
    out.set('x-ply-gc-verified', v.ok ? `ok;objects=${v.objects}` : `failed;${v.reason.replace(/[^\x20-\x7e]/g, '?')}`);
    return new Response(bytes, { status: 200, headers: out });
  }
  if (kind === 'refs') { out.set('cache-control', REFS_CACHE); return new Response(res.body, { status: 200, headers: out }); }
  // discover: buffer the (small) advertisement to tell a v2 capability list from a v0 ref advertisement
  const bytes = new Uint8Array(await res.arrayBuffer());
  out.set('cache-control', /(^|[0-9a-f]{4})version 2\n/.test(latin1(bytes.subarray(0, 128))) ? DISCOVER_V2_CACHE : REFS_CACHE);
  return new Response(bytes, { status: 200, headers: out });
}
