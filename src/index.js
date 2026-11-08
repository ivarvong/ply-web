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
import { cacheStatsOf, plyTracer, requestStamp, routeStamp, spanList, stampRequestSpan } from './edge-trace.ts';
import { API_ROUTES, assertRouteTable } from './api-routes.ts';
import { RETRY, isPlyCode, plyError } from 'ply';
import { API_CAPS, API_LIMITS } from './limits.ts';
import { isWorkerCode, WORKER_RETRY } from './write/errors.ts';
import { statusOf } from './status.ts';
import { handleEdit, handleBranchCreate, handleBranchDelete, handleMerge, handleRebase, handleCherryPick, handleRevert, handleTagCreate, handleTagDelete, readCommitOrEmpty, unbornFields } from './write/handle.ts';
import { handleViewer } from './viewer/handle.ts';
import { checkRemote, createGuardedFetch, redirectOptions } from './remote.ts';
import { applySecurityHeaders } from './security-headers.ts';
import { quirksFor } from './quirks.ts';
import { createLoopbackFetch } from './gitcache.ts';
import { WATCH_NAME } from './refs-watch.ts';
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
import { usageNote } from './flags/client.ts';
import { handleFlagHttp } from './flags/http.ts';
import { headerNumber, parseBearer, readHeader } from './http/inbound.ts';
import { err, ok, runRequest } from './http/machine.ts';
import { chainGet, dig, envBinding, header, queryParam, recordGet } from './absent.ts';
import { orElse, unwrapOr } from './option.ts';

export { FlagsCache, FlagControl } from './flags/entry.ts';

export { checkRemote };

export { ViewerRateLimit } from './viewer/rate.ts';
export { GitCache } from './gitcache-entry.ts';
export { RefsWatch } from './refs-watch-entry.ts';
export { RateCounter } from './rate/counter.ts';
export { RateCache } from './rate/cache-entry.ts';

const MAX_BODY = API_CAPS.maxBodyBytes;
const LIMITS = API_LIMITS;
const MS_PER_SECOND = 1000;

// Learned server properties per origin, shared with the viewer (src/quirks.ts).

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
  POST   /v1/merge       {remote, ref?, from, author?, committer?, message?, fastForwardOnly?, noFastForward?}
                         from is a branch or a 40-hex commit. author and committer are separate stamps.
  POST   /v1/rebase      {remote, ref, onto?, committer, author?, squash?, message?}
                         onto is a branch or a 40-hex commit. author.time and committer.time are independent.
  POST   /v1/cherry-pick {remote, ref?, commit, committer, message?, allowEmpty?}
  POST   /v1/revert      {remote, ref?, commit, committer, message?, allowEmpty?}
                         a patch already applied, with the same adds and deletes on both sides, is
                         200 {outcome:"empty", noop:true, oid:<tip>}. allowEmpty:true writes that empty commit.
                         A target that also has its own adds or deletes is 409 merge_conflict.

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

Feature flags (same bearer as /v1). The ruleset is one R2 object. HTTP writes are 405.
Operators seed and ramp with scripts/flags, which calls ply-flag-operator. That Worker checks
FLAG_OPERATOR_TOKEN and calls FlagControl (getConfig, setRollout, setTargeting) over a service binding.
See docs/feature-flags.md.
  GET  /v1/flags                         cached ruleset {revision, cache, environment, flags}
  POST /v1/flags/eval  {unit, attributes?, keys?}
                                         {revision, cache, flags:[{key, variant, reason, bucket}]}

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
// Basic payload is either text or opaque. Opaque is forwarded as the header, with nothing decoded to scrub.
function decodeBasic(payload) {
  try { return { kind: 'text', value: atob(payload) }; }
  catch { return { kind: 'opaque' }; }
}

export function gitAuth(headers, host) {
  const ga = headers.get('git-authorization'), gt = headers.get('git-token');
  if (ga && gt) throw plyError('bad_request', 'send Git-Authorization or Git-Token, not both');
  if (ga) {
    const secrets = [ga, ga.replace(/^\S+\s+/, '')];
    if (/^basic\s/i.test(ga)) {
      const decoded = decodeBasic(ga.replace(/^basic\s+/i, ''));
      if (decoded.kind === 'text') secrets.push(decoded.value, decoded.value.slice(decoded.value.indexOf(':') + 1));
    }
    return { auth: { header: ga }, secrets };
  }
  if (gt) {
    const user = host === 'github.com' || host.endsWith('.github.com') ? 'x-access-token' : host === 'gitlab.com' || host.startsWith('gitlab.') ? 'oauth2' : null;
    const auth = user ? { token: gt, user } : { bearer: gt };
    return { auth, secrets: [gt, ...(user ? [btoa(`${user}:${gt}`)] : [])] };
  }
  return { secrets: [] };
}

