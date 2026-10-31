// ply as an HTTP API: a Worker that runs ply's git client against any smart-HTTP git host (Cloudflare
// Artifacts, GitHub, GitLab, …) with the caller's git credential. See README.md for the API.
// /v1 stays stateless. /view is a public read-only repo viewer with its own SQLite Durable Object rate limit
// (ViewerRateLimit). It is dispatched before the PLY_TOKEN gate and never forwards a credential.
//
// Two credentials, never confused:
//   Authorization: Bearer <PLY_TOKEN>   gates this Worker (secret; constant-time compare)
//   Git-Authorization: <value>          sent upstream verbatim as Authorization
//   Git-Token: <token>                  convenience, mapped per host (github → Basic x-access-token, gitlab → Basic
//                                       oauth2, Artifacts and others → Bearer)
// Neither git credential appears in logs, spans, error messages or responses (scrubbed at the edge as defense in depth;
// ply itself never records them).
import { readFile, listTree, readCommit, resolveCommit } from 'ply';
import { editFile } from 'ply';
import { mergeBranch } from 'ply';
import { rebaseBranch, cherryPick, revertCommit } from 'ply';
import { lsRefs } from 'ply';
import { discover } from 'ply';
import { push, ZERO_OID } from 'ply';
import { operation } from 'ply';
import { createTransport } from 'ply';
import { Tracer, arrayExporter, flattenLine } from 'ply';
import { RETRY, isPlyCode, fail } from 'ply';
import { withLimits } from 'ply';
import { validateRef, validateIdent } from 'ply';
import { handleViewer } from './viewer/handle.ts';
import { checkRemote, createGuardedFetch } from './remote.ts';
import { applySecurityHeaders } from './security-headers.ts';
import { quirksFor } from './quirks.ts';
import { createLoopbackFetch } from './gitcache.ts';
import { syncAll } from './mirror.ts';
import { viewerErrorDocument } from './viewer/safehtml.ts';
import { admitClient } from './viewer/app.tsx';
import { viewerHref } from './viewer/url.ts';
import { PUBLIC_GIT_HOST, PUBLIC_NAMESPACE, isPublicNamespaceRemote, isPublicRepoName, publicRepoOfRemote, scrubSecrets, tokenSourceFor, withPublicReadCredential } from './public.ts';

export { checkRemote };

export { ViewerRateLimit } from './viewer/rate.ts';
export { GitCache } from './gitcache-entry.ts';

// A Worker isolate has 128 MiB. A buffered pack holds the wire bytes and every inflated object,
// including delta results resolvePack allocates on top of the instructions (ply #9). Four
// maximum-sized objects cover a merge-base triple plus the commit that names them, and
// wire + inflated stays under the isolate. The blob itself is streamed and is not in this total.
const KIB = 1024;
const MIB = KIB * KIB;
const API_OBJECT_BYTES = 16 * MIB;
const API_PACK_WIRE_BYTES = 32 * MIB;
const API_HARVEST_BYTES = 16 * MIB;
const API_INFLATED_OBJECTS = 4;
const API_INFLATED_TOTAL = API_OBJECT_BYTES * API_INFLATED_OBJECTS;
// ply's buffered-pack object ceiling. The inflated-byte cap above is the memory bound.
const API_PACK_OBJECTS = 100_000;
const API_REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY = MIB;
const MS_PER_SECOND = 1000;

const LIMITS = withLimits({
  maxPackBytes: API_PACK_WIRE_BYTES,
  maxObjectSize: API_OBJECT_BYTES,
  maxHarvestBytes: API_HARVEST_BYTES,
  maxInflatedTotal: API_INFLATED_TOTAL,
  maxPackObjects: API_PACK_OBJECTS,
  maxLsRefsBytes: API_PACK_WIRE_BYTES,
  requestTimeoutMs: API_REQUEST_TIMEOUT_MS,
});

// Learned server properties per origin, shared with the viewer (src/quirks.ts).

