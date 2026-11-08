// Content-addressed Workers Caching graph (never caches.default).
//
// Layers (all keyed by ctx.props.scope + path under /v${CACHE_VERSION}/):
//   RefCache        — ref → commit oid (ONLY mutable; short TTL + purge-on-write)
//   CommitCache     — commit oid → parsed commit (immutable)
//   TreeCache       — tree oid → listing (immutable)
//   ResolvePathCache— (commit oid, path) → {blob,mode} via Commit+Tree (immutable)
//   ObjectCache     — blob oid → verified inflated bytes (immutable)
//
// Auth stays on the default entrypoint. Named entrypoints are not internet-routable.
// Docs: developers.cloudflare.com/workers/cache/ examples + cache-keys (ctx.props isolation).
import {
  BLOB_CACHE_HEADER,
  BLOB_CACHE_MAX_AGE_SECONDS,
  BLOB_CACHE_MAX_BYTES,
  BLOB_OID_HEADER,
  TYPE,
  commitView,
  createTransport,
  fetchObject,
  lsRefs,
  openBlob,
  parseTree,
  readBlob,
  refCandidates,
  validatePath,
} from 'ply';
import { captureGroup, chainGet, dig, header } from './absent.ts';
import { CACHE_VERSION } from './cache-version.ts';
import { API_LIMITS } from './limits.ts';
import { unwrapOr } from './option.ts';
import { withPublicReadCredential, type TokenSource } from './public.ts';
import { quirksFor } from './quirks.ts';
import {
  applyUpstreamHeaders,
  createRayLog,
  observeUpstream,
  RAY_HEADER,
  type RayLog,
} from './rays.ts';
import { checkRemote, createGuardedFetch, redirectOptions } from './remote.ts';

export { BLOB_CACHE_HEADER, BLOB_CACHE_MAX_AGE_SECONDS, BLOB_CACHE_MAX_BYTES, BLOB_OID_HEADER };

/** Dated 2026-11-08: object/tree/commit/resolve TTL (REPORT-blob-cache / REPORT-workers-cache). */
export const CAS_IMMUTABLE = `public, max-age=${BLOB_CACHE_MAX_AGE_SECONDS}, immutable`;
/**
 * Ref layer: max-age=0 must-revalidate (2026-11-08).
 * SWR previously served pre-write tips after a missed purge (CD commit-fresh).
 * Concurrent misses still collapse; every response revalidates through RefCache.
 * purgeEverything on write remains the primary invalidation.
 */
export const REF_SWR_S = 0;
export const REF_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
export const NO_STORE = 'no-store';

/** Upstream Authorization value; must NOT be named Authorization (triggers BYPASS). */
export const CAS_AUTH_HEADER = 'x-ply-cas-authorization';
export const CAS_ORIGIN = 'https://cas.internal';

export type CasProps = { readonly scope: string };

/** ctx.exports.<Entrypoint> is callable with { props } then .fetch (LoopbackServiceStub). */
export type CasBinding = {
  (opts: { readonly props: CasProps }): { fetch(input: RequestInfo | URL): Promise<Response> };
};

export type CasLayer = 'ref' | 'commit' | 'tree' | 'resolve' | 'object';

const OID_RE = /^[0-9a-f]{40}$/;

export function layerHeader(layer: CasLayer): string {
  return `x-ply-cache-${layer}`;
}

export function casPath(layer: CasLayer, rest: string, version: number = CACHE_VERSION): string {
  return `/v${version}/${layer}/${rest}`;
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': NO_STORE },
  });
}

/** Map ply fetch errors: not_found and upload-pack not_our_ref → 404; else 502. */
function upstreamStatus(error: unknown): number {
  const code = chainGet(error, 'code');
  if (code.tag === 'some' && code.value === 'not_found') return 404;
  if (code.tag === 'some' && code.value === 'remote_error') {
    const reason = chainGet(error, 'reason');
    if (reason.tag === 'some' && reason.value === 'not_our_ref') return 404;
  }
  if (code.tag === 'some' && code.value === 'http') {
    const status = chainGet(error, 'status');
    if (status.tag === 'some' && status.value === 404) return 404;
  }
  return 502;
}

function ifNoneMatchHits(inm: string | null, etag: string): boolean {
  if (inm === null || etag === '') return false;
  if (inm.trim() === '*') return false;
  const want = etag.startsWith('"') ? etag : `"${etag}"`;
  for (const part of inm.split(',')) {
    const raw = part.trim();
    if (raw === '') continue;
    const tag = raw.startsWith('W/') ? raw.slice(2).trim() : raw;
    if (tag === want) return true;
  }
  return false;
}


