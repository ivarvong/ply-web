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
} from 'ply';
import { captureGroup, chainGet, header } from './absent.ts';
import { CACHE_VERSION } from './cache-version.ts';
import { REFS_MAX_AGE_S } from './gitcache.ts';
import { unwrapOr } from './option.ts';
import { withPublicReadCredential, type TokenSource } from './public.ts';

export { BLOB_CACHE_HEADER, BLOB_CACHE_MAX_AGE_SECONDS, BLOB_CACHE_MAX_BYTES, BLOB_OID_HEADER };

/** Dated 2026-11-08: object/tree/commit/resolve TTL (REPORT-blob-cache / REPORT-workers-cache). */
export const CAS_IMMUTABLE = `public, max-age=${BLOB_CACHE_MAX_AGE_SECONDS}, immutable`;
/** Dated 2026-11-08: ref layer — short max-age; SWR 30s (design t186u; GitCache refs uses SWR 10). */
export const REF_SWR_S = 30;
export const REF_CACHE_CONTROL = `public, max-age=${REFS_MAX_AGE_S}, stale-while-revalidate=${REF_SWR_S}`;
export const NO_STORE = 'no-store';

/** Upstream Authorization value; must NOT be named Authorization (triggers BYPASS). */
export const CAS_AUTH_HEADER = 'x-ply-cas-authorization';
export const CAS_ORIGIN = 'https://cas.internal';

export type CasProps = { readonly scope: string };

export type CasBinding = {
  fetch(input: RequestInfo | URL, init?: { props?: CasProps }): Promise<Response>;
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
  | { readonly ok: true; readonly value: PlyTransport }
  | { readonly ok: false; readonly response: Response };

export function transportFor(req: Request, scope: string, tokens: TokenSource | null): TransportResult {
  const auth = authorizationFrom(req);
  const fetchImpl = withPublicReadCredential(globalThis.fetch.bind(globalThis), tokens);
  const transport = createTransport(scope, {
    ...(auth === null ? {} : { auth }),
    fetchImpl,
  });
  if (!transport.ok) return { ok: false, response: plain(400, transport.error.message) };
  return { ok: true, value: transport.value };
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
  const res = await binding.fetch(new Request(`${CAS_ORIGIN}${casPath(layer, pathRest)}`, { ...init, headers, redirect: 'manual' }), {
    props: { scope },
  });
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
  const m = /^\/v(\d+)\/resolve\/([0-9a-f]{40})(?:\/(.*))?$/.exec(pathname);
  const version = captureGroup(m, 1);
  const commit = captureGroup(m, 2);
  if (version.tag === 'none' || commit.tag === 'none' || Number(version.value) !== CACHE_VERSION) return null;
  const rest = captureGroup(m, 3);
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

export async function serveObject(req: Request, props: CasProps, tokens: TokenSource | null): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed');
  const oid = parseObjectPath(new URL(req.url).pathname);
  if (oid === null) return plain(404, 'not an object key');
  const scoped = parseScope(props);
  if (scoped instanceof Response) return scoped;
  const t = transportFor(req, scoped.scope, tokens);
  if (!t.ok) return t.response;

  const buffered = await readBlob(t.value, oid, { maxBytes: BLOB_CACHE_MAX_BYTES });
  if (!buffered.ok) {
    const code = chainGet(buffered.error, 'code');
    const status = code.tag === 'some' && code.value === 'not_found' ? 404 : 502;
    return plain(status, buffered.error.message);
  }
  if (buffered.value.kind === 'too_big') {
    const opened = await openBlob(t.value, oid);
    if (!opened.ok) return plain(502, opened.error.message);
    if (opened.value.kind !== 'stream') return plain(502, 'unexpected blob kind');
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
    return new Response(opened.value.stream, { status: 200, headers });
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
  return new Response(data, { status: 200, headers });
}

export async function serveTree(req: Request, props: CasProps, tokens: TokenSource | null): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed');
  const oid = parseTreePath(new URL(req.url).pathname);
  if (oid === null) return plain(404, 'not a tree key');
  const scoped = parseScope(props);
  if (scoped instanceof Response) return scoped;
  const t = transportFor(req, scoped.scope, tokens);
  if (!t.ok) return t.response;

  const fetched = await fetchObject(t.value, { oid, expectType: TYPE.TREE });
  if (!fetched.ok) {
    const code = chainGet(fetched.error, 'code');
    const status = code.tag === 'some' && code.value === 'not_found' ? 404 : 502;
    return plain(status, fetched.error.message);
  }
  if (fetched.value.type !== TYPE.TREE) return plain(502, 'not a tree');
  const parsed = parseTree(fetched.value.data);
  if (!parsed.ok) return plain(502, parsed.error.message);
  const entries = parsed.value.map(e => ({
    name: e.name,
    mode: e.mode.padStart(6, '0'),
    oid: e.oid,
    type: e.mode === '40000' ? 'tree' : e.mode === '160000' ? 'commit' : 'blob',
  }));
  return jsonOk({ tree: oid, entries }, CAS_IMMUTABLE, oid, 'tree');
}

export async function serveCommit(req: Request, props: CasProps, tokens: TokenSource | null): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed');
  const oid = parseCommitPath(new URL(req.url).pathname);
  if (oid === null) return plain(404, 'not a commit key');
  const scoped = parseScope(props);
  if (scoped instanceof Response) return scoped;
  const t = transportFor(req, scoped.scope, tokens);
  if (!t.ok) return t.response;

  const fetched = await fetchObject(t.value, { oid, expectType: TYPE.COMMIT });
  if (!fetched.ok) {
    const code = chainGet(fetched.error, 'code');
    const status = code.tag === 'some' && code.value === 'not_found' ? 404 : 502;
    return plain(status, fetched.error.message);
  }
  if (fetched.value.type !== TYPE.COMMIT) return plain(502, 'not a commit');
  const viewed = commitView(fetched.value.data);
  if (!viewed.ok) return plain(502, viewed.error.message);
  const view = viewed.value;
  return jsonOk(
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
  );
}