export const scrubber = secrets => {
  const list = [...new Set(secrets.filter(s => typeof s === 'string' && s.length >= 4))].sort((a, b) => b.length - a.length);
  return text => list.reduce((s, x) => s.split(x).join('[redacted]'), String(text));
};

// True when `raw` passes the /v1 remote rules and is exactly one repo directly under the public namespace.
function classifyPublicRemote(raw) {
  if (typeof raw !== 'string' || !raw) return { kind: 'absent' };
  try {
    const href = checkRemote(raw).href;
    return publicRepoOfRemote(href) !== null ? { kind: 'public' } : { kind: 'other' };
  } catch (error) {
    return { kind: 'rejected', name: error instanceof Error && error.name ? error.name : 'Error' };
  }
}

function isPublicReadRemote(raw) {
  return classifyPublicRemote(raw).kind === 'public';
}

function recordField(value, key) {
  if (!value || typeof value !== 'object' || !(key in value)) return null;
  return value[key];
}

function knownFailure(error) {
  const code = recordField(error, 'code');
  return typeof code === 'string' && (isPlyCode(code) || isWorkerCode(code));
}

function failureMessage(error) {
  const message = recordField(error, 'message');
  return (typeof message === 'string' ? message : String(error)).slice(0, 500);
}

// Viewer responses are HTML or text and at most a few hundred KiB. Each text body and each header passes the public
// token scrub. A non-text body (a raw binary file) is a git blob the viewer verified by hash, so it is passed through.
async function scrubResponse(res, scrub) {
  const headers = new Headers();
  for (const [k, v] of res.headers) if (k !== 'content-length') headers.set(k, scrub(v));
  const type = unwrapOr(header(res.headers, 'content-type'), '');
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
  const len = headerNumber(readHeader(req.headers, 'content-length'));
  if (len > MAX_BODY) throw plyError('limit_exceeded', `request body over ${MAX_BODY} bytes`);
  if (!req.body) return {};
  const parts = []; let n = 0;
  for await (const c of req.body) { n += c.length; if (n > MAX_BODY) throw plyError('limit_exceeded', `request body over ${MAX_BODY} bytes`); parts.push(c); }
  const text = new TextDecoder().decode(parts.length === 1 ? parts[0] : new Uint8Array(await new Blob(parts).arrayBuffer()));
  if (!text.trim()) return {};
  try { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; } catch { throw plyError('bad_request', 'body must be a JSON object'); }
}

// /v1 is a credentialed API: nothing it answers is stored by a browser or a cache, whatever the ref names.
const NO_STORE = 'no-store';
const REF_READS = new Set(['/v1/tree', '/v1/read', '/v1/commit']);
const json = (status, obj, scrub, extra = {}) => new Response(scrub(JSON.stringify(obj)), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra, 'cache-control': NO_STORE } });

function ownField(value, key) {
  if (typeof value !== 'object' || value === null) return recordGet(null, key);
  return recordGet(value, key);
}

function copyArray(error, key, limit) {
  const found = chainGet(error, key);
  if (found.tag !== 'some' || !Array.isArray(found.value)) return {};
  return { [key]: limit === null ? found.value : found.value.slice(0, limit) };
}

function stringOrNull(error, key, allowNull) {
  const found = ownField(error, key);
  if (found.tag !== 'some') return {};
  if (typeof found.value === 'string' || (allowNull && found.value === null)) return { [key]: found.value };
  return {};
}