// HTTP status for each ply error code (see README.md).
export const STATUS = Object.freeze({
  bad_request: 400, unsupported: 501, network: 502, timeout: 504, aborted: 499, http: 502, auth: 401, not_found: 404,
  rate_limited: 429, upstream_5xx: 502, not_git: 502, ssh: 502, host_key_mismatch: 502, protocol: 502, pack_corrupt: 502,
  remote_error: 502, limit_exceeded: 413, match_count: 422, lfs_pointer: 422, cas_conflict: 409, push_rejected: 409,
  merge_conflict: 409, not_fast_forward: 409, not_linear: 422, unrelated_histories: 422, ambiguous: 502, internal: 500,
});

const USAGE = `ply — a git client for anywhere, as an HTTP API (https://ply.ivar.workers.dev)

Every endpoint except GET / needs  Authorization: Bearer <PLY_TOKEN>.
Git credential (optional, forwarded upstream):  Git-Authorization: <Authorization value>  or  Git-Token: <token>.
remote= is an https git URL (no userinfo, no IP literals, no private hosts, default port only).
ref= defaults to the remote's HEAD. Short names resolve like git rev-parse (tags before branches).

  GET    /v1/refs?remote=&prefix=              {refs:{name:oid}, head, peeled}
  GET    /v1/discover?remote=                  server capabilities (protocol v2)
  GET    /v1/read?remote=&ref=&path=           file bytes, streamed; x-ply-commit, x-ply-blob, x-ply-mode, content-length
  GET    /v1/tree?remote=&ref=&path=           [{name, mode, oid, type}]
  GET    /v1/commit?remote=&ref=               {ref, oid, tree, parents, author, committer, message, signed}
                         author/committer: {name, email, time (ISO-8601 UTC), epoch, tz (as written, e.g. +0530)}
  POST   /v1/edit        {remote, ref?, base?, path, find, replace, author:{name,email}, message, head?, hint?}
                         head: expected parent (moved → 409 cas_conflict, nothing pushed); hint: a guess only
  POST   /v1/branch      {remote, ref, from?}           create (fails 409 if it exists)
  DELETE /v1/branch      {remote, ref, oid?}            delete (compare-and-swap on oid)
  POST   /v1/merge       {remote, ref?, from, author, message?, fastForwardOnly?, noFastForward?}
  POST   /v1/rebase      {remote, ref, onto?, committer, squash?, message?}
  POST   /v1/cherry-pick {remote, ref?, commit, committer, message?}
  POST   /v1/revert      {remote, ref?, commit, committer, message?}

Errors: {code, message, retry} with retry in yes|fresh|no|read. ?trace=1 adds ply's spans to JSON responses
(and an x-ply-trace timing summary header on /v1/read).

Public read-only viewer (no token, no git credential):  GET /view   and   GET /view/<host>/<owner>/<repo>?ref=&path=

Public namespace (read-only, no token):  GET /r/<repo>  redirects to the viewer for ${PUBLIC_NAMESPACE}/<repo>, and
  GET /v1/{refs,discover,tree,read,commit}?remote=https://${PUBLIC_GIT_HOST}/git/${PUBLIC_NAMESPACE}/<repo>.git
  need no Authorization (rate-limited per client). Writes to that namespace are 403 read_only, with or without a bearer.
`;

// ---- pure helpers ----

// checkRemote lives in remote.ts. It returns an AllowedRemote; createGuardedFetch will not take a bare string.

// Pure: the git credential from the request headers, as ply's `auth`, plus every string form to scrub.
export function gitAuth(headers, host) {
  const ga = headers.get('git-authorization'), gt = headers.get('git-token');
  if (ga && gt) throw fail('bad_request', 'send Git-Authorization or Git-Token, not both');
  if (ga) {
    const secrets = [ga, ga.replace(/^\S+\s+/, '')];
    if (/^basic\s/i.test(ga)) { try { const d = atob(ga.replace(/^basic\s+/i, '')); secrets.push(d, d.slice(d.indexOf(':') + 1)); } catch { /* not base64: forwarded as is */ } }
    return { auth: { header: ga }, secrets };
  }
  if (gt) {
    const user = host === 'github.com' || host.endsWith('.github.com') ? 'x-access-token' : host === 'gitlab.com' || host.startsWith('gitlab.') ? 'oauth2' : null;
    const auth = user ? { token: gt, user } : { bearer: gt };
    return { auth, secrets: [gt, ...(user ? [btoa(`${user}:${gt}`)] : [])] };
  }
  return { auth: undefined, secrets: [] };
}

