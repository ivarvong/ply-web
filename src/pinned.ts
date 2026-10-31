// Whole responses pinned to a commit, cached as immutable (Workers Caching, cache-enabled `Pinned` entrypoint).
//
// What is cached whole: a response that is a pure function of its URL because it names a commit by its 40-hex oid, on
// a remote whose anonymous answer is public:
//   /v1/tree, /v1/read, /v1/commit   ?remote=<public-v0 repo>&ref=<40-hex>[&path=]   (no Authorization, no trace=1)
//   /view/<host>/<repo>?raw=1&ref|at=<40-hex>&path=<file>                            (public-v0 or a built-in forge)
// Not cached whole: HTML pages (they render times relative to the request and carry that request's own waterfall,
// cf-ray and id; their git parts are already immutable GitCache entries), anything ref-relative, anything traced.
//
// The front door keeps its job: it rate-limits and logs, then asks Pinned for the canonical key
// /v<CACHE_VERSION>/pinned<path>?<allowed params, sorted>. Pinned rebuilds the public request from that key alone (it
// reads no header, so no credential can reach it), marks it internal, and runs the same handler. A non-200 is no-store.
import { CACHE_VERSION } from './cache-version.ts';
import { publicRepoOfRemote } from './public.ts';

const OID = /^[0-9a-f]{40}$/;
export const PINNED_V1 = new Set(['/v1/tree', '/v1/read', '/v1/commit']);
const V1_PARAMS = ['remote', 'ref', 'path'];
const VIEW_PARAMS = ['raw', 'ref', 'at', 'path'];
export const PINNED_ORIGIN = 'https://ply.ivar.workers.dev';
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Requests this isolate built for Pinned. Only code in this module adds to it, so it cannot be forged from outside. */
const INTERNAL = new WeakSet<Request>();
export const isInternal = (req: Request) => INTERNAL.has(req);

function sorted(url: URL, allowed: string[]): string | null {
  const out = new URLSearchParams();
  for (const [k] of url.searchParams) if (!allowed.includes(k)) return null;
  for (const k of allowed) {
    const all = url.searchParams.getAll(k);
    if (all.length > 1) return null;
    if (all.length === 1) out.set(k, all[0] as string);
  }
  return out.toString();
}

/** The cache key for a /v1 read that may be cached whole, or null. */
export function pinnedV1Key(url: URL, method: string): string | null {
  if (method !== 'GET' || !PINNED_V1.has(url.pathname)) return null;
  if (!OID.test(url.searchParams.get('ref') ?? '')) return null;
  if (publicRepoOfRemote(url.searchParams.get('remote') ?? '') === null) return null;
  const q = sorted(url, V1_PARAMS);
  return q === null ? null : `/v${CACHE_VERSION}/pinned${url.pathname}?${q}`;
}

/** The cache key for a viewer raw file at a pinned commit, or null. `isPublicLoc` is the viewer's own route check. */
export function pinnedViewKey(url: URL, method: string, isPublicLoc: (url: URL) => boolean): string | null {
  if ((method !== 'GET' && method !== 'HEAD') || !url.pathname.startsWith('/view/')) return null;
  if (url.searchParams.get('raw') !== '1' || !url.searchParams.get('path')) return null;
  const at = url.searchParams.get('at') || url.searchParams.get('ref') || '';
  if (!OID.test(at)) return null;
  if (url.searchParams.get('at') && url.searchParams.get('ref') && url.searchParams.get('at') !== url.searchParams.get('ref')) return null;
  if (!isPublicLoc(url)) return null;
  const q = sorted(url, VIEW_PARAMS);
  return q === null ? null : `/v${CACHE_VERSION}/pinned${url.pathname}?${q}`;
}

/** Pinned: the internal request a key stands for, or null when the key is not one we issue. */
export function requestForKey(path: string, isPublicLoc: (url: URL) => boolean): Request | null {
  const prefix = `/v${CACHE_VERSION}/pinned`;
  if (!path.startsWith(prefix)) return null;
  const url = new URL(path.slice(prefix.length), PINNED_ORIGIN);
  const key = pinnedV1Key(url, 'GET') ?? pinnedViewKey(url, 'GET', isPublicLoc);
  if (key !== path) return null;
  const req = new Request(url.href, { method: 'GET' });
  INTERNAL.add(req);
  return req;
}

/** Pinned's answer: the handler's response, immutable when it is a 200, never carrying the fill's per-request headers. */
export function asPinned(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const h of ['x-ply-request-id', 'x-ply-trace', 'server-timing', 'set-cookie']) headers.delete(h);
  headers.set('cache-control', res.status === 200 ? IMMUTABLE : 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export type PinnedBinding = { fetch(req: Request): Promise<Response> };

/** Front door: fetch the key from Pinned and label it. */
export async function viaPinned(binding: PinnedBinding, key: string): Promise<Response> {
  const res = await binding.fetch(new Request(`https://pinned.internal${key}`, { redirect: 'manual' }));
  const headers = new Headers(res.headers);
  headers.set('x-ply-pinned-cache', res.headers.get('cf-cache-status') ?? 'NONE');
  headers.delete('cf-cache-status');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