export type TreeLoopback = (treeOid: string, scope: string, auth: string | null) => Promise<Response>;
export type CommitLoopback = (commitOid: string, scope: string, auth: string | null) => Promise<Response>;

/**
 * Resolve (commit, path) → blob|tree entry by walking TreeCache per segment so shared prefixes hit.
 */
export async function serveResolve(
  req: Request,
  props: CasProps,
  _tokens: TokenSource | null,
  loop: { readonly tree: TreeLoopback; readonly commit: CommitLoopback },
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed');
  const parsed = parseResolvePath(new URL(req.url).pathname);
  if (parsed === null) return plain(404, 'not a resolve key');
  const scoped = parseScope(props);
  if (scoped instanceof Response) return scoped;
  const auth = req.headers.get(CAS_AUTH_HEADER);

  const commitRes = await loop.commit(parsed.commit, scoped.scope, auth);
  if (commitRes.status !== 200) {
    const text = await commitRes.text().catch(() => '');
    return plain(commitRes.status, text || 'commit resolve failed');
  }
  const commitBody = (await commitRes.json()) as { tree?: string };
  if (typeof commitBody.tree !== 'string' || !OID_RE.test(commitBody.tree)) return plain(502, 'commit missing tree');

  const segments = parsed.path === '' ? [] : parsed.path.split('/').filter(s => s.length > 0);
  let treeOid = commitBody.tree;
  let mode = '040000';
  let oid = treeOid;
  let type: 'tree' | 'blob' | 'commit' = 'tree';

  for (let i = 0; i < segments.length; i++) {
    const treeRes = await loop.tree(treeOid, scoped.scope, auth);
    if (treeRes.status !== 200) {
      const text = await treeRes.text().catch(() => '');
      return plain(treeRes.status, text || 'tree resolve failed');
    }
    const listing = (await treeRes.json()) as { entries?: { name: string; mode: string; oid: string; type: string }[] };
    const entry = (listing.entries ?? []).find(e => e.name === segments[i]);
    if (!entry) return plain(404, `${segments.slice(0, i + 1).join('/')} not found`);
    oid = entry.oid;
    mode = entry.mode;
    type = entry.type === 'tree' ? 'tree' : entry.type === 'commit' ? 'commit' : 'blob';
    if (i < segments.length - 1) {
      if (type !== 'tree') return plain(404, `${segments.slice(0, i + 1).join('/')} is not a tree`);
      treeOid = oid;
    }
  }

  return jsonOk(
    { commit: parsed.commit, path: parsed.path, oid, mode, type, tree: commitBody.tree },
    CAS_IMMUTABLE,
    `${parsed.commit}:${parsed.path}`,
    'resolve',
  );
}

