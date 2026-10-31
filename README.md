# ply Worker — `https://ply.ivar.workers.dev`

A Cloudflare Worker that exposes [ply](https://github.com/ivarvong/ply) as an HTTP API against any smart-HTTP git host. The git client is `github:ivarvong/ply#c2ccba2c554e8a18ac438cfbc53725d4b593811b` (an exact commit of ply `main`; `bump-ply.yml` moves the pin). The `/v1` API has no
storage. `GET /view` is a public repository viewer, rate-limited by client through a SQLite Durable Object. One Artifacts
namespace, `public-v0`, is served read-only with no token (`/r/<repo>`, see [Public namespace](#public-namespace-public-v0));
its binding is the Worker's only other binding. `GET /` prints the usage text.

## Auth

- **Gate**: `Authorization: Bearer <PLY_TOKEN>` on `/v1`. `GET /`, `GET /view`, `GET /view.css`, `GET /r/<repo>`, and the
  `/v1` reads of the [public namespace](#public-namespace-public-v0) are public. The token is a Worker secret
  (`cf workers secrets update PLY_TOKEN --worker ply --type secret_text`) and is compared in constant time (SHA-256 of both sides,
  then `crypto.subtle.timingSafeEqual`). A missing or wrong token returns 401 `{code: "unauthorized"}`.
- **Git credential** (optional; public repos need none):
  - `Git-Authorization: <value>` is sent upstream verbatim as `Authorization`.
  - `Git-Token: <token>` is mapped by host: `github.com` → `Basic x-access-token:<token>`, `gitlab.*` → `Basic
    oauth2:<token>`, anything else (Cloudflare Artifacts included) → `Bearer <token>`. Artifacts accepts Bearer and
    Basic; both were checked in the smoke run.
  - Sending both headers is a 400.
  - Neither credential appears in a response, trace, error message or log line. ply never records them, and the
    Worker scrubs every outgoing string as a second layer (`test/worker.test.js` greps all of these, including a
    hostile upstream that echoes the header back).
- **Remote rules**: `remote` must be `https:`, on the default port, with no userinfo, query, or fragment. The host is
  canonicalised (lowercase, no trailing dot — `github.com.` is rejected rather than stripped). IP literals are refused
  in every encoding the URL parser accepts (dotted, zero-padded, octal, hex, decimal `2130706433`, IPv6, IPv4-mapped,
  IPv4-compatible). So are single-label hosts, `localhost`/`.local`/`.internal`/`.lan`/`.home.arpa`/… names, and
  wildcard-DNS names (`nip.io`, `sslip.io`, `localtest.me`, and the same shape of zone). A path segment of `.` or `..`,
  or an encoded slash, backslash, or dot (`%2f`, `%5c`, `%2e`), is rejected before normalisation. Redirects are
  followed manually, at most three hops, and only when the next URL passes the same check and stays on the same origin.
  The Worker's fetch wrapper (`createGuardedFetch`, `src/remote.ts`) follows them, so ply only sees the final response;
  ply itself never follows a 3xx and would report it as an `http` error (`test/worker.test.js`, "redirects").
  `ALLOW_REMOTE_ORIGINS` (comma-separated origins) exempts those origins from the public-host rules (http, an IP, a
  non-default port). Only the tests use it.

## Endpoints

| Method | Path | Input | Output |
|---|---|---|---|
| GET | `/v1/refs` | `remote`, `prefix?` | `{refs: {name: oid}, head, peeled: {tag: commit}}`. An empty repository adds `{empty:true, unborn:"refs/heads/main"}` and leaves `head` null |
| GET | `/v1/discover` | `remote` | protocol v2 capabilities (`agent`, `fetch`, `filter`, `caps`, …) |
| GET | `/v1/read` | `remote`, `ref?`, `path` | the blob, streamed. Headers: `content-length`, `x-ply-ref`, `x-ply-commit`, `x-ply-blob`, `x-ply-mode`, `x-ply-size`. A directory is `400` `bad_request` (list it with `GET /v1/tree`), not `404` |
| GET | `/v1/tree` | `remote`, `ref?`, `path?` | `{ref, commit, tree, entries: [{name, mode, oid, type}]}` (modes as `git ls-tree` prints them) |
| GET | `/v1/commit` | `remote`, `ref?` | born: `{ref, oid, tree, parents, author, committer, message, signed}`. `author`/`committer` are `{name, email, time, epoch, tz}` (`time` ISO-8601 UTC, `epoch` the raw seconds, `tz` as written, e.g. `+0530`). `message` is the raw body. `signed` means a `gpgsig` header is present (not verified). Fetches the commit only (`tree:0`, deepen 1; `blob:none` when the server refuses that). Empty repository (unborn HEAD, or that same branch by name): `{empty:true, ref:"refs/heads/main", oid:null, tree:null, parents:[], author:null, committer:null, message:null, signed:false}`. A different missing ref stays 404. A born response does not grow an `empty` field |
| POST | `/v1/edit` | `{remote, ref?, base?, author, committer?, message, head?, changes?}` or the one-file form `{path, find?, replace?, content?, delete?, to?, mode?}` | `{outcome, ref, oid, oldOid, noop, tree, newCommit, oldCommit}`. `newCommit`/`oldCommit` alias `oid`/`oldOid`. A root commit and any newly created ref have `oldOid: null` |
| POST | `/v1/branch` | `{remote, ref, from?}` | 201 `{outcome:"created", ref, oid, oldOid:null}`. `from` is a branch or a 40-hex commit. Omit `from` only when HEAD is born |
| DELETE | `/v1/branch` | `{remote, ref, oid?}` | `{outcome:"deleted", ref, deleted}`. CAS on `oid` (default: the oid ls-refs shows now) |
| POST | `/v1/tag` | `{remote, name, target, annotated?, message?, tagger?}` | 201 `{outcome:"tag", ref, oid, commit, annotated}`. Lightweight unless `annotated`, `message`, or `tagger` is set. `target` is a branch or a commit id |
| DELETE | `/v1/tag` | `{remote, name, oid?}` | same compare-and-swap as `DELETE /v1/branch` |
| POST | `/v1/merge` | `{remote, ref?, from, author?, committer?, message?, fastForwardOnly?, noFastForward?}` | `{outcome, ref, oid, oldOid, noop, …}` where outcome is `merge`, `fast_forward`, or `up_to_date`. `from` is a branch or a 40-hex commit. `author` and `committer` are separate stamps, each with its own `time` and `tz` |
| POST | `/v1/rebase` | `{remote, ref, onto?, committer, author?, squash?, message?}` | `{outcome, ref, oid, oldOid, …}` where outcome is `rebase`, `squash`, `fast_forward`, or `up_to_date`. `onto` is a branch or a 40-hex commit. `author.time` and `committer.time` are independent |
| POST | `/v1/cherry-pick`, `/v1/revert` | `{remote, ref?, commit, committer, message?, allowEmpty?}` | `{outcome, ref, oid, oldOid, noop, tree?}`. A patch already applied, and only when both sides added and deleted the same paths, is `{outcome:"empty", noop:true, oid:<tip>}`. `allowEmpty:true` writes that empty commit. If the target also has its own adds or deletes, the response is 409 `merge_conflict` (`allowEmpty` does not override it) |

- `ref` defaults to the remote's HEAD branch. On an empty repository HEAD is an unborn symref (`refs/heads/main` on
  Artifacts and on `git init -b main`). `GET /v1/commit` reports that as `empty: true` and names the symref.
  `POST /v1/edit` with no `ref` creates the root commit on that branch. Merge, rebase, cherry-pick, revert, and
  branch-from cannot use an unborn HEAD: the response is 400 naming the missing field (`ref`, `onto`, or `from`).
  Naming that unborn ref explicitly is 404 `ref refs/heads/main is unborn; create a commit before …`.
- On reads, short names resolve the way `git rev-parse` does: tags win over branches, and a 40-hex commit oid is also
  accepted. An abbreviated oid (7–39 hex) resolves only when it matches one advertised ref (a branch tip, a tag tip, or
  a peeled tag commit); otherwise the response is `400` `bad_request` asking for the full oid. On writes, short names
  mean `refs/heads/<name>`. A 40-hex string is a commit id, never a branch of that
  name. The zero oid is 400; omit the field to mean "no parent" or "HEAD".
- `author` and `committer` are `{name, email, tz?, time?}`. `tz` is `+HHMM` or `-HHMM` in the civil range −12:00
  through +14:00 (ply's `validateIdent`; a bad zone is 400 `bad_request`). `time` is unix seconds. Omitted `tz` is
  `+0000`. Omitted `time` is now. Merge and rebase write each stamp with its own time and zone.
- One edit is `{path, find, replace}`. An empty or omitted `find` creates the file (`content`, or `replace`, or
  empty). `delete: true` deletes it. `to` renames it. `mode` is `100644` (default), `100755`, or `120000`.
  Several changes go in `changes: [{op, path, content?, find?, replace?, to?, mode?}]` with `op` of `create`,
  `write`, `edit`, `delete`, or `rename`, applied in order. Pass `changes` or a single `path`, not both.
  A distinct `committer` is written on the commit. One find/replace of an existing file still streams through ply.
- `base` omitted on a missing ref is a root commit (no parent), pushed with compare-and-swap old oid all zeros.
  `base` as another branch, or as a 40-hex commit, starts a new ref whose parent is that commit. `base` of zeros is
  400 and nothing is fetched. On an existing branch, omit `base` to commit on the tip.
- Every `/v1` response is `cache-control: no-store` (a credentialed API: nothing it answers is stored, not even a
  `tree`/`read`/`commit` at a full oid). Every response carries `x-ply-version` (the Workers version id, which
  `scripts/deploy.sh` checks) and `x-ply-build` (`ply=<commit> ply-web=<commit>`, injected at build time). `x-ply-trace`
  is omitted when it would be empty.
- `head` on edit is a **precondition**: if the branch is not at `head`, the response is 409 `cas_conflict` and nothing
  is pushed. `head` of zeros means the ref must not exist yet. `hint` is ply's soft head hint for a one-file edit.
- Every write shares `{outcome, ref, oid, oldOid, noop}`. `newCommit` and `oldCommit` are deprecated aliases of
  `oid` and `oldOid`. `onto` is a deprecated alias of the commit the write was based on. `noop` is true for
  `noop`, `empty`, and `up_to_date`.

### Empty repository, in order

This is the whole lifecycle against a brand-new repository. Nothing is seeded with stock git. Replay it against
Artifacts after deploy (`Git-Token` is the Artifacts bearer). Pass oids from responses into later requests.

1. `GET /v1/commit?remote=` → 200 `{empty:true, ref:"refs/heads/main", oid:null, tree:null, parents:[], author:null, committer:null, message:null, signed:false}`.
   `GET /v1/commit?remote=&ref=main` is the same body. `GET /v1/commit?remote=&ref=nope` is 404.
2. `POST /v1/edit` `{remote, message, author:{name, email, tz, time}, changes:[{op:"create", path, content, mode?}, …]}`
   → 200 `{outcome:"commit", ref:"refs/heads/main", oid, oldOid:null, newCommit, oldCommit:null, noop:false, tree}`.
   The ref is created with compare-and-swap old oid `000…0` and the commit has no parent. A 40-hex `base` is that
   parent commit. `000…0` is 400.
3. `POST /v1/edit` `{remote, message, author, committer:{name, email, tz, time}, changes:[{op:"edit", path, find, replace}, {op:"create", …}, {op:"delete", path}, {op:"rename", path, to}]}`.
4. `POST /v1/branch` `{remote, ref, from}` → 201 `{outcome:"created", ref, oid}`. `from` is a branch or a 40-hex
   commit. Omit `from` only when HEAD is born. `000…0` is 400 and nothing is pushed. An existing ref is 409
   `{code:"ref_exists", retry:"no", oid}`.
5. `DELETE /v1/branch` `{remote, ref, oid}` — a stale oid is 409 `{code:"stale_expected", retry:"fresh", expected, actual, oid:actual}`.
6. `POST /v1/tag` `{remote, name, target, annotated?, message?, tagger?}` and `DELETE /v1/tag` `{remote, name, oid?}`.
7. `POST /v1/merge` `{remote, ref?, from, author, message?}`.
8. `POST /v1/rebase` `{remote, ref, onto?, committer, squash?, message?}`.
9. `POST /v1/cherry-pick` `{remote, ref?, commit, committer, message?, allowEmpty?}` — a patch already applied, when both
   sides added and deleted the same paths, is 200 `{outcome:"empty", noop:true, oid:<tip>}`. `allowEmpty:true` writes
   an empty commit (same tree, new commit). A target branch that also has its own adds or deletes is 409
   `merge_conflict`: ply will not guess which rename git would pair. `allowEmpty` does not apply to that 409.
10. `POST /v1/revert` `{remote, ref?, commit, committer, message?, allowEmpty?}`.

An empty repository's HEAD is an unborn symref only when the server advertises `ls-refs=unborn` (git's default, and
git's own client sends the argument only then). The first HEAD read against an origin in an isolate pays one
`info/refs` GET so ply can see that bit (`git.upload-pack discover` in the trace, phase `ls-refs` in `x-artifacts-ray`
and `Server-Timing`). The bit is remembered for the isolate and passed back to ply, so later HEAD reads on that origin
are the ls-refs alone. A server configured `lsrefs.unborn=allow` or `ignore` is reported as an absent HEAD, matching
`git ls-remote`.

`GET /` prints the same sequence.
- JSON request bodies are capped at 1 MiB (413 above that). `WRITES` (a text binding in `cloudflare.config.ts`) must be `on` for the
  POST/DELETE endpoints; otherwise they return 501 `unsupported`.

## Errors

Every failure is JSON `{code, message, retry}`. `code` comes from ply's error table (`src/errors.ts`), and `retry` is
that table's policy: `yes`, `fresh` (re-read, then retry), `no`, or `read` (the push may have landed; read the ref
back first). Merge conflicts add `conflicts` and `reasons`. `match_count` adds `matches`. `auth` adds
`upstreamStatus`. `cas_conflict` adds `expected` and `actual` when known (`null` means the ref was to be, or is,
absent). `push_partial` adds `landed` and `rejected`. The table below covers every ply code (`src/status.ts` is
type-checked exhaustive against ply's `CODES`).

| code | HTTP | why this status |
|---|---|---|
| `bad_request` | 400 | input, including a refused remote |
| `auth` | 401 or 403, the upstream's own status | the caller needs to know whether its credential was missing or not good enough |
| `not_found` | 404 | ref, path or repo |
| `cas_conflict` | 409 | the branch moved, so re-read and retry (`retry: fresh`). git 2.50 and later say `incorrect old value provided`; ply classifies that string as `cas_conflict` |
| `ref_exists` | 409 | creating a branch or tag that already exists (`retry: no`). The body includes `oid`, the current target. Checked before the push, so a lost race that Artifacts reports as `stale ref` is mapped here too |
| `stale_expected` | 409 | deleting a ref whose `oid` is not the current target (`retry: fresh`). The body includes `expected`, `actual`, and `oid` (the actual) |
| `merge_conflict`, `not_fast_forward`, `push_rejected`, `push_partial` | 409 | conflict with the repository's current state |
| `match_count`, `lfs_pointer`, `not_linear`, `unrelated_histories` | 422 | the request is well-formed but cannot apply to this content. Retrying it unchanged cannot work, even against a fresh state. That is the difference from 409 |
| `limit_exceeded` | 413 | |
| `rate_limited` | 429 | |
| `upstream_5xx`, `network`, `protocol`, `pack_corrupt`, `not_git`, `remote_error`, `http`, `ambiguous` | 502 | the upstream misbehaved. Check `retry` before retrying: `ambiguous` is `read` |
| `timeout` | 504 | |
| `aborted` | 499 | the caller went away |
| `unsupported` | 501 | including writes when they are disabled |
| `read_only` | 403 | a write whose remote is in the public namespace, with or without a bearer or git credential |
| `internal` | 500 | a bug; an error without a known code is reported as this |

## Tracing

- `?trace=1` on a JSON endpoint adds `trace: [{name, ms, status, attrs, events}]` with ply's spans, the same OTLP
  spans ply emits anywhere.
- `/v1/read` streams raw bytes and has no JSON to carry spans. Instead, `?trace=1` adds an `x-ply-trace` header
  summarising every span that finished before the first byte, as `name;dur=ms, …`. The blob's own span finishes after
  the response is sent, so it shows up only in the request's log line (`stream: ok|error`).
- Every request writes one structured log line (`msg: "ply.request"`) with id, method, path, upstream **host** (never
  the path or the credential), status, ms, round trips, how many fetches used the blob:none fallback, and pack-cache
  hits. Workers Observability logs and traces are enabled, and `redact_query_string` keeps `remote=` out of the
  platform's request records. Each response carries `x-ply-request-id`.
- Every `/v1` response that talked to the remote, including 4xx and 5xx, carries `x-artifacts-ray` and `Server-Timing`.
  The ray header is the upstream `cf-ray` of each git HTTP exchange, in start order:

  ```
  ray-header = entry *( ", " entry ) [ ", " overflow ]
  entry      = phase "=" ray ";dur=" duration
  overflow   = "overflow=" 1*DIGIT
  phase      = "ls-refs" / "fetch" / "receive-pack"
  ray        = cf-ray / "-" / "no-response"
  cf-ray     = 16HEX "-" 3ALPHA
  duration   = 1*DIGIT
  ```

  `ls-refs` is info/refs and v2 ls-refs. `fetch` is each upload-pack fetch, including a blob:none retry. `receive-pack`
  is the advertisement and the push. `-` is a response with no ray id (the raw header is not echoed). `no-response` is
  a call that failed before headers. Past 32 entries the rest are `overflow=<count>`. `Server-Timing` repeats the same
  phases and durations, then `total` for the Worker. The matching spans gain `git.upstream.cf_ray`,
  `git.upstream.phase`, and `git.upstream.dur_ms`. The viewer sends the same header. It contains no URL, credential, or
  repository name.

## Servers that refuse `filter tree:0`

Cloudflare Artifacts refuses `filter tree:0`. ply learns this from the 400 and falls back to `blob:none`, which
brings more trees per fetch (see ply's README). The Worker keeps what it learned per origin for the life of the
isolate, so only the first request on an isolate pays for the 400.

## Public viewer (`/view`)

`GET /view` is a server-rendered browser for a **public** smart-HTTP repository. It does not use `PLY_TOKEN` and it
never reads `Authorization`, `Git-Token`, `Git-Authorization`, or `Cookie`. A URL with userinfo is rejected, not
turned into a credential. `/v1` is unchanged: same gate, same credential headers. `/v1` and the viewer share one isolate-wide, per-origin `quirks`
map (`src/quirks.ts`): a server that rejects `filter tree:0` costs that 400 and the `blob:none` retry once per isolate,
and later pages ask for `blob:none` directly (the waterfall says which). Until 2026-10-31 the viewer re-learned it on
every page; on Artifacts that 400 was ~110–150 ms of every page.

The home form accepts an https URL, `github.com/owner/repo`, `owner/repo` (github.com), or `git@host:path` (the ssh user is dropped, then the allowlist runs). Shareable URLs: `/view/<host>/<repo path>?ref=&path=` (`path` may use `/` or `%2F`). A path segment of `.` or `..`, a backslash, or an encoded slash, backslash, or dot in the URL path (and an encoded dot or backslash in `?path=`) is rejected on the raw URL, before the URL parser collapses it. `?raw=1` returns the file as `text/plain` or
`application/octet-stream` (never `text/html`). `?want=<oid>&filter=tree:0|blob:none&offset=` is the pack map.
Every HTML page ends with a collapsed **Diagnostics** section (`?trace=1` opens it): the raw remote, a waterfall of the
git round trips that produced the page on one shared timeline (call, filter, HTTP status, bytes, cache HIT, duration;
tap a row for wants, server agent and pkt-line counters), the protocol the server spoke, pack-map links, and the
`cf-ray` when the platform sends one. The Workers trace id is not readable inside the isolate.

The commit, its first-parent history (Recent commits, 10) and, on a server that refuses `tree:0`, every tree, come from
ONE fetch: `want <head> deepen 10` with `filter tree:0`, or `blob:none` on Artifacts. Measured on the same graphs on
GitHub (2026-10-30): curl `tree:0` deepen 10 is 6.1 KB; `blob:none` deepen 1 is 121.6 KB and deepen 10 is 129.0 KB
(+6%). Until 2026-10-30 the log fetched one commit per round trip and stopped after the first on Artifacts.

README and `.md` files render GitHub-flavoured markdown (tables, task lists, fenced code with a language label, nested
lists, quotes, reference and auto links) through `src/viewer/markdown.ts`: source text is only ever escaped, tags and
class names come from fixed sets in `safehtml.ts`, hrefs pass the scheme allowlist, and repository-relative links
resolve to viewer URLs. Images render as links (the CSP is `img-src 'none'`; a README must not make visitors fetch
third-party pixels). The stylesheet is served at a content-hashed URL, `/view.<sha1-prefix-12>.css` (`VIEWER_CSS_PATH`), with `cache-control: public, max-age=31536000, immutable`; HTML is `no-store`, so a page always links the sheet it was rendered with. `/view.css` and a previous deploy's hash still answer with the current sheet, `no-cache` plus an ETag. Icons carry `width`/`height` 16 so an unstyled page never draws them large. After every deploy run `node scripts/visual-smoke.mjs` (headless Chrome over CDP: 375 and 1280 px, light and dark; exits 1 on an SVG wider than 64 px, overflow, an unapplied or unhashed stylesheet, or a tree page without `li[data-oid]` rows; `STALE_CSS=<file>` emulates a browser holding an old `/view.css`). That sheet is Kumo's theme and base plus only the Kumo utilities `kumo-classes.ts` emits
(`kumoSubset`, 167.9 KB → 67 KB).

**Machine-readable markup (stable interface).** Styling and layout may change; these attributes do not, and
`test/viewer.test.ts` ("scraping contract") pins them against `git ls-tree`. Scrapers and monitors should use them, never
class names or visible text:

| Selector | Attributes | Meaning |
|---|---|---|
| `li[data-oid]` (tree page) | `data-oid` full 40-hex oid, `data-mode` as `git ls-tree` prints it (`100644`, `100755`, `120000`, `040000`, `160000`), `data-type` `blob`/`tree`/`commit`, `data-name` | one row per entry shown; the `..` row has none |
| `ul.files` | `data-path`, `data-entries` (entries in the tree), `data-shown` (rows rendered; less than `data-entries` when capped) | the listing |
| `[data-commit]` | full 40-hex oid | the commit the page shows |

Example: `curl -s 'https://ply.ivar.workers.dev/view/github.com/ivarvong/ply?path=src' | grep -oE '<li data-oid="[0-9a-f]{40}"' | wc -l`
matches `gh api repos/ivarvong/ply/git/trees/main:src --jq '.tree | length'`.

**Allowlist.** An unauthenticated Worker that will `fetch` a caller-supplied URL is an SSRF proxy, so the viewer
accepts https URLs whose hostname is an exact, case-insensitive match for `github.com`, `gitlab.com`,
`codeberg.org`, `bitbucket.org`, or `git.sr.ht`. No suffix, no wildcard, no userinfo, default port only. A
trailing dot (`github.com.`) does not match. Lookalikes (`github.com.evil.com`, `evilgithub.com`, punycode)
do not match. Everything else is rejected before a fetch, and the error lists the supported hosts.
`VIEWER_EXTRA_HOSTS` appends exact hostnames (comma-separated). A token with a scheme, port, userinfo, wildcard,
or trailing dot is skipped, not treated as a suffix. Cloudflare Artifacts is off unless that variable names the
exact public git host. `ALLOW_REMOTE_ORIGINS` is a `/v1` test hook and does not apply to `/view`. Redirects are
manual, re-checked against the same allowlist, and limited to that repo's `info/refs` and `git-upload-pack`
paths (plus a `.git` suffix). `createViewerFetch` follows them before ply sees the response (ply refuses any 3xx). A redirect whose raw `Location` contains `.`, `..`, `%2e`, `%2f`, or `%5c` is not followed, and a redirect to any other host is not followed. Upstream `User-Agent` is
`ply-viewer/0.1.0`.

**Caps** (not raised by environment; rate limits can be lowered and are clamped to 1…1000):

| Cap | Value |
|---|---|
| upstream bytes / page | 4 MiB |
| pack bytes mapped | 2 MiB |
| pack objects mapped | 400 |
| inflated bytes / pack | 4 MiB |
| one object | 1 MiB |
| file shown or returned raw | 256 KiB |
| delta chain | 32 |
| delta result | 1 MiB |
| upstream calls / page | 16 |
| redirects / upstream call | 2 |
| per-call timeout | 12 s |
| page timeout | 20 s |
| refs retained | 2000 (200 branches shown) |
| tree entries retained / shown | 2000 / 500 |
| parent commits shown | 5 |
| page rate | 60 / minute / client |
| pack-map rate | 20 / minute / client |

Over any cap the response is an HTML error (413 for a limit, 504 for a timeout), with the trace of the calls that
did finish. Rate limiting is a Durable Object, `ViewerRateLimit`, declared as a SQLite class. It is sharded by the
SHA-256 of `CF-Connecting-IP` (clients with no header share one shard). Each shard stores a short list of
timestamps per bucket, not addresses.
Git reads are cached with Workers Caching (see [Caching](#caching-workers-cache)); there is no Cache API anything. HTML is `no-store` and escaped. CSP is `default-src 'none'; style-src 'self'; script-src 'none'; img-src 'none'`,
plus `X-Content-Type-Options: nosniff`. There is no inline script and `unsafe-inline` is not allowed.

`cloudflare.config.ts` declares `ViewerRateLimit` as a live SQLite class in `worker.exports`. The namespace already exists (created by migration tag `v1-viewer-rate`, namespace id `656fdd50f0d6428393eb2d9250ceee67`). Declaring it keeps that namespace and its data.

## Public namespace (`public-v0`)

One Cloudflare Artifacts namespace is served publicly and read-only. Its name is one constant,
`PUBLIC_NAMESPACE` in `src/public-namespace.ts`; `cloudflare.config.ts` binds that namespace and `src/public.ts` matches
URLs under it, so moving to `public-v1` is a one-line change (plus creating the namespace and publishing into it).

- **URLs.** `GET /r` and `GET /r/` are the styled index of the namespace. `GET /r/<repo>` is the canonical viewer page
  for that repo (`ref` is the only ref parameter; `at` and `commit` redirect to it). A name that is not in the namespace
  is a styled 404 and is not redirected. The long
  `/view/5ad2236b39de4c8bd8f6270ea63f3ea9.artifacts.cloudflare.net/git/public-v0/<repo>.git` form redirects to `/r/<repo>`.
  The home page (`/view`) also lists the namespace (binding `list()`, cached a minute per isolate). The viewer
  accepts that Artifacts host without `VIEWER_EXTRA_HOSTS`, but only for one repo directly under `/git/public-v0/`; any
  other path on the host (another namespace, a nested path, `..` or an encoded separator) is a 400 before any fetch.
- **`/v1` reads.** `refs`, `discover`, `tree`, `read`, and `commit` need no bearer when the request has **no
  `Authorization` header at all** and `remote` is exactly `https://<that host>/git/public-v0/<repo>(.git)`. These requests
  share the viewer's per-client page bucket (60/min, `ViewerRateLimit`). A caller git credential on such a request is a
  400 (send none, or use the bearer). A wrong bearer is still a 401. With a valid bearer nothing changes from the
  rules above: no rate limit, and the public token is used when the caller sends no git credential of their own.
  Rationale: the content is public by construction, the remote can only be one of our own repos, the Worker holds only
  a read credential for it, and the rate limit bounds cost. Every other `/v1` request still needs the bearer.
- **Writes.** Every write endpoint whose `remote` is anywhere under `/git/public-v0/` on that host (compared
  case-insensitively, any depth) returns 403 `read_only`. That holds with a valid bearer and with a caller's own write
  credential, and nothing is sent upstream. Without a bearer a write is the usual 401.
- **Credential.** No stored secret. The Worker has an Artifacts binding `PUBLIC_REPOS` scoped to `public-v0` and calls
  only `get(<repo>).createToken("read", 3600)` and `list()`. Artifacts tokens are per repo; there is no namespace-wide or
  non-expiring read token (TTL 60 s … 1 year, default 24 h). Tokens are cached per isolate per repo and re-minted with
  less than 5 minutes left, so rotation is automatic and an isolate holds at most one live token per repo (plus
  retired ones, kept only so the scrubber still removes them). A read token is refused by `git-receive-pack` (403,
  checked 2026-10-30).
- **Where the token goes.** `withPublicReadCredential` (`src/public.ts`) is the innermost fetch, below
  `createGuardedFetch` and `createViewerFetch`, so it runs on every request and on every redirect hop. It adds
  `Authorization: Bearer <token>` only when the raw URL's origin is exactly `https://<that host>` (no `:443`, no
  uppercase, no trailing dot, no userinfo), the raw path is exactly `/git/public-v0/<repo>(.git)/info/refs` with query
  `?service=git-upload-pack` and method GET, or `…/git-upload-pack` with no query and method POST, and the path has no
  `.`/`..` segment, `%`, backslash or control character. `receive-pack` never matches. When the request already carries
  an `Authorization` (a caller's `Git-Token` or `Git-Authorization`), the caller's credential is used and the Worker's
  token is not added. The pack cache sits above the guard, so its key has no Authorization and survives rotation.
- **Scrubbing.** Every minted token (full, without `?expires=`, Basic-encoded, URL-encoded) is scrubbed from every
  `/v1` JSON body, every viewer HTML/text body and header, and every log line. Blob bodies are not rewritten: they are
  git objects whose hash ply checked. `test/public-worker.test.js` greps every response and the workerd log for each
  form, including against a host that echoes the header back.
- **Revocation.** Tokens expire within an hour. To cut every Worker token off at once, revoke them per repo
  (`cf artifacts namespaces repos tokens list --namespace public-v0 --name <repo>` and
  `cf artifacts namespaces tokens revoke <id> --namespace public-v0 --force`); the Worker mints new ones on the next
  request. To take the namespace offline, remove the binding and deploy.

### Mirrors that follow GitHub

`public-v0/ply` and `public-v0/ply-web` follow their GitHub `main` (`src/mirror.ts` `MIRRORS`). A Worker cron
(`* * * * *`) compares the two refs; when they differ it fetches only the new objects from GitHub (`want <github tip>`,
`have <mirror tip>`, anonymous) and pushes them to the mirror as a CAS update from the mirror's tip (a rewritten
upstream is followed). The write token is minted through the namespace-scoped binding for that one repo with the
minimum TTL (60 s) and revoked as soon as the push returns. No token lives in CI or in the repo. One log line per mirror
per minute: `{"msg":"ply.mirror", repo, outcome: in-sync|updated|error, from, to, objects, pushBytes, ms}`.
`MIRROR_SYNC="off"` stops it. An update over 32 MiB is refused (logged); publish that with the script below.

### Publish a repo

```sh
env -u CLOUDFLARE_API_TOKEN node scripts/publish.mjs <repo> <source> [--branch main] [--tags]
# e.g. the ply mirror:
env -u CLOUDFLARE_API_TOKEN node scripts/publish.mjs ply https://github.com/ivarvong/ply.git
```

The script uses your `cf` login (OAuth). It creates `public-v0/<repo>` if missing (and revokes the 24 h write token that
creation returns), clones the one branch bare, mints a **write token for that repo only, with a 10-minute TTL**, and
force-pushes the branch (and tags with `--tags`) with stock git. The token reaches git only through `GIT_CONFIG_*`
environment variables, never argv, a file, or stdout. The script revokes it afterwards. The Worker never holds a write
token. Re-run the same command to update a mirror. Artifacts limits apply (64 MiB per push, 1 GB per repo).

## Caching (Workers Cache)

Workers Caching only, never the Cache API (`caches.default`): `test/gitcache.test.ts` fails on any `caches.` in `src/`.

```
eyeball ─▶ default entrypoint (cache OFF: always runs → rate limit, ply.request log, scrub, traces)
             └─ ply ─▶ redirect guard (createGuardedFetch / createViewerFetch: every hop re-validated)
                        └─ createLoopbackFetch (src/gitcache.ts)
                             ├─ public + no Authorization + pure function of its request ─▶ ctx.exports.GitCache (cache ON) ─▶ upstream
                             └─ anything else (every caller credential, haves, other hosts) ─────────────────────────▶ upstream
```

- **What may be cached:** an upload-pack exchange with **no Authorization header** whose URL is exactly a public-v0 repo
  endpoint, or an upload-pack endpoint on a built-in viewer forge (github.com, gitlab.com, codeberg.org, bitbucket.org,
  git.sr.ht). A caller's `Git-Token` / `Git-Authorization` becomes an Authorization header, so a credentialed read always
  goes straight upstream and can never populate a key. GitCache re-checks the same rule, and attaches the public-v0 read
  token itself.
- **Policy** (`Cache-Control` from GitCache):

  | kind | exchange | Cache-Control |
  |---|---|---|
  | `pack` | `command=fetch` with wants only (no have / shallow / want-ref / deepen-since / deepen-not) | `public, max-age=31536000, immutable`: objects are named by their hash |
  | `refs` | `command=ls-refs` | `public, max-age=5, stale-while-revalidate=10`: a ref change shows within 15 s |
  | `discover` | `GET info/refs?service=git-upload-pack` | v2 capability list: `public, max-age=300, stale-while-revalidate=3600`; a v0 advertisement (carries refs): the refs policy |
  | `pack` | a 400 whose text is a partial-clone filter refusal (Artifacts: `only blob:none is supported`) | `public, max-age=3600`: a fact about the server; uncached, every fresh isolate paid it (11 of 13 GitCache runs in a 20-request cold burst, e021776d) |
  | — | any other non-200, any 3xx | `no-store` (3xx goes back to the guard; GitCache never follows) |

- **Keys:** `/v<CACHE_VERSION>/<kind>/<sha256(kind, url, git-protocol, body)>`. The upstream request travels in headers
  (not part of a Workers Cache key); GitCache recomputes the hash and refuses a mismatch, so no request can store an
  answer under another's key. `crossVersionCache` is on (deploys keep packs warm); `CACHE_VERSION` (`src/cache-version.ts`)
  is the only partition: bump it when what GitCache stores changes.
- **Poison:** ply re-verifies every object; after a corrupt cached pack it retries with `x-ply-cache: bust`, which purges
  that key (`ctx.cache.purge({ pathPrefixes })` inside GitCache) before refetching.
- **Observability:** the tier (`cf-cache-status`: HIT, MISS, EXPIRED, …) reaches ply as `x-ply-pack-cache`, so every
  span carries `git.response.cache`, the viewer waterfall shows it, and `ply.request` logs count `cache_hits`. A HIT
  never runs GitCache, so it leaves no GitCache invocation.
- **Whole responses pinned to a commit** (`src/pinned.ts`, cache-enabled `Pinned` entrypoint): viewer raw files
  (`?raw=1&ref|at=<40-hex>&path=`) on `/view/…` or `/r/<repo>`, for public-v0 or a built-in forge. The front door rate-limits and logs, then fetches the
  canonical key `/v<CACHE_VERSION>/pinned<path>?<allowed params, sorted>` from Pinned. Pinned rebuilds the request from
  the key alone (it reads no header, so no credential can reach it), runs the same handler, and answers `immutable` on a
  200, `no-store` otherwise. Responses carry `x-ply-pinned-cache` (the tier). HTML pages are not cached whole: they render
  times relative to the request and carry that request's waterfall, cf-ray and id. Their git parts are cached.
- `PACK_CACHE=off` sends everything direct.

## Develop / deploy

```sh
npm test                                 # /v1 + public-namespace workerd suites, then the viewer/security/public unit suites
npm run dev                              # cf dev: Vite + the Cloudflare plugin on local workerd
npm run typecheck                        # tsc for the app, then cf workers types + tsc for cloudflare.config.ts
npm run worker:deploy:dry-run            # cf deploy --dry-run: build and validate, no credentials, no upload
scripts/deploy.sh "<message>"            # prod: gate, upload, 0% canary smoked pinned + telemetry gate, promote, smoke (below)
npm run worker:deploy                    # cf deploy straight to 100% (no canary; emergencies only)
node src/smoke.mjs https://ply.ivar.workers.dev gate                     # public + auth + allowlist checks, no Artifacts
env -u CLOUDFLARE_API_TOKEN node src/smoke.mjs https://ply.ivar.workers.dev read|write --out smoke.json
```

`scripts/deploy.sh` (OAuth: it runs cf with `CLOUDFLARE_API_TOKEN` unset) deploys the checked-out commit: gate, `cf workers versions create --prebuilt`, a deployment with the new version at 0% beside the current one at 100%, then `smoke.mjs gate|read|write --version <id>` and `visual-smoke.mjs` with `PLY_VERSION=<id>` (every request carries `Cloudflare-Workers-Version-Overrides: ply="<id>"`), then `scripts/canary-o11y.mjs`, which requires every smoke `x-ply-request-id` in a `ply.request` log line of the new version and 0 non-ok invocations, 0 5xx, 0 error logs. A failure routes 100% back to the previous version. Then it promotes, smokes unpinned and re-runs the telemetry gate; a failure there also routes back.

`read` and `write` each create a scratch Artifacts repo in namespace `default` (`src/smoke-seed.mjs`), seed it with a fixed history (fixed identities and dates, so the seeded oids are the same every run), mint a 15-minute read or write token for it, compare the Worker's answers with that seeded local clone, then revoke every token and delete the repo, also on failure or Ctrl-C. A run killed harder than that leaves `ply-web-smoke-*`; the next run deletes ones older than an hour. Tokens go to git only through `GIT_CONFIG_*` and never reach argv, stdout or the JSON report. Runs are repeatable back to back. They need a cf login with Artifacts access.

The Worker is built and deployed with the Cloudflare CLI, [`cf`](https://developers.cloudflare.com/cf/), pinned as a dev dependency. `cloudflare.config.ts` is the Worker config (name, compatibility date, bindings, Durable Object exports, observability, limits). `vite.config.ts` holds build settings only: `cf build` delegates bundling to Vite and the Cloudflare Vite plugin and writes Build Output to `.cloudflare/output`. The workerd suites in `npm test` run that same bundle (`test/cf-bundle.js`). Nothing here needs Docker: the Vite plugin runs `docker image ls` after every build even with no containers (execFileSync, no timeout, so a hung daemon hung the build), and `vite.config.ts` sets `WRANGLER_DOCKER_BIN=false` so that call fails at once and is skipped.

`npm run worker:deploy` runs `cf deploy`. When `CLOUDFLARE_API_TOKEN` is set, cf uses it. When it is unset, cf uses the OAuth session from `cf auth login`. The command uploads the Worker named `ply`: text bindings `WRITES` and `PACK_CACHE`, the `ViewerRateLimit` Durable Object, observability, `limits.cpuMs`, and `workersDev`. Worker secrets survive a deploy (the upload sends `keep_bindings: ["secret_text", "secret_key"]`). `PLY_TOKEN` stays a secret. Set or rotate it with `cf workers secrets update PLY_TOKEN --worker ply --type secret_text`. cf prompts for the value, so it never lands in shell history.

cf has no live log stream yet (no equivalent of `tail`). Use the dashboard's live logs, or Workers Logs, which this Worker sends through `observability.logs`.

### GitHub Actions

`bump-ply.yml` moves the `ply` git pin to the current `main` of [ivarvong/ply](https://github.com/ivarvong/ply). It runs on `repository_dispatch` (`ply-main-updated`), `workflow_dispatch`, and a daily cron (`0 16 * * *` UTC) for a dispatch that never arrived. It resolves `refs/heads/main` over the public git protocol, writes that 40-hex SHA into `package.json` and `package-lock.json`, then runs `npm test`, Oxlint, `npm run typecheck`, and `cf deploy --dry-run`. The dry run builds the Worker and validates it without credentials or API calls. When the pin is already that commit, the job stops. When the checks pass, it commits the pin straight to `main`. This repository's `main` is not a protected branch (`protected: false`, no rulesets), so a direct push is the whole publish step. A pull request would wait on a review that `GITHUB_TOKEN` cannot approve. A ruleset that later rejects the Actions token fails this job before `deploy.yml` starts. When the checks fail, the workflow opens an issue titled `ply bump failed for <sha>` (or comments, when that issue is already open) and leaves `main` unchanged.

A push made with `GITHUB_TOKEN` does not start `on: push` workflows. After the bump commit lands, `bump-ply.yml` starts `deploy.yml` with `workflow_dispatch`. Any other push to `main` starts `deploy.yml` from `on: push`.

`deploy.yml` runs the same checks, then `cf build --mode production` once, `cf deploy --prebuilt --mode production --dry-run` on that Build Output, and `cf deploy --prebuilt --mode production` to upload exactly what was checked. Only the upload step sees the secrets. The version is tagged with the 12-hex commit prefix. When `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` is unset, the deploy job prints a notice and exits successfully, before cf runs.

### Cloudflare token

`cloudflare.config.ts` has no `accountId`. In a non-interactive job, cf takes the account from `CLOUDFLARE_ACCOUNT_ID`. Without it, a token that can see more than one account stops before upload. Add both values as Actions secrets on **ivarvong/ply-web** (Settings → Secrets and variables → Actions).

| Secret | Where | What it is |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ply-web Actions secret | Account → **Workers Scripts: Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | ply-web Actions secret | Account id of the account that owns the `ply` Worker |

Workers Scripts Edit is the user-token permission name. An account-owned token lists the same grant as **Workers Scripts Write**. The [script upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/) and [`GET /accounts/:account_id/workers/subdomain`](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/) (cf calls that because `workersDev` is true, and `ply.ivar.workers.dev` already exists) both accept it. Scope the token to this account. The Worker already exists, so the deploy is an update: Editor on the `ply` Worker is enough for a per-Worker token. Creating the Worker the first time would need Admin at the Workers product scope.

Nothing else in this config asks for a permission:

- No routes and no custom domains, so no Zone → Workers Routes → Edit.
- No KV, R2, D1, Queues, or Secrets Store bindings.
- The Artifacts binding `PUBLIC_REPOS` (namespace `public-v0`). The OAuth deploy of 2026-10-30 uploaded it; whether a
  scoped CI token needs an Artifacts permission on top of Workers Scripts Edit has not been checked.
- Durable Objects have no token permission of their own. `ViewerRateLimit` follows the Worker.
- Observability, `limits.cpuMs`, the Worker cache settings (`cache`, per-entrypoint `exports`), and the `WRITES` / `PACK_CACHE` text bindings travel in the script upload.
- Workers Tail Read is the permission for live log streaming, which this workflow does not use.

### Companion workflow in ivarvong/ply

ply's `main` should wake ply-web on every push, so the pin updates without waiting for the cron. Add this file as `.github/workflows/notify-ply-web.yml` in ivarvong/ply. On push to ply `main` it POSTs `repository_dispatch` (`event_type: ply-main-updated`, `client_payload.sha` set to that commit) to `ivarvong/ply-web`. When the secret is missing it prints a notice and exits successfully. ply-web resolves ply `main` itself when it wakes up; the payload sha is the commit that was pushed.

```yaml
name: Notify ply-web

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  dispatch:
    runs-on: ubuntu-24.04
    steps:
      - name: Dispatch ply-main-updated
        env:
          PLY_WEB_DISPATCH_TOKEN: ${{ secrets.PLY_WEB_DISPATCH_TOKEN }}
        run: |
          set -euo pipefail
          if [ -z "${PLY_WEB_DISPATCH_TOKEN}" ]; then
            echo "::notice title=ply-web not notified::PLY_WEB_DISPATCH_TOKEN is not set. Add a fine-grained PAT with Contents: Read and write on ivarvong/ply-web. This push did not send repository_dispatch."
            exit 0
          fi
          # GITHUB_SHA is the commit just pushed. ply-web resolves main itself.
          GH_TOKEN="${PLY_WEB_DISPATCH_TOKEN}" gh api --method POST repos/ivarvong/ply-web/dispatches --input - <<EOF
          {"event_type":"ply-main-updated","client_payload":{"sha":"${GITHUB_SHA}"}}
          EOF
```

Secret, on **ivarvong/ply** (the sender, not ply-web): `PLY_WEB_DISPATCH_TOKEN`. A fine-grained personal access token restricted to the `ivarvong/ply-web` repository, with **Contents: Read and write**. That is the permission GitHub requires for `repository_dispatch`.