function jsonOk(body: unknown, cacheControl: string, etag: string | null, layer: CasLayer, extra: HeadersInit = {}): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheControl,
    ...Object.fromEntries(new Headers(extra)),
  });
  if (etag !== null) headers.set('etag', `"${etag}"`);
  headers.set('cache-tag', `ply-cas-v${CACHE_VERSION},ply-cas-${layer}${etag ? `,ply-cas-${layer}-${etag}` : ''}`);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

export function parseScope(props: CasProps): { readonly scope: string } | Response {
  const scope = typeof props.scope === 'string' ? props.scope : '';
  if (scope === '') return plain(400, 'missing scope');
  let url: URL;
  try {
    url = new URL(scope);
  } catch {
    return plain(400, 'bad scope');
  }
  if (url.username || url.password) return plain(400, 'scope must be credential-free');
  return { scope };
}

function authorizationFrom(req: Request): { readonly header: string } | null {
  const raw = req.headers.get(CAS_AUTH_HEADER);
  if (raw === null || raw === '') return null;
  if (!/^[\t\x20-\x7e]+$/.test(raw)) return null;
  return { header: raw };
}

export function gitAuthorizationValue(auth: unknown): string | null {
  if (auth === null || typeof auth !== 'object') return null;
  const headerField = chainGet(auth, 'header');
  if (headerField.tag === 'some' && typeof headerField.value === 'string' && headerField.value !== '') return headerField.value;
  const bearer = chainGet(auth, 'bearer');
  if (bearer.tag === 'some' && typeof bearer.value === 'string' && bearer.value !== '') return `Bearer ${bearer.value}`;
  const token = chainGet(auth, 'token');
  const user = chainGet(auth, 'user');
  if (token.tag === 'some' && typeof token.value === 'string' && token.value !== '') {
    if (user.tag === 'some' && typeof user.value === 'string' && user.value !== '') {
      return `Basic ${btoa(`${user.value}:${token.value}`)}`;
    }
    return `Bearer ${token.value}`;
  }
  return null;
}

type PlyTransport = ReturnType<typeof createTransport> extends { ok: true; value: infer T } | { ok: false } ? T : never;
export type TransportResult =
  | { readonly ok: true; readonly value: PlyTransport; readonly rays: RayLog; readonly started: number }
  | { readonly ok: false; readonly response: Response };

export function allowOriginsFromEnv(env: object): readonly string[] {
  const field = chainGet(env, 'ALLOW_REMOTE_ORIGINS');
  const raw = field.tag === 'some' && typeof field.value === 'string' ? field.value : '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Merge `x-artifacts-ray` values from CAS layer responses (fill rays).
 * On a Workers Cache HIT the entrypoint does not run; the stored fill rays ride on the cached response.
 */
export function mergeRayHeaderValues(...values: Array<string | null>): string {
  const parts: string[] = [];
  for (const value of values) {
    if (value === null || value === '') continue;
    for (const part of value.split(', ')) {
      if (part !== '') parts.push(part);
    }
  }
  return parts.join(', ');
}

function stampFillRays(res: Response, rays: RayLog, started: number): Response {
  applyUpstreamHeaders(res.headers, rays.report(), Date.now() - started);
  return res;
}

export function transportFor(req: Request, scope: string, tokens: TokenSource | null, allow: readonly string[] = []): TransportResult {
  const auth = authorizationFrom(req);
  let remote;
  try {
    remote = checkRemote(scope, allow);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, response: plain(400, msg) };
  }
  const rays = createRayLog();
  const direct = withPublicReadCredential(globalThis.fetch.bind(globalThis), tokens);
  const fetchImpl = observeUpstream(createGuardedFetch(direct, remote, allow), rays);
  const transport = createTransport(remote.href, {
    ...(auth === null ? {} : { auth }),
    fetchImpl,
    limits: API_LIMITS,
    quirks: quirksFor(remote.origin),
    ...redirectOptions(remote, allow),
  });
  if (!transport.ok) return { ok: false, response: plain(400, transport.error.message) };
  return { ok: true, value: transport.value, rays, started: Date.now() };
}