export async function serveRef(req: Request, props: CasProps, tokens: TokenSource | null): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed');
  const ref = parseRefPath(new URL(req.url).pathname);
  if (ref === null) return plain(404, 'not a ref key');
  const scoped = parseScope(props);
  if (scoped instanceof Response) return scoped;
  const t = transportFor(req, scoped.scope, tokens);
  if (!t.ok) return t.response;

  const listed = await lsRefs(t.value, [ref === 'HEAD' || ref.startsWith('refs/') ? ref : `refs/heads/${ref}`, 'HEAD']);
  if (!listed.ok) return plain(502, listed.error.message);
  const refs = listed.value.refs;
  const full = ref.startsWith('refs/') || ref === 'HEAD' ? ref : `refs/heads/${ref}`;
  const entry = refs.get(full) ?? (ref === 'HEAD' || full === 'HEAD' ? refs.get('HEAD') : undefined);
  if (entry === undefined) {
    // Unborn HEAD: still cacheable briefly so we don't hammer ls-refs; short TTL.
    return jsonOk({ ref: full, commit: null, unborn: true }, REF_CACHE_CONTROL, null, 'ref', {
      'cache-tag': `ply-cas-v${CACHE_VERSION},ply-cas-ref,ply-cas-ref-scope`,
    });
  }
  const oid = entry.oid;
  if (!OID_RE.test(oid)) return plain(502, 'bad commit oid from ls-refs');
  return jsonOk({ ref: full, commit: oid, unborn: false }, REF_CACHE_CONTROL, oid, 'ref', {
    'cache-tag': `ply-cas-v${CACHE_VERSION},ply-cas-ref,ply-cas-ref-${oid.slice(0, 12)}`,
  });
}