export const scrubber = secrets => {
  const list = [...new Set(secrets.filter(s => typeof s === 'string' && s.length >= 4))].sort((a, b) => b.length - a.length);
  return text => list.reduce((s, x) => s.split(x).join('[redacted]'), String(text));
};

// True when `raw` passes the /v1 remote rules and is exactly one repo directly under the public namespace.
function isPublicReadRemote(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  try { return publicRepoOfRemote(checkRemote(raw).href) !== null; } catch { return false; }
}

const PUBLIC_REDIRECT_QUERY = ['ref', 'at', 'path', 'raw'];

function publicRedirect(req, url) {
  const name = url.pathname.slice('/r/'.length);
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed\n', { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
  if (!isPublicRepoName(name)) return new Response(`not a repository in ${PUBLIC_NAMESPACE}\n`, { status: 404, headers });
  const query = {};
  for (const k of PUBLIC_REDIRECT_QUERY) { const v = url.searchParams.get(k); if (v) query[k] = v; }
  return new Response(null, { status: 302, headers: { location: viewerHref(PUBLIC_GIT_HOST, `git/${PUBLIC_NAMESPACE}/${name}.git`, query), 'cache-control': 'no-store' } });
}

// Viewer responses are HTML or text and at most a few hundred KiB. Each text body and each header passes the public
// token scrub. A non-text body (a raw binary file) is a git blob the viewer verified by hash, so it is passed through.
async function scrubResponse(res, scrub) {
  const headers = new Headers();
  for (const [k, v] of res.headers) if (k !== 'content-length') headers.set(k, scrub(v));
  const type = res.headers.get('content-type') ?? '';
  if (!res.body || !/^(text\/|application\/json)/.test(type)) return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  return new Response(scrub(await res.text()), { status: res.status, statusText: res.statusText, headers });
}

const fullRef = r => (typeof r === 'string' && !r.startsWith('refs/') ? `refs/heads/${r}` : r);
const need = (body, k) => { if (body[k] === undefined || body[k] === null || body[k] === '') throw fail('bad_request', `${k} is required`); return body[k]; };

// ---- effects ----

async function timingSafeTokenEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

async function readJson(req) {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) throw fail('limit_exceeded', `request body over ${MAX_BODY} bytes`);
  if (!req.body) return {};
  const parts = []; let n = 0;
  for await (const c of req.body) { n += c.length; if (n > MAX_BODY) throw fail('limit_exceeded', `request body over ${MAX_BODY} bytes`); parts.push(c); }
  const text = new TextDecoder().decode(parts.length === 1 ? parts[0] : new Uint8Array(await new Blob(parts).arrayBuffer()));
  if (!text.trim()) return {};
  try { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; } catch { throw fail('bad_request', 'body must be a JSON object'); }
}

// The default branch: the remote's HEAD symref (some hosts let it go unborn — then the caller must name the ref).
async function headBranch(remote, opts) {
  const t = createTransport(remote, { ...opts, parent: null });
  const { head } = await lsRefs(t, ['HEAD']);
  if (!head) throw fail('not_found', 'remote HEAD is unborn or not a symref; pass ref explicitly');
  return head;
}

const json = (status, obj, scrub, extra = {}) => new Response(scrub(JSON.stringify(obj)), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });

function errorBody(e) {
  const code = isPlyCode(e?.code) ? e.code : 'internal';
  const body = { code, message: String(e?.message ?? e).slice(0, 1000), retry: RETRY[code] ?? 'no' };
  if (Array.isArray(e?.conflicts)) body.conflicts = e.conflicts.slice(0, 200);
  if (e?.reasons && typeof e.reasons === 'object') body.reasons = e.reasons;
  if (Array.isArray(e?.bases)) body.bases = e.bases;
  if (typeof e?.matches === 'number') body.matches = e.matches;
  if (code === 'auth' && e?.status) body.upstreamStatus = e.status;
  return body;
}
const statusOf = e => (e?.code === 'auth' && (e.status === 401 || e.status === 403) ? e.status : STATUS[e?.code] ?? 500);

const spanView = s => ({ name: s.name, ms: Math.round(s.durationMs * 10) / 10, status: s.status?.code === 2 ? 'error' : 'ok', attrs: s.attrs, events: s.events.filter(e => e.name !== 'exception').slice(0, 32) });
const traceSummary = spans => spans.map(s => `${s.name.replace(/^git\.(upload-pack |receive-pack)/, '$1').replace(/ /g, '_')};dur=${Math.round(s.durationMs)}`).join(', ').slice(0, 4000);

// ---- handlers: (ctx) → { status?, body } | Response ----

const READS = {
  'GET /v1/refs': async ({ remote, q, opts }) => {
    const prefix = q.get('prefix');
    const t = createTransport(remote, opts);
    const { refs, head } = await lsRefs(t, prefix ? [prefix, 'HEAD'] : []);
    const out = {}, peeled = {};
    for (const [name, r] of refs) { if (name === 'HEAD') continue; if (prefix && !name.startsWith(prefix)) continue; out[name] = r.oid; if (r.peeled) peeled[name] = r.peeled; }
    return { body: { refs: out, head, peeled } };
  },
  'GET /v1/discover': async ({ remote, opts }) => {
    const info = await discover(createTransport(remote, opts));
    return { body: { ...info, caps: Object.fromEntries(info.caps) } };
  },
  'GET /v1/tree': async ({ remote, q, opts }) => {
    const r = await listTree(remote, { ref: q.get('ref') || null, path: q.get('path') ?? '' }, opts);
    return { body: { ref: r.ref, commit: r.commit, tree: r.tree, entries: r.entries } };
  },
  'GET /v1/commit': async ({ remote, q, opts }) => ({ body: await readCommit(remote, { ref: q.get('ref') || null }, opts) }),
  'GET /v1/read': async ({ remote, q, opts, spans, ctx, log }) => {
    const r = await readFile(remote, { ref: q.get('ref') || null, path: q.get('path') }, opts);
    const fixed = new FixedLengthStream(r.size);
    // a verification failure mid-stream aborts the body short of its Content-Length: the client sees a truncated
    // response, never a clean one with the wrong bytes
    ctx.waitUntil(r.stream.pipeTo(fixed.writable).then(() => log({ stream: 'ok' }), e => log({ stream: 'error', stream_code: e?.code ?? 'error' })));
    const headers = { 'content-type': 'application/octet-stream', 'x-ply-ref': r.ref, 'x-ply-commit': r.commit, 'x-ply-blob': r.blob, 'x-ply-mode': r.mode, 'x-ply-size': String(r.size) };
    if (q.get('trace') === '1') headers['x-ply-trace'] = traceSummary(spans());
    return new Response(fixed.readable, { status: 200, headers });
  },
};

const unixSeconds = () => Math.floor(Date.now() / MS_PER_SECOND);

// validateIdent requires a non-negative unix time and a civil zone, then brands the result.
// The HTTP body is still {name, email, tz?}. This stamp exists only so a bad name, email, or
// zone is bad_request before any fetch; ply stamps the commit with its own time.
function checkedIdent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw fail('bad_request', 'identity must be {name, email}');
  validateIdent({ name: raw.name, email: raw.email, time: unixSeconds(), tz: raw.tz });
  if (raw.tz === undefined) return { name: raw.name, email: raw.email };
  return { name: raw.name, email: raw.email, tz: raw.tz };
}

const ident = (body, k) => checkedIdent(need(body, k));

