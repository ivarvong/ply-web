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
import { readFile, listTree, refCandidates } from 'ply';
import { lsRefs } from 'ply';
import { discover } from 'ply';
import { createTransport } from 'ply';
import { Tracer, arrayExporter, flattenLine } from 'ply';
import { RETRY, isPlyCode, fail } from 'ply';
import { withLimits } from 'ply';
import { isWorkerCode, WORKER_RETRY } from './write/errors.ts';
import { handleEdit, handleBranchCreate, handleBranchDelete, handleMerge, handleRebase, handleCherryPick, handleRevert, handleTagCreate, handleTagDelete, readCommitOrEmpty, unbornFields } from './write/handle.ts';
import { handleViewer } from './viewer/handle.ts';
import { checkRemote, createGuardedFetch } from './remote.ts';
import { applySecurityHeaders } from './security-headers.ts';
import { quirksFor } from './quirks.ts';
import { createLoopbackFetch } from './gitcache.ts';
import { syncAll } from './mirror.ts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { asPinned, isInternal, pinnedViewKey, requestForKey, viaPinned } from './pinned.ts';
import { parseViewerRoute, routeOptsFromEnv } from './viewer/route.ts';
import { ALLOWED_HOSTS } from './viewer/url.ts';
import { viewerErrorDocument } from './viewer/safehtml.ts';
import { admitClient } from './viewer/app.tsx';
import { PUBLIC_GIT_HOST, PUBLIC_NAMESPACE, isPublicNamespaceRemote, publicRepoOfRemote, scrubSecrets, tokenSourceFor, withPublicReadCredential } from './public.ts';
import { ADVERTISED_REF_PREFIXES, isAbbreviatedOid, matchAbbreviatedOid } from './abbrev.ts';
import { directoryReadMessage, isDirectoryRead } from './read-status.ts';
import { BUILD_HEADER, plyBuildValue } from './version.ts';
import { holdLastChunk } from './hold-last.ts';
import { applyUpstreamHeaders, createRayLog, observeUpstream, stampUpstreamSpans } from './rays.ts';

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
  remote_error: 502, limit_exceeded: 413, match_count: 422, lfs_pointer: 422, cas_conflict: 409, push_rejected: 409, push_partial: 409,
  merge_conflict: 409, not_fast_forward: 409, not_linear: 422, unrelated_histories: 422, ambiguous: 502, internal: 500,
  ref_exists: 409, stale_expected: 409,
});