/** Purge tags for refs after a write. Must run inside RefCache (purge is entrypoint-scoped). */
export async function purgeRefTags(ctx: { cache?: { purge?: (opts: { tags: string[] }) => Promise<unknown> } }, tags: string[]): Promise<{ ok: boolean; ms: number; error: string }> {
  const t0 = Date.now();
  const purge = ctx.cache?.purge;
  if (typeof purge !== 'function') return { ok: false, ms: 0, error: 'no purge' };
  try {
    await purge({ tags: tags.length > 0 ? tags : [`ply-cas-v${CACHE_VERSION}`, 'ply-cas-ref'] });
    return { ok: true, ms: Date.now() - t0, error: '' };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

export type CasExports = {
  readonly RefCache?: CasBinding;
  readonly CommitCache?: CasBinding;
  readonly TreeCache?: CasBinding;
  readonly ResolvePathCache?: CasBinding;
  readonly ObjectCache?: CasBinding;
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
};

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
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string }
> {
  const cache: Record<string, string> = {};
  if (input.bypass || !input.exports.RefCache) {
    return { ok: false, status: 501, code: 'bad_request', message: 'cas bypass' };
  }
  const refName = input.ref === null || input.ref === '' ? 'HEAD' : input.ref;
  const refRes = await viaCas(input.exports.RefCache, 'ref', encodeRefPath(refName), input.remote, input.authHeader);
  cache[layerHeader('ref')] = unwrapOr(header(refRes.headers, layerHeader('ref')), 'NONE');
  if (refRes.status !== 200) {
    const text = await refRes.text().catch(() => '');
    return { ok: false, status: refRes.status === 404 ? 404 : 502, code: refRes.status === 404 ? 'not_found' : 'upstream_5xx', message: text || 'ref resolve failed' };
  }
  const refBody = (await refRes.json()) as { ref?: string; commit?: string | null; unborn?: boolean };
  if (refBody.unborn || !refBody.commit) {
    if (input.want === 'commit') {
      return {
        ok: true,
        kind: 'commit',
        body: { empty: true, ref: refBody.ref ?? 'refs/heads/main', oid: null, tree: null, parents: [], author: null, committer: null, message: null, signed: false },
        cache,
      };
    }
    return { ok: false, status: 404, code: 'not_found', message: 'empty repository' };
  }
  const commitOid = refBody.commit;
  const presentedRef = refBody.ref ?? refName;

  if (input.want === 'commit') {
    if (!input.exports.CommitCache) return { ok: false, status: 501, code: 'bad_request', message: 'no CommitCache' };
    const cRes = await viaCas(input.exports.CommitCache, 'commit', commitOid, input.remote, input.authHeader);
    cache[layerHeader('commit')] = unwrapOr(header(cRes.headers, layerHeader('commit')), 'NONE');
    if (cRes.status !== 200) {
      const text = await cRes.text().catch(() => '');
      return { ok: false, status: cRes.status, code: 'upstream_5xx', message: text || 'commit cache failed' };
    }
    const body = (await cRes.json()) as Record<string, unknown>;
    return { ok: true, kind: 'commit', body: { ...body, ref: presentedRef }, cache };
  }

  if (!input.exports.ResolvePathCache) return { ok: false, status: 501, code: 'bad_request', message: 'no ResolvePathCache' };
  const path = input.path === null ? '' : input.path;
  const resolveRes = await viaCas(
    input.exports.ResolvePathCache,
    'resolve',
    encodeResolveRest(commitOid, path),
    input.remote,
    input.authHeader,
  );
  cache[layerHeader('resolve')] = unwrapOr(header(resolveRes.headers, layerHeader('resolve')), 'NONE');
  // Nested commit/tree statuses are not automatically visible; resolve span covers the walk.
  if (resolveRes.status !== 200) {
    const text = await resolveRes.text().catch(() => '');
    const code = resolveRes.status === 404 ? 'not_found' : 'upstream_5xx';
    return { ok: false, status: resolveRes.status, code, message: text || 'path resolve failed' };
  }
  const resolved = (await resolveRes.json()) as { oid: string; mode: string; type: string; tree: string; path: string };

  if (input.want === 'tree') {
    if (resolved.type !== 'tree' && path !== '') {
      return { ok: false, status: 400, code: 'bad_request', message: `${path} is not a directory` };
    }
    const treeOid = path === '' ? resolved.tree : resolved.oid;
    if (!input.exports.TreeCache) return { ok: false, status: 501, code: 'bad_request', message: 'no TreeCache' };
    const tRes = await viaCas(input.exports.TreeCache, 'tree', treeOid, input.remote, input.authHeader);
    cache[layerHeader('tree')] = unwrapOr(header(tRes.headers, layerHeader('tree')), 'NONE');
    if (tRes.status !== 200) {
      const text = await tRes.text().catch(() => '');
      return { ok: false, status: tRes.status, code: 'upstream_5xx', message: text || 'tree cache failed' };
    }
    const listing = (await tRes.json()) as { tree: string; entries: unknown };
    return {
      ok: true,
      kind: 'tree',
      body: { ref: presentedRef, commit: commitOid, tree: listing.tree, entries: listing.entries },
      cache,
    };
  }

  // blob
  if (resolved.type === 'tree') {
    return { ok: false, status: 400, code: 'bad_request', message: `${path} is a directory` };
  }
  if (resolved.type === 'commit') {
    return { ok: false, status: 404, code: 'not_found', message: `${path} is a submodule (commit ${resolved.oid})` };
  }
  if (!input.exports.ObjectCache) return { ok: false, status: 501, code: 'bad_request', message: 'no ObjectCache' };
  const oRes = await viaCas(input.exports.ObjectCache, 'object', resolved.oid, input.remote, input.authHeader);
  cache[layerHeader('object')] = unwrapOr(header(oRes.headers, layerHeader('object')), 'NONE');
  cache[BLOB_CACHE_HEADER] = cache[layerHeader('object')] ?? 'NONE';
  if (oRes.status !== 200 || oRes.body === null) {
    const text = await oRes.text().catch(() => '');
    return { ok: false, status: oRes.status === 404 ? 404 : 502, code: oRes.status === 404 ? 'not_found' : 'upstream_5xx', message: text || 'object cache failed' };
  }
  const size = Number(unwrapOr(header(oRes.headers, 'x-ply-size'), '0'));
  if (!Number.isInteger(size) || size < 0) {
    return { ok: false, status: 502, code: 'pack_corrupt', message: 'object cache missing x-ply-size' };
  }
  return {
    ok: true,
    kind: 'blob',
    stream: oRes.body,
    size,
    meta: { ref: presentedRef, commit: commitOid, blob: resolved.oid, mode: resolved.mode, etag: `"${resolved.oid}"` },
    cache,
  };
}