/** Stamp Cf-Cache-Status onto x-ply-cache-<layer> for the front door / spans. */
export async function viaCas(
  binding: CasBinding,
  layer: CasLayer,
  pathRest: string,
  scope: string,
  gitAuthorization: string | null,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.delete('authorization');
  headers.delete('Authorization');
  if (gitAuthorization !== null && gitAuthorization !== '') headers.set(CAS_AUTH_HEADER, gitAuthorization);
  // LoopbackServiceStub: binding({ props }).fetch(req) — props land on the callee's ctx.props (cache key).
  const res = await binding({ props: { scope } }).fetch(
    new Request(`${CAS_ORIGIN}${casPath(layer, pathRest)}`, { ...init, headers, redirect: 'manual' }),
  );
  const out = new Headers(res.headers);
  out.set(layerHeader(layer), unwrapOr(header(res.headers, 'cf-cache-status'), unwrapOr(header(res.headers, layerHeader(layer)), 'NONE')));
  out.delete('cf-cache-status');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

export function splitFilePath(path: string): { readonly parent: string; readonly name: string } | null {
  if (typeof path !== 'string' || path === '' || path === '/' || path.includes('\0')) return null;
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return null;
  const slash = trimmed.lastIndexOf('/');
  if (slash === -1) return { parent: '', name: trimmed };
  return { parent: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
}

export function isBlobEntry(entry: { readonly type: string }): boolean {
  return entry.type === 'blob';
}

// ── path parsers ────────────────────────────────────────────────────────────

export function parseObjectPath(pathname: string): string | null {
  const m = /^\/v(\d+)\/object\/([0-9a-f]{40})$/.exec(pathname);
  const version = captureGroup(m, 1);
  const oid = captureGroup(m, 2);
  if (version.tag === 'none' || oid.tag === 'none' || Number(version.value) !== CACHE_VERSION) return null;
  return oid.value;
}

export function parseTreePath(pathname: string): string | null {
  const m = /^\/v(\d+)\/tree\/([0-9a-f]{40})$/.exec(pathname);
  const version = captureGroup(m, 1);
  const oid = captureGroup(m, 2);
  if (version.tag === 'none' || oid.tag === 'none' || Number(version.value) !== CACHE_VERSION) return null;
  return oid.value;
}

export function parseCommitPath(pathname: string): string | null {
  const m = /^\/v(\d+)\/commit\/([0-9a-f]{40})$/.exec(pathname);
  const version = captureGroup(m, 1);
  const oid = captureGroup(m, 2);
  if (version.tag === 'none' || oid.tag === 'none' || Number(version.value) !== CACHE_VERSION) return null;
  return oid.value;
}

export function parseResolvePath(pathname: string): { readonly commit: string; readonly path: string } | null {
  const m = /^\/v(\d+)\/resolve\/([0-9a-f]{40})(\/(.*))?$/.exec(pathname);
  const version = captureGroup(m, 1);
  const commit = captureGroup(m, 2);
  if (version.tag === 'none' || commit.tag === 'none' || Number(version.value) !== CACHE_VERSION) return null;
  const rest = captureGroup(m, 4);
  let path = '';
  if (rest.tag === 'some') {
    try {
      path = decodeURIComponent(rest.value);
    } catch {
      return null;
    }
  }
  return { commit: commit.value, path };
}

export function parseRefPath(pathname: string): string | null {
  const m = /^\/v(\d+)\/ref\/(.+)$/.exec(pathname);
  const version = captureGroup(m, 1);
  const ref = captureGroup(m, 2);
  if (version.tag === 'none' || ref.tag === 'none' || Number(version.value) !== CACHE_VERSION) return null;
  try {
    return decodeURIComponent(ref.value);
  } catch {
    return null;
  }
}

export function encodeRefPath(ref: string): string {
  return encodeURIComponent(ref);
}

export function encodeResolveRest(commit: string, path: string): string {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return commit;
  return `${commit}/${trimmed.split('/').map(encodeURIComponent).join('/')}`;
}

// ── serve layers ────────────────────────────────────────────────────────────

export async function serveObject(req: Request, props: CasProps, tokens: TokenSource | null, allow: readonly string[] = []): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed');
  const oid = parseObjectPath(new URL(req.url).pathname);
  if (oid === null) return plain(404, 'not an object key');
  const scoped = parseScope(props);
  if (scoped instanceof Response) return scoped;
  const t = transportFor(req, scoped.scope, tokens, allow);
  if (!t.ok) return t.response;

  const buffered = await readBlob(t.value, oid, { maxBytes: BLOB_CACHE_MAX_BYTES });
  if (!buffered.ok) {
    return stampFillRays(plain(upstreamStatus(buffered.error), buffered.error.message), t.rays, t.started);
  }
  if (buffered.value.kind === 'too_big') {
    const opened = await openBlob(t.value, oid);
    if (!opened.ok) return stampFillRays(plain(502, opened.error.message), t.rays, t.started);
    if (opened.value.kind !== 'stream') return stampFillRays(plain(502, 'unexpected blob kind'), t.rays, t.started);
    const headers = new Headers({
      'content-type': 'application/octet-stream',
      'cache-control': NO_STORE,
      'content-length': String(opened.value.size),
      'x-ply-size': String(opened.value.size),
      [BLOB_OID_HEADER]: oid,
      etag: `"${oid}"`,
      [BLOB_CACHE_HEADER]: 'BYPASS',
      [layerHeader('object')]: 'BYPASS',
    });
    return stampFillRays(new Response(opened.value.stream, { status: 200, headers }), t.rays, t.started);
  }
  const data = buffered.value.data;
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'cache-control': CAS_IMMUTABLE,
    'content-length': String(data.byteLength),
    'x-ply-size': String(data.byteLength),
    [BLOB_OID_HEADER]: oid,
    etag: `"${oid}"`,
    'cache-tag': `ply-cas-v${CACHE_VERSION},ply-cas-object,ply-cas-object-${oid}`,
  });
  if (ifNoneMatchHits(req.headers.get('if-none-match'), `"${oid}"`)) {
    headers.delete('content-length');
    return stampFillRays(new Response(null, { status: 304, headers }), t.rays, t.started);
  }
  return stampFillRays(new Response(data, { status: 200, headers }), t.rays, t.started);
}