const WRITES = {
  'POST /v1/edit': async ({ remote, body, opts }) => {
    const ref = body.ref ? fullRef(body.ref) : await headBranch(remote, opts);
    const r = await editFile(remote, { ref, base: body.base ? fullRef(body.base) : ref, path: need(body, 'path'), find: need(body, 'find'), replace: body.replace ?? '', author: ident(body, 'author'), message: need(body, 'message') }, { ...opts, ...(body.head ? { head: body.head, strictHead: true } : body.hint ? { head: body.hint } : {}) });
    return { body: { ref, newCommit: r.newCommit, oldCommit: r.oldCommit, pushBytes: r.pushBytes, noop: r.noop, newBlob: r.newBlob, newTree: r.newTree, hint: r.hint, attempt: r.attempt } };
  },
  'POST /v1/branch': async ({ remote, body, opts }) => {
    const ref = validateRef(fullRef(need(body, 'ref')));
    return { status: 201, body: await operation('branch_create', remote, { ...opts, attrs: { 'git.branch_create.ref': ref } }, async ({ t, root, outcome }) => {
      const { commit } = await resolveCommit(t, body.from ?? null);
      root.set({ 'git.branch_create.oid': commit });
      const r = await push(t, { ref, oldOid: ZERO_OID, newOid: commit, objects: [] });
      return outcome('created', { ref, oid: commit, pushBytes: r.packBytes });
    }) };
  },
  'DELETE /v1/branch': async ({ remote, body, opts }) => {
    const ref = validateRef(fullRef(need(body, 'ref')));
    if (body.oid !== undefined && !/^[0-9a-f]{40}$/.test(body.oid)) throw fail('bad_request', 'oid must be a 40-hex oid');
    return { body: await operation('branch_delete', remote, { ...opts, attrs: { 'git.branch_delete.ref': ref } }, async ({ t, root, outcome }) => {
      let oid = body.oid;
      if (!oid) { oid = (await lsRefs(t, [ref])).refs.get(ref)?.oid; if (!oid) throw fail('not_found', `ref ${ref} not found`); }
      root.set({ 'git.branch_delete.oid': oid, 'git.branch_delete.cas_from_caller': !!body.oid });
      await push(t, { ref, oldOid: oid, newOid: ZERO_OID, objects: [] });
      return outcome('deleted', { ref, deleted: oid });
    }) };
  },
  'POST /v1/merge': async ({ remote, body, opts }) => {
    const ref = body.ref ? fullRef(body.ref) : await headBranch(remote, opts);
    const r = await mergeBranch(remote, { ref, from: fullRef(need(body, 'from')), author: body.author ? checkedIdent(body.author) : undefined, message: body.message, fastForwardOnly: !!body.fastForwardOnly, noFastForward: !!body.noFastForward }, opts);
    return { body: r };
  },
  'POST /v1/rebase': async ({ remote, body, opts }) => {
    const onto = body.onto ? fullRef(body.onto) : await headBranch(remote, opts);
    const r = await rebaseBranch(remote, { ref: fullRef(need(body, 'ref')), onto, committer: ident(body, 'committer'), author: body.author ? checkedIdent(body.author) : undefined, squash: !!body.squash, message: body.message ?? null }, opts);
    return { body: r };
  },
  'POST /v1/cherry-pick': async ({ remote, body, opts }) => {
    const ref = body.ref ? fullRef(body.ref) : await headBranch(remote, opts);
    return { body: await cherryPick(remote, { ref, commit: need(body, 'commit'), committer: ident(body, 'committer'), message: body.message ?? null }, opts) };
  },
  'POST /v1/revert': async ({ remote, body, opts }) => {
    const ref = body.ref ? fullRef(body.ref) : await headBranch(remote, opts);
    return { body: await revertCommit(remote, { ref, commit: need(body, 'commit'), committer: ident(body, 'committer'), message: body.message ?? null }, opts) };
  },
};