function errorBody(e) {
  const codeField = chainGet(e, 'code');
  const codeText = codeField.tag === 'some' && typeof codeField.value === 'string' ? codeField.value : '';
  const worker = isWorkerCode(codeText);
  const code = worker ? codeText : isPlyCode(codeText) ? codeText : 'internal';
  const messageField = chainGet(e, 'message');
  const retryField = recordGet(worker ? WORKER_RETRY : RETRY, code);
  const body = {
    code,
    message: String(messageField.tag === 'some' ? messageField.value : e).slice(0, 1000),
    retry: retryField.tag === 'some' ? retryField.value : 'no',
    ...copyArray(e, 'conflicts', 200),
  };
  const reasons = chainGet(e, 'reasons');
  if (reasons.tag === 'some' && typeof reasons.value === 'object') body.reasons = reasons.value;
  Object.assign(body, copyArray(e, 'bases', null));
  const matches = chainGet(e, 'matches');
  if (matches.tag === 'some' && typeof matches.value === 'number') body.matches = matches.value;
  // A cas_conflict's null is meaningful: expected null = the ref was to be absent; actual null = it is absent.
  const nullable = code === 'cas_conflict';
  Object.assign(body, stringOrNull(e, 'expected', nullable), stringOrNull(e, 'actual', nullable));
  if (code === 'push_partial') Object.assign(body, copyArray(e, 'landed', 200), copyArray(e, 'rejected', 200));
  const oid = chainGet(e, 'oid');
  if (oid.tag === 'some' && typeof oid.value === 'string') body.oid = oid.value;
  const status = chainGet(e, 'status');
  if (code === 'auth' && status.tag === 'some' && status.value) body.upstreamStatus = status.value;
  return body;
}

// A ply error (or the Worker's own) for the response stage: errorBody and statusOf answer it.
const plyFailure = error => err({ kind: 'ply', error });

const spanView = s => {
  const statusCode = dig(s, ['status', 'code']);
  return { name: s.name, ms: Math.round(s.durationMs * 10) / 10, status: statusCode.tag === 'some' && statusCode.value === 2 ? 'error' : 'ok', attrs: s.attrs, events: s.events.filter(e => e.name !== 'exception').slice(0, 32) };
};
const traceSummary = spans => spans.map(s => `${s.name.replace(/^git\.(upload-pack |receive-pack)/, '$1').replace(/ /g, '_')};dur=${Math.round(s.durationMs)}`).join(', ').slice(0, 4000);

// ---- handlers: (ctx) → Result<{ status?, body } | { stream, headers }, PlyError> ----
// A ply call's failure is its Err, returned as the handler's. index.js answers it with errorBody and statusOf.