export async function serveTree(req: Request, props: CasProps, tokens: TokenSource | null, allow: readonly string[] = []): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed');
  const oid = parseTreePath(new URL(req.url).pathname);
  if (oid === null) return plain(404, 'not a tree key');
  const scoped = parseScope(props);
  if (scoped instanceof Response) return scoped;
  const t = transportFor(req, scoped.scope, tokens, allow);
  if (!t.ok) return t.response;

  const fetched = await fetchObject(t.value, { oid, expectType: TYPE.TREE });
  if (!fetched.ok) {
    return stampFillRays(plain(upstreamStatus(fetched.error), fetched.error.message), t.rays, t.started);
  }
  if (fetched.value.type !== TYPE.TREE) return stampFillRays(plain(502, 'not a tree'), t.rays, t.started);
  const parsed = parseTree(fetched.value.data);
  if (!parsed.ok) return stampFillRays(plain(502, parsed.error.message), t.rays, t.started);
  const entries = parsed.value.map(e => ({
    name: e.name,
    mode: e.mode.padStart(6, '0'),
    oid: e.oid,
    type: e.mode === '40000' ? 'tree' : e.mode === '160000' ? 'commit' : 'blob',
  }));
  return stampFillRays(jsonOk({ tree: oid, entries }, CAS_IMMUTABLE, oid, 'tree'), t.rays, t.started);
}

export async function serveCommit(req: Request, props: CasProps, tokens: TokenSource | null, allow: readonly string[] = []): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed');
  const oid = parseCommitPath(new URL(req.url).pathname);
  if (oid === null) return plain(404, 'not a commit key');
  const scoped = parseScope(props);
  if (scoped instanceof Response) return scoped;
  const t = transportFor(req, scoped.scope, tokens, allow);
  if (!t.ok) return t.response;

  const fetched = await fetchObject(t.value, { oid, expectType: TYPE.COMMIT });
  if (!fetched.ok) {
    return stampFillRays(plain(upstreamStatus(fetched.error), fetched.error.message), t.rays, t.started);
  }
  if (fetched.value.type !== TYPE.COMMIT) return stampFillRays(plain(404, `${oid} is not a commit`), t.rays, t.started);
  const viewed = commitView(fetched.value.data);
  if (!viewed.ok) return stampFillRays(plain(502, viewed.error.message), t.rays, t.started);
  const view = viewed.value;
  return stampFillRays(
    jsonOk(
      {
        oid,
        tree: view.tree,
        parents: view.parents,
        author: view.author,
        committer: view.committer,
        message: view.message,
        signed: view.signed,
      },
      CAS_IMMUTABLE,
      oid,
      'commit',
    ),
    t.rays,
    t.started,
  );
}

export type TreeLoopback = (treeOid: string, scope: string, auth: string | null) => Promise<Response>;
export type CommitLoopback = (commitOid: string, scope: string, auth: string | null) => Promise<Response>;

/**
 * Resolve (commit, path) → blob|tree entry by walking TreeCache per segment so shared prefixes hit.
 */
function withMergedRays(res: Response, rayParts: string[]): Response {
  const merged = mergeRayHeaderValues(...rayParts);
  if (merged !== '') res.headers.set(RAY_HEADER, merged);
  return res;
}