export default {
  // Cron (cloudflare.config.ts): keep the public-v0 mirrors on their GitHub branch (src/mirror.ts). One log line per mirror.
  async scheduled(controller, env, ctx) {
    if (env.MIRROR_SYNC !== 'on' || !env.PUBLIC_REPOS) return;
    const tokens = tokenSourceFor(env.PUBLIC_REPOS);
    const scrub = text => scrubSecrets(tokens?.secrets() ?? [])(text);
    const results = await syncAll({ binding: env.PUBLIC_REPOS, tokens });
    for (const r of results) console.log(scrub(JSON.stringify({ msg: 'ply.mirror', cron: controller?.cron ?? '', scheduledTime: controller?.scheduledTime ?? 0, ...r })));
    void ctx;
  },
  async fetch(req, env, ctx) {
    const t0 = Date.now();
    const url = new URL(req.url);
    const id = crypto.randomUUID();
    // Read tokens minted for the public namespace live in this isolate. Every outgoing string drops all of them.
    const publicTokens = tokenSourceFor(env.PUBLIC_REPOS);
    const publicScrub = text => (publicTokens ? scrubSecrets(publicTokens.secrets())(text) : String(text));
    let scrub = publicScrub;
    const record = { msg: 'ply.request', id, method: req.method, path: url.pathname, colo: req.cf?.colo ?? '' };
    const log = extra => console.log(scrub(JSON.stringify({ ...record, ...extra })));
    const done = (res, extra = {}) => {
      res.headers.set('x-ply-request-id', id);
      applySecurityHeaders(res.headers);
      log({ status: res.status, ms: Date.now() - t0, ...extra });
      return res;
    };
    if (req.method === 'GET' && url.pathname === '/') return done(new Response(USAGE, { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    // Friendly name for a public-namespace repo: /r/<repo> → the viewer's canonical URL. No fetch, so no rate limit.
    if (url.pathname === '/r' || url.pathname.startsWith('/r/')) return done(publicRedirect(req, url));
    // Public viewer. Before the token gate, and it never reads Authorization / Git-Token / Cookie.
    if (url.pathname === '/view.css' || url.pathname === '/view' || url.pathname.startsWith('/view/')) {
      if (url.pathname.includes('@') || url.pathname.toLowerCase().includes('%40')) record.path = '/view/redacted';
      try {
        const res = await handleViewer(req, env, ctx, { requestId: id, note: extra => Object.assign(record, extra) });
        return done(await scrubResponse(res, publicScrub), { viewer: 1 });
      } catch (e) {
        const code = isPlyCode(e?.code) ? e.code : 'internal';
        const message = code === 'internal' ? 'The viewer hit an internal error.' : String(e?.message ?? e).slice(0, 500);
        const res = new Response(viewerErrorDocument(code, message), { status: STATUS[code] ?? 500, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
        return done(res, { viewer: 1, code });
      }
    }
    const key = `${req.method} ${url.pathname}`;
    // Public mode: a read endpoint, no Authorization header at all, and a remote that is exactly one public-namespace
    // repo. No PLY_TOKEN, no caller git credential, the viewer's per-client rate limit (page bucket).
    const publicRead = !req.headers.has('authorization') && !!READS[key] && isPublicReadRemote(url.searchParams.get('remote'));
    if (publicRead) {
      record.public = 1;
      if (req.headers.has('git-token') || req.headers.has('git-authorization')) return done(json(400, { code: 'bad_request', message: `the ${PUBLIC_NAMESPACE} namespace is read without git credentials; send none, or send Authorization: Bearer <PLY_TOKEN>`, retry: 'no' }, scrub));
      const decision = await admitClient(req, env, 'page', Date.now());
      if (decision === 'unconfigured' || decision === 'unavailable') return done(json(503, { code: 'unavailable', message: 'the rate limiter is unavailable', retry: 'yes' }, scrub));
      if (!decision.ok) {
        const retryAfter = String(Math.max(1, Math.ceil(decision.retryAfterMs / MS_PER_SECOND)));
        return done(json(429, { code: 'rate_limited', message: `too many requests; retry after ${retryAfter}s`, retry: 'yes' }, scrub, { 'retry-after': retryAfter }));
      }
    } else {
      // gate
      const token = env.PLY_TOKEN;
      if (!token) return done(json(500, { code: 'internal', message: 'PLY_TOKEN is not configured', retry: 'no' }, scrub));
      const presented = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
      if (!presented || !(await timingSafeTokenEqual(presented, token))) return done(json(401, { code: 'unauthorized', message: 'Authorization: Bearer <PLY_TOKEN> required', retry: 'no' }, scrub, { 'www-authenticate': 'Bearer realm="ply"' }));
    }
    const writes = env.WRITES === 'on';
    const handler = READS[key] ?? WRITES[key];
    if (!handler) return done(json(Object.keys({ ...READS, ...WRITES }).some(k => k.endsWith(` ${url.pathname}`)) ? 405 : 404, { code: 'not_found', message: `no route ${key}`, retry: 'no' }, scrub));
    if (WRITES[key] && !writes) return done(json(501, { code: 'unsupported', message: 'writes are disabled on this deployment', retry: 'no' }, scrub));
    const exporter = arrayExporter();
    const spans = () => exporter.lines.flatMap(flattenLine);
    try {
      const body = WRITES[key] ? await readJson(req) : {};
      const allow = (env.ALLOW_REMOTE_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const remoteUrl = checkRemote(WRITES[key] ? body.remote : url.searchParams.get('remote'), allow);
      const remote = remoteUrl.href;
      record.host = remoteUrl.host;
      // Read-only means read-only: no write reaches the public namespace, whatever bearer or git credential came with it.
      if (WRITES[key] && isPublicNamespaceRemote(remote)) return done(json(403, { code: 'read_only', message: `the ${PUBLIC_NAMESPACE} namespace is read-only`, retry: 'no' }, scrub));
      const cred = gitAuth(req.headers, remoteUrl.hostname);
      const callerScrub = scrubber(cred.secrets);
      scrub = text => callerScrub(publicScrub(text));
      const tracer = new Tracer({ exporter, resource: { 'service.name': 'ply-worker', 'cloudflare.colo': req.cf?.colo ?? '' } });
      // The public read token is attached below the redirect guard, so each hop is re-validated before it is considered,
      // and only when the request carries no credential of its own (a caller's Git-Token or Git-Authorization wins).
      // Under the guard: public, credential-free upload-pack exchanges go to the cache-enabled GitCache entrypoint
      // (Workers Caching); everything else, every credentialed request included, goes straight upstream.
      const direct = withPublicReadCredential(globalThis.fetch.bind(globalThis), publicTokens);
      const loopback = env.PACK_CACHE === 'off' ? null : () => ctx.exports?.GitCache;
      const fetchImpl = createGuardedFetch(createLoopbackFetch(direct, loopback), remoteUrl, allow);
      const opts = { auth: cred.auth, tracer, limits: LIMITS, quirks: quirksFor(remoteUrl.origin), fetchImpl };
      const out = await handler({ remote, q: url.searchParams, body, opts, spans, ctx, log });
      const s = spans();
      const stats = { spans: s.length, rtt: s.filter(x => /^git\.(upload-pack|receive-pack)/.test(x.name)).length, wide: s.filter(x => x.attrs['git.fetch.filter.fallback']).length, cache_hits: s.filter(x => x.attrs['git.response.cache'] === 'HIT').length };
      if (out instanceof Response) return done(out, stats);
      const payload = url.searchParams.get('trace') === '1' ? { ...out.body, trace: s.map(spanView) } : out.body;
      return done(json(out.status ?? 200, payload, scrub, { 'server-timing': `total;dur=${Date.now() - t0}` }), stats);
    } catch (e) {
      const payload = errorBody(e);
      if (url.searchParams.get('trace') === '1') payload.trace = spans().map(spanView);
      return done(json(statusOf(e), payload, scrub), { code: payload.code, rtt: spans().filter(x => /^git\.(upload-pack|receive-pack)/.test(x.name)).length });
    }
  },
};