const USAGE = `ply — a git client for anywhere, as an HTTP API (https://ply.ivar.workers.dev)

Every endpoint except GET / needs  Authorization: Bearer <PLY_TOKEN>.
Git credential (optional, forwarded upstream):  Git-Authorization: <Authorization value>  or  Git-Token: <token>.
remote= is an https git URL (no userinfo, no IP literals, no private hosts, default port only).
ref= defaults to the remote's HEAD. On reads, short names resolve like git rev-parse (tags before branches).
An abbreviated oid (7–39 lowercase hex) on a read resolves when it matches exactly one advertised ref (branch tip, tag
tip, or peeled tag commit). Otherwise the response is 400 bad_request: pass a full 40-hex oid.
Every /v1 response is cache-control: no-store.
On writes, a short name is refs/heads/<name>. A 40-hex string is a commit id, never a branch of that name.
author and committer are {name, email, tz?, time?}. tz is +HHMM or -HHMM (−12:00..+14:00). time is unix seconds.
Omitted tz is +0000. Omitted time is now. The zero oid (40 zeros) is rejected: omit the field instead.

Every write returns {outcome, ref, oid, oldOid, noop}. outcome is the discriminant:
  commit, noop, empty, created, deleted, merge, fast_forward, up_to_date, rebase, squash, cherry_pick, revert, tag.
noop is true for noop, empty, and up_to_date. newCommit and oldCommit are deprecated aliases of oid and oldOid.
onto is a deprecated alias of the commit the write was based on. A created ref has oldOid null (the compare-and-swap
old value is the zero oid; that zero is not returned as oldCommit).

  GET    /v1/refs?remote=&prefix=              {refs:{name:oid}, head, peeled}
                                               empty repo adds {empty:true, unborn:"refs/heads/main"} (head stays null)
  GET    /v1/discover?remote=                  server capabilities (protocol v2)
  GET    /v1/read?remote=&ref=&path=           file bytes, streamed; x-ply-commit, x-ply-blob, x-ply-mode, content-length
                                               a directory is 400 bad_request (list it with GET /v1/tree), not 404
  GET    /v1/tree?remote=&ref=&path=           {ref, commit, tree, entries:[{name, mode, oid, type}]}
  GET    /v1/commit?remote=&ref=               born: {ref, oid, tree, parents, author, committer, message, signed}
                                               empty: {empty:true, ref:"refs/heads/main", oid:null, tree:null, parents:[], author:null, committer:null, message:null, signed:false}
                         author/committer: {name, email, time (ISO-8601 UTC), epoch, tz (as written, e.g. +0530)}
  POST   /v1/edit        one file, or changes:[{op, path, content?, find?, replace?, to?, mode?}]
                         op is create, write, edit, delete, or rename. An empty or omitted find creates the file.
                         mode is 100644 (default), 100755, or 120000. committer? may differ from author.
                         base omitted + missing ref = root commit (no parent). base as another branch, or a 40-hex
                         commit, starts a new ref at that parent. base 000…0 is 400. head is a compare-and-swap
                         precondition (40 zeros means the ref must not exist). hint is a guess, only for a one-file edit.
  POST   /v1/branch      {remote, ref, from?}            201 {outcome:"created", ref, oid, oldOid:null}
                         from is a branch or a 40-hex commit. Omit from only when HEAD is born.
                         from 000…0 is 400 and nothing is pushed. An existing ref is 409 {code:"ref_exists", retry:"no", oid}.
  DELETE /v1/branch      {remote, ref, oid?}             {outcome:"deleted", ref, deleted}
                         a stale oid is 409 {code:"stale_expected", retry:"fresh", expected, actual, oid:actual}
  POST   /v1/tag         {remote, name, target, annotated?, message?, tagger?}
                         lightweight unless annotated, message, or tagger is set. target is a branch or a commit id.
  DELETE /v1/tag         {remote, name, oid?}            same compare-and-swap as DELETE /v1/branch
  POST   /v1/merge       {remote, ref?, from, author?, message?, fastForwardOnly?, noFastForward?}
                         from is a branch name. committer, when sent, must equal author.
  POST   /v1/rebase      {remote, ref, onto?, committer, author?, squash?, message?}
                         onto is a branch name. author.time must equal committer.time.
  POST   /v1/cherry-pick {remote, ref?, commit, committer, message?, allowEmpty?}
  POST   /v1/revert      {remote, ref?, commit, committer, message?, allowEmpty?}
                         a patch already in the target history is 200 {outcome:"empty", noop:true, oid:<tip>}.
                         allowEmpty:true writes that empty commit (same tree, new commit) instead.

Empty repository, replayed in order (Git-Token on Artifacts; no git seeding). HEAD is an unborn symref to refs/heads/main.

  1. GET /v1/commit?remote=
     200 {empty:true, ref:"refs/heads/main", oid:null, tree:null, parents:[], author:null, committer:null, message:null, signed:false}
     GET /v1/commit?remote=&ref=main is the same body. GET /v1/commit?remote=&ref=nope is 404.
  2. POST /v1/edit
     {remote, message, author:{name, email, tz, time}, changes:[{op:"create", path, content, mode?}, ...]}
     200 {outcome:"commit", ref:"refs/heads/main", oid, oldOid:null, newCommit, oldCommit:null, noop:false, tree}
     The ref is created with compare-and-swap old oid 000…0 and the commit has no parent.
     A 40-hex base is that parent commit. 000…0 is 400.
  3. POST /v1/edit
     {remote, message, author, committer:{name, email, tz, time}, changes:[{op:"edit", path, find, replace}, {op:"create", ...}, {op:"delete", path}, {op:"rename", path, to}]}
  4. POST /v1/branch {remote, ref, from}  →  201 {outcome:"created", ref, oid}
     Omit from only when HEAD is born. 000…0 is 400 (no push). An existing ref is 409 {code:"ref_exists", retry:"no", oid}.
  5. DELETE /v1/branch {remote, ref, oid}
     a stale oid is 409 {code:"stale_expected", retry:"fresh", expected, actual, oid:actual}.
  6. POST /v1/tag {remote, name, target, annotated?, message?, tagger?}   and   DELETE /v1/tag {remote, name, oid?}
  7. POST /v1/merge {remote, ref?, from, author, message?}
  8. POST /v1/rebase {remote, ref, onto?, committer, squash?, message?}
  9. POST /v1/cherry-pick {remote, ref?, commit, committer, message?, allowEmpty?}
     a patch already in history is 200 {outcome:"empty", noop:true, oid:<tip>}. allowEmpty:true writes an empty commit.
  10. POST /v1/revert {remote, ref?, commit, committer, message?, allowEmpty?}

Pass oids returned by these responses into later requests. When HEAD is unborn, merge, rebase, cherry-pick, revert,
and branch-from require the missing field (ref, onto, or from) by name. An explicit unborn ref is 404
"ref refs/heads/main is unborn; create a commit before …".

Errors: {code, message, retry} with retry in yes|fresh|no|read. ref_exists is retry "no". stale_expected is retry
"fresh" and includes the actual oid. ?trace=1 adds ply's spans to JSON responses (and an x-ply-trace timing summary
header on /v1/read when that summary is non-empty).
Every /v1 response that talked to the remote carries x-artifacts-ray and Server-Timing, including 4xx and 5xx.
x-artifacts-ray is the upstream cf-ray log, in start order:
  ls-refs=<16 hex>-<colo>;dur=<ms>, fetch=<ray>;dur=<ms>, receive-pack=<ray>;dur=<ms>
  info/refs and v2 ls-refs are phase ls-refs. upload-pack fetches (and a blob:none retry) are fetch.
  receive-pack advertisement and the push are receive-pack. A response with no cf-ray is "-".
  A call that failed before headers is "no-response". Past 32 entries the rest are "overflow=<count>".
  Server-Timing repeats those phases and durations, then total for the Worker. Spans gain
  git.upstream.cf_ray, git.upstream.phase, and git.upstream.dur_ms.
Every response carries x-ply-version: <Workers version id> and ${BUILD_HEADER}: ply=<commit> ply-web=<commit>.

Public read-only viewer (no token, no git credential):  GET /view   and   GET /r/<name>
  The long form GET /view/<host>/<owner>/<repo>?ref=&path= still works. at= and commit= redirect to ref=.

Public namespace (read-only, no token):  GET /r  and  GET /r/  list ${PUBLIC_NAMESPACE}.
  GET /r/<repo> is that repo (404 when it does not exist). A missing name is not redirected.
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

// Viewer responses are HTML or text and at most a few hundred KiB. Each text body and each header passes the public
// token scrub. A non-text body (a raw binary file) is a git blob the viewer verified by hash, so it is passed through.
async function scrubResponse(res, scrub) {
  const headers = new Headers();
  for (const [k, v] of res.headers) if (k !== 'content-length') headers.set(k, scrub(v));
  const type = res.headers.get('content-type') ?? '';
  if (!res.body || !/^(text\/|application\/json)/.test(type)) return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  return new Response(scrub(await res.text()), { status: res.status, statusText: res.statusText, headers });
}

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

// /v1 is a credentialed API: nothing it answers is stored by a browser or a cache, whatever the ref names.
const NO_STORE = 'no-store';
const REF_READS = new Set(['/v1/tree', '/v1/read', '/v1/commit']);
const json = (status, obj, scrub, extra = {}) => new Response(scrub(JSON.stringify(obj)), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra, 'cache-control': NO_STORE } });

function errorBody(e) {
  const worker = isWorkerCode(e?.code);
  const code = worker ? e.code : isPlyCode(e?.code) ? e.code : 'internal';
  const body = { code, message: String(e?.message ?? e).slice(0, 1000), retry: worker ? WORKER_RETRY[code] : (RETRY[code] ?? 'no') };
  if (Array.isArray(e?.conflicts)) body.conflicts = e.conflicts.slice(0, 200);
  if (e?.reasons && typeof e.reasons === 'object') body.reasons = e.reasons;
  if (Array.isArray(e?.bases)) body.bases = e.bases;
  if (typeof e?.matches === 'number') body.matches = e.matches;
  if (typeof e?.expected === 'string') body.expected = e.expected;
  if (typeof e?.actual === 'string') body.actual = e.actual;
  if (typeof e?.oid === 'string') body.oid = e.oid;
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
    const extra = head ? {} : await unbornFields(remote, opts, head);
    return { body: { refs: out, head, peeled, ...extra } };
  },
  'GET /v1/discover': async ({ remote, opts }) => {
    const info = await discover(createTransport(remote, opts));
    return { body: { ...info, caps: Object.fromEntries(info.caps) } };
  },
  'GET /v1/tree': async ({ remote, q, opts }) => {
    const r = await listTree(remote, { ref: q.get('ref') || null, path: q.get('path') ?? '' }, opts);
    return { body: { ref: r.ref, commit: r.commit, tree: r.tree, entries: r.entries } };
  },
  'GET /v1/commit': async ({ remote, q, opts }) => ({ body: await readCommitOrEmpty(remote, q.get('ref') || null, opts) }),
  'GET /v1/read': async ({ remote, q, opts, spans, ctx, log }) => {
    let r;
    try { r = await readFile(remote, { ref: q.get('ref') || null, path: q.get('path') }, opts); }
    catch (e) { if (isDirectoryRead(e)) throw fail('bad_request', directoryReadMessage(String(e.message ?? e))); throw e; }
    const fixed = new FixedLengthStream(r.size);
    // a verification failure aborts the body short of its Content-Length: the client sees a truncated response, never a
    // clean one with the wrong bytes. holdLastChunk keeps the final bytes back until the blob verified (src/hold-last.ts).
    ctx.waitUntil(holdLastChunk(r.stream).pipeTo(fixed.writable).then(() => log({ stream: 'ok' }), e => log({ stream: 'error', stream_code: e?.code ?? 'error' })));
    const headers = { 'content-type': 'application/octet-stream', 'x-ply-ref': r.ref, 'x-ply-commit': r.commit, 'x-ply-blob': r.blob, 'x-ply-mode': r.mode, 'x-ply-size': String(r.size) };
    const summary = traceSummary(spans());
    if (q.get('trace') === '1' && summary) headers['x-ply-trace'] = summary;
    return new Response(fixed.readable, { status: 200, headers });
  },
};

const WRITES = {
  'POST /v1/edit': ({ remote, body, opts }) => handleEdit(remote, body, opts),
  'POST /v1/branch': ({ remote, body, opts }) => handleBranchCreate(remote, body, opts),
  'DELETE /v1/branch': ({ remote, body, opts }) => handleBranchDelete(remote, body, opts),
  'POST /v1/tag': ({ remote, body, opts }) => handleTagCreate(remote, body, opts),
  'DELETE /v1/tag': ({ remote, body, opts }) => handleTagDelete(remote, body, opts),
  'POST /v1/merge': ({ remote, body, opts }) => handleMerge(remote, body, opts),
  'POST /v1/rebase': ({ remote, body, opts }) => handleRebase(remote, body, opts),
  'POST /v1/cherry-pick': ({ remote, body, opts }) => handleCherryPick(remote, body, opts),
  'POST /v1/revert': ({ remote, body, opts }) => handleRevert(remote, body, opts),
};

// A viewer URL whose repo is public by construction: public-v0 or a built-in forge (never a VIEWER_EXTRA_HOSTS host).
const PINNABLE_HOSTS = new Set([...ALLOWED_HOSTS, PUBLIC_GIT_HOST]);
const isPublicViewLoc = env => url => {
  try { const r = parseViewerRoute(url, routeOptsFromEnv(env)); return r.kind === 'repo' && !r.pack && PINNABLE_HOSTS.has(r.loc.host); } catch { return false; }
};
const pinnedBinding = (env, ctx) => (env.PACK_CACHE === 'off' ? null : ctx?.exports?.Pinned ?? null);

const worker = {
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
      if (env.VERSION?.id) res.headers.set('x-ply-version', env.VERSION.id);
      res.headers.set(BUILD_HEADER, plyBuildValue());
      applySecurityHeaders(res.headers);
      log({ status: res.status, ms: Date.now() - t0, ...extra });
      return res;
    };
    if (req.method === 'GET' && url.pathname === '/') return done(new Response(USAGE, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }));
    // Public viewer, including the public-namespace index (/r) and short repo URLs (/r/<name>).
    // Before the token gate, and it never reads Authorization / Git-Token / Cookie.
    if (url.pathname === '/view.css' || /^\/view\.[0-9a-f]{12}\.css$/.test(url.pathname) || url.pathname === '/view' || url.pathname.startsWith('/view/') || url.pathname === '/r' || url.pathname.startsWith('/r/')) {
      if (url.pathname.includes('@') || url.pathname.toLowerCase().includes('%40')) record.path = '/view/redacted';
      // A raw file at a pinned commit is cached whole (src/pinned.ts): rate-limit here, then ask Pinned.
      const pinKey = isInternal(req) ? null : pinnedViewKey(url, req.method, isPublicViewLoc(env));
      const pin = pinKey ? pinnedBinding(env, ctx) : null;
      if (pinKey && pin) {
        const decision = await admitClient(req, env, 'page', Date.now());
        if (decision === 'unconfigured' || decision === 'unavailable') return done(new Response('rate limiter unavailable\n', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }), { viewer: 1 });
        if (!decision.ok) { const ra = String(Math.max(1, Math.ceil(decision.retryAfterMs / MS_PER_SECOND))); return done(new Response(`Too many viewer requests. Retry after ${ra}s.\n`, { status: 429, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': ra } }), { viewer: 1, code: 'rate_limited' }); }
        const res = await viaPinned(pin, pinKey);
        return done(await scrubResponse(res, publicScrub), { viewer: 1, pinned: res.headers.get('x-ply-pinned-cache') ?? '' });
      }
      try {
        const res = await handleViewer(req, env, ctx, { requestId: id, note: extra => Object.assign(record, extra), skipRate: isInternal(req) });
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
      // An internal request (Pinned filling the cache) was rate-limited at the front door already.
      const decision = isInternal(req) ? { ok: true, retryAfterMs: 0 } : await admitClient(req, env, 'page', Date.now());
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
    let rays = null;
    const attachRays = res => {
      if (!rays) return res;
      const report = rays.report();
      stampUpstreamSpans(exporter.lines, report);
      applyUpstreamHeaders(res.headers, report, Date.now() - t0);
      return res;
    };
    try {
      const body = WRITES[key] ? await readJson(req) : {};
      const allow = (env.ALLOW_REMOTE_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const remoteUrl = checkRemote(WRITES[key] ? body.remote : url.searchParams.get('remote'), allow);
      const remote = remoteUrl.href;
      record.host = remoteUrl.host;
      // Only tree/read/commit take ref; refs and discover ignore it, so it must not cost them an ls-refs.
      const presentedRef = REF_READS.has(url.pathname) && !WRITES[key] ? url.searchParams.get('ref') : null;
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
      rays = createRayLog();
      // Inside the guard, so each hop (including a redirect the guard follows) is one entry.
      const fetchImpl = createGuardedFetch(observeUpstream(createLoopbackFetch(direct, loopback), rays), remoteUrl, allow);
      const opts = { auth: cred.auth, tracer, limits: LIMITS, quirks: quirksFor(remoteUrl.origin), fetchImpl };
      if (!WRITES[key] && presentedRef && isAbbreviatedOid(presentedRef.toLowerCase())) {
        const prefix = presentedRef.toLowerCase();
        const cands = refCandidates(prefix);
        const { refs } = await lsRefs(createTransport(remote, opts), [...new Set([...cands, ...ADVERTISED_REF_PREFIXES])]);
        if (!cands.some(name => refs.has(name))) {
          const match = matchAbbreviatedOid(prefix, refs);
          if (match.kind !== 'unique') throw fail('bad_request', match.message);
          url.searchParams.set('ref', match.oid);
        }
      }
      const out = await handler({ remote, q: url.searchParams, body, opts, spans, ctx, log });
      if (out instanceof Response) {
        out.headers.set('cache-control', NO_STORE);
        attachRays(out);
        const s = spans();
        const stats = { spans: s.length, rtt: s.filter(x => /^git\.(upload-pack|receive-pack)/.test(x.name)).length, wide: s.filter(x => x.attrs['git.fetch.filter.fallback']).length, cache_hits: s.filter(x => x.attrs['git.response.cache'] === 'HIT').length };
        return done(out, stats);
      }
      const res = json(out.status ?? 200, out.body, scrub);
      attachRays(res);
      const s = spans();
      if (url.searchParams.get('trace') === '1') {
        const traced = json(out.status ?? 200, { ...out.body, trace: s.map(spanView) }, scrub);
        for (const [name, value] of res.headers) if (name !== 'content-type' && name !== 'cache-control') traced.headers.set(name, value);
        const stats = { spans: s.length, rtt: s.filter(x => /^git\.(upload-pack|receive-pack)/.test(x.name)).length, wide: s.filter(x => x.attrs['git.fetch.filter.fallback']).length, cache_hits: s.filter(x => x.attrs['git.response.cache'] === 'HIT').length };
        return done(traced, stats);
      }
      const stats = { spans: s.length, rtt: s.filter(x => /^git\.(upload-pack|receive-pack)/.test(x.name)).length, wide: s.filter(x => x.attrs['git.fetch.filter.fallback']).length, cache_hits: s.filter(x => x.attrs['git.response.cache'] === 'HIT').length };
      return done(res, stats);
    } catch (e) {
      const payload = errorBody(e);
      if (rays) stampUpstreamSpans(exporter.lines, rays.report());
      if (url.searchParams.get('trace') === '1') payload.trace = spans().map(spanView);
      const res = json(statusOf(e), payload, scrub);
      if (rays) applyUpstreamHeaders(res.headers, rays.report(), Date.now() - t0);
      return done(res, { code: payload.code, rtt: spans().filter(x => /^git\.(upload-pack|receive-pack)/.test(x.name)).length });
    }
  },
};

export default worker;

/**
 * Cache-enabled (cloudflare.config.ts). Rebuilds the public request from the key alone, runs the same handler, and
 * labels the answer immutable when it is a 200 (src/pinned.ts). Reached only over ctx.exports from the front door.
 */
export class Pinned extends WorkerEntrypoint {
  async fetch(req) {
    const u = new URL(req.url);
    const internal = requestForKey(`${u.pathname}${u.search}`, isPublicViewLoc(this.env));
    if (!internal) return new Response('not a pinned key\n', { status: 404, headers: { 'cache-control': 'no-store' } });
    return asPinned(await worker.fetch(internal, this.env, this.ctx));
  }
}