export async function serveResolve(
  req: Request,
  props: CasProps,
  _tokens: TokenSource | null,
  loop: { readonly tree: TreeLoopback; readonly commit: CommitLoopback },
  _allow: readonly string[] = [],
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed');
  const parsed = parseResolvePath(new URL(req.url).pathname);
  if (parsed === null) return plain(404, 'not a resolve key');
  const scoped = parseScope(props);
  if (scoped instanceof Response) return scoped;
  const auth = req.headers.get(CAS_AUTH_HEADER);
  const rayParts: string[] = [];

  const commitRes = await loop.commit(parsed.commit, scoped.scope, auth);
  rayParts.push(unwrapOr(header(commitRes.headers, RAY_HEADER), ''));
  if (commitRes.status !== 200) {
    const text = await commitRes.text().catch(() => '');
    return withMergedRays(plain(commitRes.status, text || 'commit resolve failed'), rayParts);
  }
  const commitRaw = await commitRes.json();
  const treeField = chainGet(commitRaw, 'tree');
  if (treeField.tag === 'none' || typeof treeField.value !== 'string' || !OID_RE.test(treeField.value)) {
    return withMergedRays(plain(502, 'commit missing tree'), rayParts);
  }
  const commitTree = treeField.value;

  const segments = parsed.path === '' ? [] : parsed.path.split('/').filter(s => s.length > 0);
  let treeOid = commitTree;
  let mode = '040000';
  let oid = treeOid;
  let type: 'tree' | 'blob' | 'commit' = 'tree';

  for (let i = 0; i < segments.length; i++) {
    const treeRes = await loop.tree(treeOid, scoped.scope, auth);
    rayParts.push(unwrapOr(header(treeRes.headers, RAY_HEADER), ''));
    if (treeRes.status !== 200) {
      const text = await treeRes.text().catch(() => '');
      return withMergedRays(plain(treeRes.status, text || 'tree resolve failed'), rayParts);
    }
    const listingRaw = await treeRes.json();
    const entriesField = chainGet(listingRaw, 'entries');
    const entries = entriesField.tag === 'some' && Array.isArray(entriesField.value) ? entriesField.value : [];
    const entry = entries.find((e: { name: string }) => e.name === segments[i]) as { name: string; mode: string; oid: string; type: string } | null;
    if (entry === null || entry === void 0) {
      return withMergedRays(plain(404, `${segments.slice(0, i + 1).join('/')} not found`), rayParts);
    }
    oid = entry.oid;
    mode = entry.mode;
    type = entry.type === 'tree' ? 'tree' : entry.type === 'commit' ? 'commit' : 'blob';
    if (i < segments.length - 1) {
      if (type !== 'tree') {
        return withMergedRays(plain(404, `${segments.slice(0, i + 1).join('/')} is not a tree`), rayParts);
      }
      treeOid = oid;
    }
  }

  return withMergedRays(
    jsonOk(
      { commit: parsed.commit, path: parsed.path, oid, mode, type, tree: commitTree },
      CAS_IMMUTABLE,
      `${parsed.commit}:${parsed.path}`,
      'resolve',
    ),
    rayParts,
  );
}