const READS = {
  'GET /v1/refs': async ({ remote, q, opts }) => {
    const prefix = q.get('prefix');
    const t = createTransport(remote, opts);
    if (!t.ok) return t;
    const listed = await lsRefs(t.value, prefix ? [prefix, 'HEAD'] : []);
    if (!listed.ok) return listed;
    const { refs, head } = listed.value;
    const out = {}, peeled = {};
    for (const [name, r] of refs) { if (name === 'HEAD') continue; if (prefix && !name.startsWith(prefix)) continue; out[name] = r.oid; if (r.peeled) peeled[name] = r.peeled; }
    const extra = head ? {} : await unbornFields(remote, opts, head);
    return ok({ body: { refs: out, head, peeled, ...extra } });
  },
  'GET /v1/discover': async ({ remote, opts }) => {
    const t = createTransport(remote, opts);
    if (!t.ok) return t;
    const info = await discover(t.value);
    if (!info.ok) return info;
    return ok({ body: { ...info.value, caps: Object.fromEntries(info.value.caps) } });
  },
  'GET /v1/tree': async ({ remote, q, opts }) => {
    const listed = await listTree(remote, { ref: q.get('ref') || null, path: unwrapOr(queryParam(q, 'path'), '') }, opts);
    if (!listed.ok) return listed;
    const r = listed.value;
    return ok({ body: { ref: r.ref, commit: r.commit, tree: r.tree, entries: r.entries } });
  },
  'GET /v1/commit': async ({ remote, q, opts }) => {
    const read = await readCommitOrEmpty(remote, q.get('ref') || null, opts);
    return read.ok ? ok({ body: read.value }) : read;
  },
  'GET /v1/read': async ({ remote, q, opts, spans, ctx, log }) => {
    const read = await readFile(remote, { ref: q.get('ref') || null, path: q.get('path') }, opts);
    if (!read.ok) {
      const e = read.error;
      if (!isDirectoryRead(e)) return read;
      const message = chainGet(e, 'message');
      return err(plyError('bad_request', directoryReadMessage(String(message.tag === 'some' ? message.value : e))));
    }
    const r = read.value;
    const fixed = new FixedLengthStream(r.size);
    // a verification failure aborts the body short of its Content-Length: the client sees a truncated response, never a
    // clean one with the wrong bytes. holdLastChunk keeps the final bytes back until the blob verified (src/hold-last.ts).
    ctx.waitUntil(holdLastChunk(r.stream).pipeTo(fixed.writable).then(() => log({ stream: 'ok' }), e => {
      const code = chainGet(e, 'code');
      log({ stream: 'error', stream_code: code.tag === 'some' ? code.value : 'error' });
    }));
    const headers = new Headers({ 'content-type': 'application/octet-stream', 'x-ply-ref': r.ref, 'x-ply-commit': r.commit, 'x-ply-blob': r.blob, 'x-ply-mode': r.mode, 'x-ply-size': String(r.size) });
    const summary = traceSummary(spans());
    if (q.get('trace') === '1' && summary) headers.set('x-ply-trace', summary);
    return ok({ stream: fixed.readable, headers });
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

// src/api-routes.ts lists these keys for the span test. A route added to one and not the other stops the Worker at load.
assertRouteTable(READS, WRITES);

// A viewer URL whose repo is public by construction: public-v0 or a built-in forge (never a VIEWER_EXTRA_HOSTS host).
const PINNABLE_HOSTS = new Set([...ALLOWED_HOSTS, PUBLIC_GIT_HOST]);
function classifyViewLoc(env, url) {
  try {
    const r = parseViewerRoute(url, routeOptsFromEnv(env));
    return r.kind === 'repo' && !r.pack && PINNABLE_HOSTS.has(r.loc.host) ? { kind: 'public' } : { kind: 'other' };
  } catch (error) {
    return { kind: 'rejected', name: error instanceof Error && error.name ? error.name : 'Error' };
  }
}
const isPublicViewLoc = env => url => classifyViewLoc(env, url).kind === 'public';
/** The one RefsWatch object through ctx.exports (no env binding: see the RateCounter note in cloudflare.config.ts). */
const refsWatchStub = ctx => {
  const ns = unwrapOr(dig(ctx, ['exports', 'RefsWatch']), null);
  if (ns === null || typeof ns.idFromName !== 'function') return null;
  return ns.get(ns.idFromName(WATCH_NAME));
};
const pinnedBinding = (env, ctx) => (env.PACK_CACHE === 'off' ? null : unwrapOr(dig(ctx, ['exports', 'Pinned']), null));

const worker = {
  // Cron (cloudflare.config.ts): keep the public-v0 mirrors on their GitHub branch (src/mirror.ts). One log line per mirror.
  async scheduled(controller, env, ctx) {
    // RefsWatch (src/refs-watch-entry.ts): restart its alarm if it stopped; after a mirror push, poll at once.
    const watch = refsWatchStub(ctx);
    const ensured = watch === null ? Promise.resolve(null) : watch.ensure().catch(e => ({ error: String((e && e.message) || e).slice(0, 120) }));
    let pushed = [];
    if (env.MIRROR_SYNC === 'on' && env.PUBLIC_REPOS) {
      const tokens = tokenSourceFor(env.PUBLIC_REPOS);
      const scrub = text => scrubSecrets(tokens === null ? [] : tokens.secrets())(text);
      const results = await syncAll({ binding: env.PUBLIC_REPOS, tokens, fetchImpl: null, origin: null });
      pushed = results.filter(r => r.outcome === 'updated').map(r => r.repo);
      if (watch !== null && pushed.length > 0) await watch.poke(pushed).catch(() => {});
      for (const r of results) console.log(scrub(JSON.stringify({ msg: 'ply.mirror', cron: unwrapOr(chainGet(controller, 'cron'), ''), scheduledTime: unwrapOr(chainGet(controller, 'scheduledTime'), 0), ...r })));
    }
    console.log(JSON.stringify({ msg: 'ply.refswatch', event: 'cron', ensure: await ensured, poked: pushed }));
  },
  async fetch(req, env, ctx) {
    const t0 = Date.now();
    const url = new URL(req.url);
    const id = crypto.randomUUID();
    // Read tokens minted for the public namespace live in this isolate. Every outgoing string drops all of them.
    const publicTokens = tokenSourceFor(env.PUBLIC_REPOS);
    const publicScrub = text => (publicTokens ? scrubSecrets(publicTokens.secrets())(text) : String(text));
    let scrub = publicScrub;
    const record = { msg: 'ply.request', id, method: req.method, path: url.pathname, colo: unwrapOr(dig(req, ['cf', 'colo']), '') };
    const log = extra => console.log(scrub(JSON.stringify({ ...record, ...extra })));
    const versionId = dig(env, ['VERSION', 'id']);
    const version = versionId.tag === 'some' && typeof versionId.value === 'string' && versionId.value ? versionId.value : null;
    // The route label on the request span and every ply span (src/edge-trace.ts): a known route key, never a raw path.
    let route = 'unmatched';
    const done = (res, extra = {}) => {
      res.headers.set('x-ply-request-id', id);
      if (version !== null) res.headers.set('x-ply-version', version);
      stampRequestSpan(ctx, requestStamp({ route, version, surface, status: res.status, log: extra }));
      res.headers.set(BUILD_HEADER, plyBuildValue());
      applySecurityHeaders(res.headers);
      log({ status: res.status, ms: Date.now() - t0, ...extra });
      return res;
    };
    let surface = 'api';
    let rays = null;
    let collected = null;
    const spans = () => (collected ? collected.spans : []);
    const statsOf = s => cacheStatsOf(s);
    const stamp = headers => {
      if (!rays || !collected) return;
      const report = rays.report();
      stampUpstreamSpans(collected.spans, report);
      applyUpstreamHeaders(headers, report, Date.now() - t0);
    };
    const jsonOut = (status, obj, headers = {}, extra = {}) => ({ kind: 'json', status, obj, headers, log: extra });
    const rawOut = (status, body, headers, extra = {}, statusText = '') => ({ kind: 'raw', status, body, headers, log: extra, statusText });
    const taken = (res, extra) => rawOut(res.status, res.body, res.headers, extra, res.statusText);
    const viewerPath = url.pathname === '/view.css' || /^\/view\.[0-9a-f]{12}\.css$/.test(url.pathname) || url.pathname === '/view' || url.pathname.startsWith('/view/') || url.pathname === '/r' || url.pathname.startsWith('/r/');
    return runRequest({
      parse: () => {
        if (req.method === 'GET' && url.pathname === '/') { surface = 'usage'; route = 'GET /'; return ok({ kind: 'usage' }); }
        // Public viewer, including the public-namespace index (/r) and short repo URLs (/r/<name>).
        // Before the token gate, and it never reads Authorization / Git-Token / Cookie.
        if (viewerPath) {
          surface = 'viewer';
          route = 'viewer';
          if (url.pathname.includes('@') || url.pathname.toLowerCase().includes('%40')) record.path = '/view/redacted';
          const pinKey = isInternal(req) ? null : pinnedViewKey(url, req.method, isPublicViewLoc(env));
          const pin = pinKey ? pinnedBinding(env, ctx) : null;
          return ok({ kind: 'viewer', pinKey, pin });
        }
        surface = 'api';
        const key = `${req.method} ${url.pathname}`;
        if (API_ROUTES.includes(key) || url.pathname === '/v1/flags' || url.pathname === '/v1/flags/eval') route = key;
        const publicRead = !req.headers.has('authorization') && !!READS[key] && isPublicReadRemote(url.searchParams.get('remote'));
        return ok({ kind: 'api', key, publicRead });
      },
      authorize: async parsed => {
        if (parsed.kind === 'usage') return ok(parsed);
        if (parsed.kind === 'viewer') {
          if (!(parsed.pinKey && parsed.pin)) return ok(parsed);
          const decision = await admitClient(req, env, 'page', Date.now(), ctx);
          if (decision === 'unconfigured' || decision === 'unavailable') return err(rawOut(503, 'rate limiter unavailable\n', new Headers({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }), { viewer: 1 }));
          if (!decision.ok) {
            const ra = String(Math.max(1, Math.ceil(decision.retryAfterMs / MS_PER_SECOND)));
            return err(rawOut(429, `Too many viewer requests. Retry after ${ra}s.\n`, new Headers({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': ra }), { viewer: 1, code: 'rate_limited' }));
          }
          return ok(parsed);
        }
        if (parsed.publicRead) {
          record.public = 1;
          if (req.headers.has('git-token') || req.headers.has('git-authorization')) return err(jsonOut(400, { code: 'bad_request', message: `the ${PUBLIC_NAMESPACE} namespace is read without git credentials; send none, or send Authorization: Bearer <PLY_TOKEN>`, retry: 'no' }));
          // An internal request (Pinned filling the cache) was rate-limited at the front door already.
          const decision = isInternal(req) ? { ok: true, retryAfterMs: 0 } : await admitClient(req, env, 'page', Date.now(), ctx);
          if (decision === 'unconfigured' || decision === 'unavailable') return err(jsonOut(503, { code: 'unavailable', message: 'the rate limiter is unavailable', retry: 'yes' }));
          if (!decision.ok) {
            const retryAfter = String(Math.max(1, Math.ceil(decision.retryAfterMs / MS_PER_SECOND)));
            return err(jsonOut(429, { code: 'rate_limited', message: `too many requests; retry after ${retryAfter}s`, retry: 'yes' }, { 'retry-after': retryAfter }));
          }
          return ok(parsed);
        }
        const token = env.PLY_TOKEN;
        if (!token) return err(jsonOut(500, { code: 'internal', message: 'PLY_TOKEN is not configured', retry: 'no' }));
        const presented = parseBearer(readHeader(req.headers, 'authorization'), /^Bearer\s+(.+)$/i);
        if (presented.kind !== 'bearer' || !(await timingSafeTokenEqual(presented.token, token))) return err(jsonOut(401, { code: 'unauthorized', message: 'Authorization: Bearer <PLY_TOKEN> required', retry: 'no' }, { 'www-authenticate': 'Bearer realm="ply"' }));
        return ok(parsed);
      },
      execute: async parsed => {
        if (parsed.kind === 'usage') {
          // A browser landing on the bare origin gets the viewer (the showcase); curl, fetch and the CD probes (Accept */*)
          // keep the usage text.
          const accept = readHeader(req.headers, 'accept');
          if (accept.kind === 'present' && /\btext\/html\b/i.test(accept.value)) {
            return ok(rawOut(302, '', new Headers({ location: '/view', 'cache-control': 'no-store', vary: 'Accept' })));
          }
          // ply.usage.note is off unless the flag ruleset says otherwise. A missing binding leaves this text unchanged.
          let body = USAGE;
          const note = await usageNote(env, ctx, readHeader(req.headers, 'x-ply-unit'));
          if (note) body = `${USAGE}\n${note}\n`;
          return ok(rawOut(200, body, new Headers({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })));
        }
        if (parsed.kind === 'viewer') {
          try {
            const viewerLog = (res, extra = {}) => {
              const hits = Number(res.headers.get('x-ply-cache-hits'));
              const misses = Number(res.headers.get('x-ply-cache-misses'));
              const spans = Number(res.headers.get('x-ply-spans'));
              const rtt = Number(res.headers.get('x-ply-rtt'));
              const log = { viewer: 1, ...extra };
              if (Number.isFinite(hits)) log.cache_hits = hits;
              if (Number.isFinite(misses)) log.cache_misses = misses;
              if (Number.isFinite(spans)) log.spans = spans;
              if (Number.isFinite(rtt)) log.rtt = rtt;
              return log;
            };
            if (parsed.pinKey && parsed.pin) {
              const res = await viaPinned(parsed.pin, parsed.pinKey);
              const scrubbed = await scrubResponse(res, publicScrub);
              return ok(taken(scrubbed, viewerLog(scrubbed, { pinned: unwrapOr(header(res.headers, 'x-ply-pinned-cache'), '') })));
            }
            const res = await handleViewer(req, env, ctx, { requestId: id, note: extra => Object.assign(record, extra), skipRate: isInternal(req) });
            const scrubbed = await scrubResponse(res, publicScrub);
            return ok(taken(scrubbed, viewerLog(scrubbed)));
          } catch (e) {
            if (!knownFailure(e)) throw e;
            const code = recordField(e, 'code');
            return err(rawOut(statusOf({ code }), viewerErrorDocument(code, failureMessage(e)), new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }), { viewer: 1, code }));
          }
        }
        const { key } = parsed;
        if (url.pathname === '/v1/flags' || url.pathname === '/v1/flags/eval') return ok(taken(await handleFlagHttp(req, env, ctx)));
        const writes = env.WRITES === 'on';
        const handler = unwrapOr(orElse(recordGet(READS, key), recordGet(WRITES, key)), null);
        if (!handler) return err(jsonOut(Object.keys({ ...READS, ...WRITES }).some(k => k.endsWith(` ${url.pathname}`)) ? 405 : 404, { code: 'not_found', message: `no route ${key}`, retry: 'no' }));
        if (WRITES[key] && !writes) return err(jsonOut(501, { code: 'unsupported', message: 'writes are disabled on this deployment', retry: 'no' }));
        collected = spanList();
        try {
          const body = WRITES[key] ? await readJson(req) : {};
          const allowText = envBinding(env.ALLOW_REMOTE_ORIGINS);
          const allow = (allowText.tag === 'some' && typeof allowText.value === 'string' ? allowText.value : '').split(',').map(s => s.trim()).filter(Boolean);
          const remoteUrl = checkRemote(WRITES[key] ? body.remote : url.searchParams.get('remote'), allow);
          const remote = remoteUrl.href;
          record.host = remoteUrl.host;
          // Only tree/read/commit take ref; refs and discover ignore it, so it must not cost them an ls-refs.
          const presentedRef = REF_READS.has(url.pathname) && !WRITES[key] ? url.searchParams.get('ref') : null;
          // Read-only means read-only: no write reaches the public namespace, whatever bearer or git credential came with it.
          if (WRITES[key] && isPublicNamespaceRemote(remote)) return err(jsonOut(403, { code: 'read_only', message: `the ${PUBLIC_NAMESPACE} namespace is read-only`, retry: 'no' }));
          const cred = gitAuth(req.headers, remoteUrl.hostname);
          const credential = chainGet(cred, 'auth');
          const callerScrub = scrubber(cred.secrets);
          scrub = text => callerScrub(publicScrub(text));
          // Every /v1 route runs under this one tracer: each ply span is also a Workers span under the request span (src/edge-trace.ts).
          const tracer = plyTracer(ctx, { onEnd: collected.onEnd, resource: { 'service.name': 'ply-worker', 'cloudflare.colo': unwrapOr(dig(req, ['cf', 'colo']), '') } }, routeStamp(route, version));
          // The public read token is attached below the redirect guard, so each hop is re-validated before it is considered,
          // and only when the request carries no credential of its own (a caller's Git-Token or Git-Authorization wins).
          // Under the guard: public, credential-free upload-pack exchanges go to the cache-enabled GitCache entrypoint
          // (Workers Caching); everything else, every credentialed request included, goes straight upstream.
          const direct = withPublicReadCredential(globalThis.fetch.bind(globalThis), publicTokens);
          const loopback = env.PACK_CACHE === 'off' ? null : () => unwrapOr(chainGet(ctx.exports, 'GitCache'), null);
          rays = createRayLog();
          // Inside the guard, so each exchange (a 3xx included) is one entry. The guard never follows a 3xx: ply follows the
          // first GET info/refs (git's http.followRedirects=initial), vetted by allowUrl; a 3xx on a POST is an error.
          const fetchImpl = createGuardedFetch(observeUpstream(createLoopbackFetch(direct, loopback, { watchedRefs: env.REFS_POLICY === 'watched' }), rays), remoteUrl, allow);
          const opts = { ...(credential.tag === 'some' ? { auth: credential.value } : {}), tracer, limits: LIMITS, quirks: quirksFor(remoteUrl.origin), fetchImpl, ...redirectOptions(remoteUrl, allow) };
          // ply's operation() (readFile, listTree, the writes) builds its transport from auth/fetchImpl/limits only, so it
          // would not follow a redirect. It is handed this one, built with the redirect options; the request's operations
          // share it, and with it the base a followed info/refs rewrote, as git does for one command. A transport that
          // cannot be built is left to operation(), which reports it on its root span as before.
          const shared = createTransport(remote, opts);
          if (shared.ok) opts.transport = shared.value;
          if (!WRITES[key] && presentedRef && isAbbreviatedOid(presentedRef.toLowerCase())) {
            const prefix = presentedRef.toLowerCase();
            const cands = refCandidates(prefix);
            if (!cands.ok) return plyFailure(cands.error);
            const t = createTransport(remote, opts);
            if (!t.ok) return plyFailure(t.error);
            const listed = await lsRefs(t.value, [...new Set([...cands.value, ...ADVERTISED_REF_PREFIXES])]);
            if (!listed.ok) return plyFailure(listed.error);
            const { refs } = listed.value;
            if (!cands.value.some(name => refs.has(name))) {
              const match = matchAbbreviatedOid(prefix, refs);
              if (match.kind !== 'unique') return plyFailure(plyError('bad_request', match.message));
              url.searchParams.set('ref', match.oid);
            }
          }
          const handled = await handler({ remote, q: url.searchParams, body, opts, spans, ctx, log });
          if (!handled.ok) return plyFailure(handled.error);
          const out = handled.value;
          if (out && typeof out === 'object' && 'stream' in out) {
            out.headers.set('cache-control', NO_STORE);
            stamp(out.headers);
            return ok(rawOut(200, out.stream, out.headers, statsOf(spans())));
          }
          if (out instanceof Response) {
            out.headers.set('cache-control', NO_STORE);
            stamp(out.headers);
            return ok(taken(out, statsOf(spans())));
          }
          const status = unwrapOr(chainGet(out, 'status'), 200);
          const rayHeaders = new Headers();
          stamp(rayHeaders);
          const s = spans();
          const extra = Object.fromEntries(rayHeaders);
          const stats = statsOf(s);
          if (url.searchParams.get('trace') === '1') return ok(jsonOut(status, { ...out.body, trace: s.map(spanView) }, extra, stats));
          return ok(jsonOut(status, out.body, extra, stats));
        } catch (e) {
          if (knownFailure(e)) return plyFailure(e);
          throw e;
        }
      },
    }, result => {
      if (!result.ok && result.error.kind === 'unexpected') {
        const failure = result.error;
        if (surface === 'viewer') {
          const res = new Response(viewerErrorDocument('internal', 'The viewer hit an internal error.'), { status: 500, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-ply-error-kind': failure.kind } });
          return done(res, { viewer: 1, code: 'internal', error_kind: failure.kind, stage: failure.stage, error_name: failure.name });
        }
        const res = json(500, { code: 'internal', message: 'The request hit an unexpected error.', retry: 'no' }, scrub, { 'x-ply-error-kind': failure.kind });
        return done(res, { code: 'internal', error_kind: failure.kind, stage: failure.stage, error_name: failure.name });
      }
      if (!result.ok && result.error.kind === 'ply') {
        const e = result.error.error;
        const payload = errorBody(e);
        if (rays && collected) stampUpstreamSpans(collected.spans, rays.report());
        if (url.searchParams.get('trace') === '1') payload.trace = spans().map(spanView);
        const res = json(statusOf(e), payload, scrub);
        if (rays) applyUpstreamHeaders(res.headers, rays.report(), Date.now() - t0);
        return done(res, { code: payload.code, rtt: spans().filter(x => /^git\.(upload-pack|receive-pack)/.test(x.name)).length });
      }
      const value = result.ok ? result.value : result.error;
      if (value.kind === 'json') return done(json(value.status, value.obj, scrub, value.headers), value.log);
      const init = { status: value.status, headers: value.headers };
      if (value.statusText) init.statusText = value.statusText;
      return done(new Response(value.body, init), value.log);
    });
  },
};

export default worker;

/**
 * Cache-enabled (cloudflare.config.ts). Rebuilds the public request from the key alone, runs the same handler, and
 * labels the answer immutable when it is a 200 (src/pinned.ts). Reached only over ctx.exports from the front door.
 */
export class Pinned extends WorkerEntrypoint {
  async fetch(req) {
    const loc = isPublicViewLoc(this.env);
    return runRequest({
      parse: () => {
        const u = new URL(req.url);
        return ok(`${u.pathname}${u.search}`);
      },
      authorize: key => ok(key),
      execute: async key => {
        const internal = requestForKey(key, loc);
        if (!internal) return err({ kind: 'not_pinned' });
        return ok(await worker.fetch(internal, this.env, this.ctx));
      },
    }, result => {
      if (!result.ok && result.error.kind === 'unexpected') {
        console.log(JSON.stringify({ msg: 'ply.pinned', error_kind: result.error.kind, stage: result.error.stage, error_name: result.error.name }));
        return new Response('unexpected\n', { status: 500, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'x-ply-error-kind': result.error.kind } });
      }
      if (!result.ok) return new Response('not a pinned key\n', { status: 404, headers: { 'cache-control': 'no-store' } });
      return asPinned(result.value);
    });
  }
}