export async function serveRef(req: Request, props: CasProps, tokens: TokenSource | null, allow: readonly string[] = []): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed');
  const ref = parseRefPath(new URL(req.url).pathname);
  if (ref === null) return plain(404, 'not a ref key');
  const scoped = parseScope(props);
  if (scoped instanceof Response) return scoped;
  const t = transportFor(req, scoped.scope, tokens, allow);
  if (!t.ok) return t.response;

  // Full oid: immutable tip; still cache briefly under the ref key (caller may also skip RefCache).
  if (OID_RE.test(ref)) {
    return stampFillRays(
      jsonOk({ ref, commit: ref, unborn: false }, REF_CACHE_CONTROL, ref, 'ref', {
        'cache-tag': `ply-cas-v${CACHE_VERSION},ply-cas-ref,ply-cas-ref-${ref.slice(0, 12)}`,
      }),
      t.rays,
      t.started,
    );
  }
  const cands = refCandidates(ref === '' ? null : ref);
  if (!cands.ok) return stampFillRays(plain(400, cands.error.message), t.rays, t.started);
  const prefixes = cands.value.length > 0 ? [...cands.value, 'HEAD'] : ['HEAD'];
  const listed = await lsRefs(t.value, prefixes, { unborn: true });
  if (!listed.ok) return stampFillRays(plain(upstreamStatus(listed.error), listed.error.message), t.rays, t.started);
  const refs = listed.value.refs;
  const unborn = listed.value.unborn;

  // Unborn HEAD / default branch: empty-repo body.
  if (unborn !== null) {
    const target = unborn.target;
    const askingUnborn =
      cands.value.includes('HEAD') ||
      cands.value.includes(target) ||
      ref === 'HEAD' ||
      ref === '' ||
      ref === target ||
      (target.startsWith('refs/heads/') && (ref === target.slice('refs/heads/'.length) || ref === 'main'));
    if (askingUnborn) {
      // Never cache unborn: the next write births the ref; a HIT would 404 tree/read until TTL.
      return stampFillRays(jsonOk({ ref: target, commit: null, unborn: true }, NO_STORE, null, 'ref'), t.rays, t.started);
    }
  }

  // First candidate that ls-refs returned wins (tags before branches, matching git / refCandidates order).
  let hitName: string | null = null;
  let hitOid: string | null = null;
  for (const name of cands.value) {
    const entry = refs.get(name);
    if (entry === void 0) continue;
    hitName = name;
    hitOid = entry.peeled !== null ? entry.peeled : entry.oid;
    break;
  }
  if (hitName === null && cands.value.includes('HEAD')) {
    const headName = listed.value.head;
    if (headName !== null && refs.has(headName)) {
      const entry = refs.get(headName);
      if (entry !== void 0) {
        hitName = headName;
        hitOid = entry.peeled !== null ? entry.peeled : entry.oid;
      }
    }
    const headEntry = refs.get('HEAD');
    if (hitName === null && headEntry !== void 0) {
      hitName = headName !== null ? headName : 'HEAD';
      hitOid = headEntry.peeled !== null ? headEntry.peeled : headEntry.oid;
    }
  }
  if (hitName === null || hitOid === null) return stampFillRays(plain(404, `ref ${ref} not found`), t.rays, t.started);
  if (!OID_RE.test(hitOid)) return stampFillRays(plain(502, 'bad commit oid from ls-refs'), t.rays, t.started);
  // Present the symref target when the caller asked for HEAD (matches readCommit).
  const presented = hitName === 'HEAD' && listed.value.head !== null ? listed.value.head : hitName;
  return stampFillRays(
    jsonOk({ ref: presented, commit: hitOid, unborn: false }, REF_CACHE_CONTROL, hitOid, 'ref', {
      'cache-tag': `ply-cas-v${CACHE_VERSION},ply-cas-ref,ply-cas-ref-${hitOid.slice(0, 12)}`,
    }),
    t.rays,
    t.started,
  );
}

/**
 * Purge every RefCache entry after a write. RefCache stores only mutable tips; purgeEverything
 * is scoped to this entrypoint (docs), so it clears all scopes' ref tips without touching
 * Object/Tree/Commit. Tags + pathPrefixes alone still left stale HIT+SWR tips in CD (74c7519).
 */
export const REF_PATH_PREFIX = `/v${CACHE_VERSION}/ref/`;
export async function purgeRefTags(ctx: object, _tags: string[]): Promise<{ ok: boolean; ms: number; error: string }> {
  const t0 = Date.now();
  const cacheField = dig(ctx, ['cache']);
  if (cacheField.tag === 'none' || cacheField.value === null) return { ok: false, ms: 0, error: 'no ctx.cache' };
  // Must call as a method: extracting purge and invoking unbound throws
  // "Illegal invocation" on Workers Cache (CD 2026-11-08 root-create 503).
  const cache = cacheField.value as { purge(opts: { purgeEverything: true }): Promise<unknown> };
  const purgeField = chainGet(cache, 'purge');
  if (purgeField.tag === 'none' || typeof purgeField.value !== 'function') return { ok: false, ms: 0, error: 'no purge' };
  try {
    // Method call keeps `this` = cache (unbound extract → Illegal invocation on Workers Cache).
    const result = await cache.purge({ purgeEverything: true });
    const success = chainGet(result, 'success');
    if (success.tag === 'some' && success.value === false) {
      const errors = chainGet(result, 'errors');
      return { ok: false, ms: Date.now() - t0, error: JSON.stringify(errors.tag === 'some' ? errors.value : null).slice(0, 200) };
    }
    return { ok: true, ms: Date.now() - t0, error: '' };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

export type CasExports = {
  readonly RefCache: CasBinding | null;
  readonly CommitCache: CasBinding | null;
  readonly TreeCache: CasBinding | null;
  readonly ResolvePathCache: CasBinding | null;
  readonly ObjectCache: CasBinding | null;
};

/** Minimal ply Tracer surface used for per-layer cache-status spans. */
export type CasSpan = { set(attrs: Record<string, string | number | boolean>): unknown; ok(): unknown };
export type CasTracer = {
  span<T>(name: string, opts: { attrs: Record<string, string | number | boolean> }, fn: (s: CasSpan) => T | PromiseLike<T>): Promise<T>;
};

export type ComposeWant = 'blob' | 'tree' | 'commit';

export type ComposeInput = {
  readonly remote: string;
  readonly ref: string | null;
  readonly path: string | null;
  readonly authHeader: string | null;
  readonly exports: CasExports;
  readonly want: ComposeWant;
  /** When true, skip Workers Cache and return null so the caller uses direct ply. */
  readonly bypass: boolean;
  readonly tracer: CasTracer | null;
};

async function viaCasSpan(
  tracer: CasTracer | null,
  binding: CasBinding,
  layer: CasLayer,
  pathRest: string,
  scope: string,
  auth: string | null,
): Promise<Response> {
  const run = () => viaCas(binding, layer, pathRest, scope, auth);
  if (tracer === null) return run();
  return tracer.span(`ply.cas.${layer}`, { attrs: { 'ply.cas.layer': layer } }, async span => {
    const res = await run();
    const status = unwrapOr(header(res.headers, layerHeader(layer)), 'NONE');
    span.set({ 'ply.cas.cache': status, 'http.status_code': res.status });
    if (res.status >= 400) span.set({ 'ply.cas.error': true });
    else span.ok();
    return res;
  });
}

/**
 * Auth already ran. Compose Ref → (Commit | Resolve → Object/Tree).
 * Returns layer cache statuses for telemetry.
 */
export async function composeCasGraph(input: ComposeInput): Promise<
  | {
      readonly ok: true;
      readonly kind: 'blob';
      readonly stream: ReadableStream<Uint8Array>;
      readonly size: number;
      readonly meta: { ref: string; commit: string; blob: string; mode: string; etag: string };
      readonly cache: Record<string, string>;
    }
  | {
      readonly ok: true;
      readonly kind: 'tree';
      readonly body: { ref: string; commit: string; tree: string; entries: unknown };
      readonly cache: Record<string, string>;
    }
  | {
      readonly ok: true;
      readonly kind: 'commit';
      readonly body: Record<string, unknown>;
      readonly cache: Record<string, string>;
    }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string; readonly cache: Record<string, string> }
> {
  const cache: Record<string, string> = {};
  const rayParts: string[] = [];
  const takeRays = (res: Response) => {
    rayParts.push(unwrapOr(header(res.headers, RAY_HEADER), ''));
  };
  const withRays = <T extends { readonly cache: Record<string, string> }>(out: T): T => {
    const merged = mergeRayHeaderValues(...rayParts);
    if (merged !== '') out.cache[RAY_HEADER] = merged;
    return out;
  };
  const fail = (status: number, code: string, message: string) =>
    withRays({ ok: false as const, status, code, message, cache });
  if (input.bypass || input.exports.RefCache === null) {
    return fail(501, 'bad_request', 'cas bypass');
  }
  const refName = input.ref === null || input.ref === '' ? 'HEAD' : input.ref;
  let commitOid: string;
  let presentedRef: string;
  if (OID_RE.test(refName)) {
    // Content-addressed tip: skip mutable RefCache.
    cache[layerHeader('ref')] = 'BYPASS';
    commitOid = refName;
    presentedRef = refName;
  } else {
    const refRes = await viaCasSpan(input.tracer, input.exports.RefCache, 'ref', encodeRefPath(refName), input.remote, input.authHeader);
    cache[layerHeader('ref')] = unwrapOr(header(refRes.headers, layerHeader('ref')), 'NONE');
    takeRays(refRes);
    if (refRes.status !== 200) {
      const text = await refRes.text().catch(() => '');
      if (refRes.status === 404) return fail(404, 'not_found', text || 'ref resolve failed');
      if (refRes.status === 400) return fail(400, 'bad_request', text || 'bad ref');
      return fail(502, 'upstream_5xx', text || 'ref resolve failed');
    }
    const refRaw = await refRes.json();
    const unbornField = chainGet(refRaw, 'unborn');
    const commitField = chainGet(refRaw, 'commit');
    const refField = chainGet(refRaw, 'ref');
    const unborn = unbornField.tag === 'some' && unbornField.value === true;
    const commitOidVal = commitField.tag === 'some' && typeof commitField.value === 'string' ? commitField.value : null;
    const refVal = refField.tag === 'some' && typeof refField.value === 'string' ? refField.value : refName;
    if (unborn || commitOidVal === null) {
      if (input.want === 'commit') {
        return withRays({
          ok: true as const,
          kind: 'commit' as const,
          body: { empty: true, ref: refVal === '' ? 'refs/heads/main' : refVal, oid: null, tree: null, parents: [], author: null, committer: null, message: null, signed: false },
          cache,
        });
      }
      return fail(404, 'not_found', 'empty repository');
    }
    commitOid = commitOidVal;
    presentedRef = refVal;
  }

  if (input.want === 'commit') {
    if (input.exports.CommitCache === null) return fail(501, 'bad_request', 'no CommitCache');
    const cRes = await viaCasSpan(input.tracer, input.exports.CommitCache, 'commit', commitOid, input.remote, input.authHeader);
    cache[layerHeader('commit')] = unwrapOr(header(cRes.headers, layerHeader('commit')), 'NONE');
    takeRays(cRes);
    if (cRes.status !== 200) {
      const text = await cRes.text().catch(() => '');
      const code = cRes.status === 404 ? 'not_found' : cRes.status === 400 ? 'bad_request' : 'upstream_5xx';
      return fail(cRes.status === 404 || cRes.status === 400 ? cRes.status : 502, code, text || 'commit cache failed');
    }
    const body = (await cRes.json()) as Record<string, unknown>;
    return withRays({ ok: true as const, kind: 'commit' as const, body: { ...body, ref: presentedRef }, cache });
  }

  if (input.exports.ResolvePathCache === null) return fail(501, 'bad_request', 'no ResolvePathCache');
  const path = input.path === null ? '' : input.path;
  if (path !== '') {
    const checked = validatePath(path);
    if (!checked.ok) return fail(400, 'bad_request', checked.error.message);
  }
  const resolveRes = await viaCasSpan(
    input.tracer,
    input.exports.ResolvePathCache,
    'resolve',
    encodeResolveRest(commitOid, path),
    input.remote,
    input.authHeader,
  );
  cache[layerHeader('resolve')] = unwrapOr(header(resolveRes.headers, layerHeader('resolve')), 'NONE');
  takeRays(resolveRes);
  // Nested commit/tree statuses are not automatically visible; resolve span covers the walk.
  if (resolveRes.status !== 200) {
    const text = await resolveRes.text().catch(() => '');
    const code = resolveRes.status === 404 ? 'not_found' : 'upstream_5xx';
    return fail(resolveRes.status, code, text || 'path resolve failed');
  }
  const resolved = (await resolveRes.json()) as { oid: string; mode: string; type: string; tree: string; path: string };

  if (input.want === 'tree') {
    if (resolved.type !== 'tree' && path !== '') {
      return fail(400, 'bad_request', `${path} is not a directory`);
    }
    const treeOid = path === '' ? resolved.tree : resolved.oid;
    if (input.exports.TreeCache === null) return fail(501, 'bad_request', 'no TreeCache');
    const tRes = await viaCasSpan(input.tracer, input.exports.TreeCache, 'tree', treeOid, input.remote, input.authHeader);
    cache[layerHeader('tree')] = unwrapOr(header(tRes.headers, layerHeader('tree')), 'NONE');
    takeRays(tRes);
    if (tRes.status !== 200) {
      const text = await tRes.text().catch(() => '');
      return fail(tRes.status, 'upstream_5xx', text || 'tree cache failed');
    }
    const listing = (await tRes.json()) as { tree: string; entries: unknown };
    return withRays({
      ok: true as const,
      kind: 'tree' as const,
      body: { ref: presentedRef, commit: commitOid, tree: listing.tree, entries: listing.entries },
      cache,
    });
  }

  // blob
  if (resolved.type === 'tree') {
    return fail(400, 'bad_request', `${path} is a directory`);
  }
  if (resolved.type === 'commit') {
    return fail(404, 'not_found', `${path} is a submodule (commit ${resolved.oid})`);
  }
  if (input.exports.ObjectCache === null) return fail(501, 'bad_request', 'no ObjectCache');
  const oRes = await viaCasSpan(input.tracer, input.exports.ObjectCache, 'object', resolved.oid, input.remote, input.authHeader);
  const objectStatus = unwrapOr(header(oRes.headers, layerHeader('object')), 'NONE');
  cache[layerHeader('object')] = objectStatus;
  cache[BLOB_CACHE_HEADER] = objectStatus;
  takeRays(oRes);
  if (oRes.status !== 200 || oRes.body === null) {
    const text = await oRes.text().catch(() => '');
    return fail(oRes.status === 404 ? 404 : 502, oRes.status === 404 ? 'not_found' : 'upstream_5xx', text || 'object cache failed');
  }
  const size = Number(unwrapOr(header(oRes.headers, 'x-ply-size'), '0'));
  if (!Number.isInteger(size) || size < 0) {
    return fail(502, 'pack_corrupt', 'object cache missing x-ply-size');
  }
  return withRays({
    ok: true as const,
    kind: 'blob' as const,
    stream: oRes.body,
    size,
    meta: { ref: presentedRef, commit: commitOid, blob: resolved.oid, mode: resolved.mode, etag: `"${resolved.oid}"` },
    cache,
  });
}
