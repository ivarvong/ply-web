# Git logic still in ply-web

ply-web drives [ply](https://github.com/ivarvong/ply). General git logic belongs in ply. This file is the inventory of what is still here after ply `af5cac03`.

Each numbered step is one ply change. It names the ply issue, the functions ply-web still owns, and the API that lets ply-web delete that workaround in the next ply-web PR. A step depends only on steps above it (or on ply that has already shipped). Independent steps can land in parallel; the order is the one that lets each deletion compile on its own.

ply issues [#112](https://github.com/ivarvong/ply/issues/112)–[#125](https://github.com/ivarvong/ply/issues/125), [#103](https://github.com/ivarvong/ply/issues/103), [#111](https://github.com/ivarvong/ply/issues/111), and [#100](https://github.com/ivarvong/ply/issues/100) already exist. This document does not open new ones. Two leftovers have no issue; they are called out at the end. Do not file them from a ply-web change.

ply [#126](https://github.com/ivarvong/ply/issues/126) orders ply's own work differently (correctness in the read path first). This list is the consumer order: after each ply PR, ply-web can delete exactly one workaround.

## Already gone in this PR

| Removed | Replaced by |
| --- | --- |
| `head.ts` spoke unborn ls-refs itself (`unbornLsRefsBody`, `parseHeadLine`, `headFromLines`) | `readHead` calls `lsRefs(t, ['HEAD'], { unborn: true, info })`. `headFromListing` only classifies the result. |
| `pick.ts` `treeMap`, `imagesMatch`, `patchApplied`, and the `merge_conflict` catch that rewrote an already-applied pick as empty | `mapPickOutcome` is exhaustive over ply's `PickOutcome`: `empty`, `ok`, or `kept_empty`. `merge_conflict` is thrown and is HTTP 409. |
| `identity.ts` `parseTz`, and `IDENT_TZ_*` / `LS_REFS_*` in `constants.ts` | `validateIdent` owns the zone. `stamp` passes `tz` through. |
| `handle.ts` `sameStamp` on merge and rebase (one identity, one timestamp) | `author` and `committer` are separate `plyStamp`s. `from` and `onto` go through `refOrCommit` (branch name or 40-hex). |
| `pick.ts` `writeEmpty`, `load`, `messageBody` | `allowEmpty` passes ply `empty: 'keep'`. `mapPickOutcome` maps `kept_empty` to an applied cherry-pick or revert. `empty` still writes nothing. |
| `src/write/oid.ts` (`Oid`, `ZERO_OID`, `isOid`, `isZeroOid`, `asOid`, `parseCommitOid`) | ply `parseOid`, `parseCommitId`, `ZERO_OID`, and `Oid`. `request.ts` keeps its own `bad_request` text. Mode constants and the hex patterns in `abbrev.ts`, `pinned.ts`, and `version.ts` stay. |
| `branch.ts` `tipOf`, `tag.ts` `commitOf`, `commit.ts` `commitOf` (regex and code maps) | `fetchCommit`, then a match on `miss.kind`. A commit id is `commit` (nested `absent` or `not_commit`). Every other kind stays that `not_found`. `pack_corrupt` and every other code are thrown through. |

`src/hold-last.ts` stays. ply [#111](https://github.com/ivarvong/ply/issues/111) is still open.

## HEAD read: the extra discover GET

`lsRefs` sends `unborn` only when `discover()` reports `ls-refs=unborn` (git's `server_supports_feature` rule). Passing a made-up `info.lsRefsUnborn: true` would skip the GET and would be wrong for a server whose `lsrefs.unborn` is `allow` or `ignore`: git does not send `unborn` then, and ply's tests lock that.

`readHead` calls `discover` once per origin per isolate, remembers the boolean (256 origins, same bound as `quirks.ts`), and passes it back as `info`. That is ply's option for a discover result already in hand. It does not parse the advertisement.

Measured in `test/worker.test.js` on an origin the isolate has not seen (`raySrv`; `srv` is already warm from the missing-repo commit read earlier in the file):

- Cold `GET /v1/commit` on an empty repo: ply's `readCommit` returns the empty commit. Exactly one span named `git.upload-pack discover`. There is no `git.head` span; that span is the Worker's own HEAD read. Server-Timing still has `ls-refs;dur` and `total;dur`.
- Warm `GET /v1/commit?ref=main` on the same origin: ply discovers again (it does not use the Worker's advertisement cache). The Worker records `ls-refs=unborn` for the origin, so the root commit that follows pays no second discover.
- `x-artifacts-ray` has the same number of `ls-refs` entries on the cold and warm commit reads. The info/refs GET is inside ply's read, on both.

`git.head` is a parent span (kind, ref, oid, whether discover was cached). It is not in `SPAN_PHASE`, so it does not take an `x-artifacts-ray` slot. The discover span and the ls-refs span each match one HTTP exchange.

A server that does not advertise `ls-refs=unborn` is an absent HEAD, which is what `git ls-remote` reports. git http-backend's default is `advertise`.

## Landing order

### 1. Cherry-pick `--keep-redundant-commits` — ply #117

Landed with ply `af5cac03`. `writeEmpty` is gone. The notes below are the API that replaced it.

Depends on nothing new. ply `1274f2d` already returns `outcome: 'empty'`.

| | |
| --- | --- |
| File | `src/write/pick.ts` |
| Functions | `writeEmpty`, `load`, `emptyResult`, `messageBody` |
| What it does | When `allowEmpty` is set and ply says the pick is empty, ply-web fetches the tip and the picked commit, builds a commit with the tip's tree and the tip as parent (author is the picked commit's author line, or the committer for a revert), and pushes it. `mapPickOutcome` stays: it is the HTTP mapping, not git. |

```ts
pickCommit(url, { ref, commit, committer, message, empty?: 'stop' | 'keep' }, opts)
// 'stop' (default): outcome 'empty' | 'ok'
// 'keep': outcome 'kept_empty' | 'ok'
//   kept_empty: { ref, oid, tree, onto, pushBytes }
// merge_conflict stays a thrown PlyError (not a result)
```

`revertCommit` takes the same `empty` field. ply-web then maps `empty` → `{ outcome: 'empty', noop: true }` and `kept_empty` → `cherry_pick` or `revert`.

### 2. Oid and mode vocabulary — ply #125

The oid half landed with ply `af5cac03` (`oid.ts` is gone). Mode constants and the hex patterns in `abbrev.ts`, `pinned.ts`, and `version.ts` are still here.

Depends on nothing.

| | |
| --- | --- |
| Files | `src/write/oid.ts` (`Oid`, `ZERO_OID`, `isOid`, `isZeroOid`, `asOid`, `parseCommitOid`); `src/write/constants.ts` (`OID_BYTES`, `OID_HEX_CHARS`, `MODE_BLOB`, `MODE_EXEC`, `MODE_LINK`, `MODE_TREE`, `BLOB_MODES`); the same `/^[0-9a-f]{40}$/` in `src/abbrev.ts` (`FULL_OID`), `src/pinned.ts` (`OID`), `src/version.ts` (`SHA1_HEX`) |
| What it does | Mode constants and the local hex patterns re-declare facts ply also exports. `OP_*` in `constants.ts` are HTTP op names and stay. `version.ts` checks a build-injected SHA, not an object id; it keeps its local pattern. |

```ts
export type Oid = string & { readonly __oid: unique symbol }
export const ZERO_OID: Oid
export function parseOid(value: unknown): Result<Oid, PlyError>       // 40 lowercase hex; bad_request otherwise
export function parseCommitId(value: unknown): Result<Oid, PlyError>  // parseOid, and bad_request on ZERO_OID
export { OID_HEX_CHARS, MODE_BLOB, MODE_EXEC, MODE_LINK, MODE_TREE, MODE_COMMIT, BLOB_MODES }
```

### 3. Public types — ply #100

Depends on nothing. ply #91 (in flight at the #126 handoff) covers the byte-variance half.

| | |
| --- | --- |
| Files | `src/write/bytes.ts` `arrayBufferBytes`; the `fetchPack` → `push` cast in `src/mirror.ts` `syncMirror`; `src/viewer/ply.ts` `loose`, `makeTracer` (`Tracer` constructed through `unknown`), `spanCollector` (`arrayExporter` cast) |
| What it does | Works around `.d.ts` gaps: the exporter is typed `() => void` but receives each span line; `fetchPack` objects cannot be passed to `push` without a cast. Cursor casts in `viewer/ply.ts` (`cursorInit` / `cursorStep` / `cursorFinish` / `inflateObject` / `streamPack`) stay until step 13. |

Acceptance from the issue: a consumer type-test with no casts for `fetchPack` → `push`, `spliceDelta` → `zlibDeflate`, a `Tracer` exporter that takes the line, and `import type { Transport } from 'ply'`.

### 4. Hold the last blob chunk — ply #111

Depends on nothing. **This workaround stays in this PR.** It blocks step 13.

| | |
| --- | --- |
| Files | `src/hold-last.ts` `holdLastChunk`; the wrap in `src/index.js` `GET /v1/read` |
| What it does | `openBlob` emits every chunk before `flush` checks the object hash and the pack trailer. ply-web holds the last chunk until the source ends, and errors the stream without releasing it when verification fails. A `Content-Length` client then cannot finish on unverified bytes. |

No new function name. `openBlob`'s stream holds its final chunk until the hash and trailer verify; on failure it errors without releasing that chunk. The exported form in step 13 carries the same guarantee.

### 5. Commit existence — ply #112

Landed with ply `af5cac03`. `tipOf` and both `commitOf` helpers call `fetchCommit` and match `miss`. The notes below are the API that replaced the regex and code maps.

Depends on nothing. Blocks steps 6, 8, and 9.

| | |
| --- | --- |
| Files | `src/write/branch.ts` `tipOf`; `src/write/tag.ts` `commitOf`; `src/write/commit.ts` `commitOf` |
| What it does | `fetchObject(..., { expectType: TYPE.COMMIT })`, then maps errors by code and message. `commit.ts` maps `pack_corrupt` only when the message matches `/expected commit/`. `branch.ts` and `tag.ts` map **any** `pack_corrupt` and any `remote_error` to `not_found`. That second form turns a corrupt pack (retry `yes`) into `not_found` (retry `no`). |

```ts
export type CommitMiss =
  | { readonly kind: 'absent'; readonly oid: string }
  | { readonly kind: 'not_commit'; readonly oid: string; readonly type: 'tree' | 'blob' | 'tag' }

export function fetchCommit(t: Transport, oid: string): Promise<
  Result<{ oid: string; data: Uint8Array; commit: Commit }, PlyError>
>
// not_found detail: { miss: CommitMiss }
// pack_corrupt, remote_error, and every other code pass through unchanged
```

`absent` comes from the protocol (`ERR … not our ref`), recognised in the fetch state machine. `not_commit` comes from the object type, before any `pack_corrupt` is built.

### 6. Typed misses, including an unborn HEAD — ply #115

Depends on step 5 (`CommitMiss`) and on `lsRefs({ unborn: true })`, which shipped in `1274f2d`.

| | |
| --- | --- |
| Files | `src/write/head.ts` (`readHead`, `headFromListing`, `lsRefsUnbornOf`, `rememberUnborn`); `src/write/handle.ts` (`readHeadState`, `bornRef`, `clarifyUnborn`, `readCommitOrEmpty`, `unbornFields`); `src/read-status.ts` (`isDirectoryRead`, `directoryReadMessage`); `src/viewer/failure.ts` (`refNamed`, `pathNamed`, `failurePart`); `src/viewer/session.ts` (the path walk inside `loadTree`, `refMiss`) |
| What it does | Recovers *why* a read missed by matching ply's message, and runs a second unborn ls-refs (`clarifyUnborn`, `readCommitOrEmpty`, `unbornFields`) when `not_found` might be an empty branch. `read-status.ts` turns `not_found` + `/ is a directory$/` into HTTP 400. The viewer walk reports `{ missing, existingPath, notDirectory }` and a submodule (`mode 160000`) by reimplementing the path walk. |

```ts
export type Miss =
  | { readonly kind: 'ref'; readonly ref: string; readonly candidates: readonly string[] }
  | { readonly kind: 'head_unborn'; readonly target: string }
  | { readonly kind: 'head_absent' }
  | { readonly kind: 'path'; readonly missing: string; readonly existingPath: string }
  | { readonly kind: 'not_directory'; readonly path: string; readonly mode: string }
  | { readonly kind: 'is_directory'; readonly path: string; readonly tree: string }
  | { readonly kind: 'submodule'; readonly path: string; readonly commit: string }
  | { readonly kind: 'commit'; readonly miss: CommitMiss }
  | { readonly kind: 'repository' }

// readCommit on an unborn HEAD, or that branch by name:
//   ok({ empty: true, ref })    // not not_found
export function walkPath(t: Transport, treeOid: string, comps: readonly string[], opts?: { cache?: Map<string, Uint8Array> }): Promise<
  Result<{ tree: string; entry: TreeEntry | null }, PlyError /* not_found carries Miss */>
>
```

`not_found`'s `Detail` is `Miss`. ply-web switches on `miss.kind` and deletes `head.ts`. The per-origin `lsRefsUnborn` cache has no ply issue of its own: it is process policy, like `quirks.ts`, and it dies with `head.ts`. A server that does not advertise `unborn` stays `head_absent`.

### 7. Abbreviated commit ids — ply #114

No dependency on step 6. It sits on the same read path and can land beside it.

| | |
| --- | --- |
| Files | `src/abbrev.ts` (`isAbbreviatedOid`, `matchAbbreviatedOid`, `ADVERTISED_REF_PREFIXES`); the extra ls-refs in `src/index.js` before `GET /v1/tree|read|commit`; `src/viewer/session.ts` `resolveRef` (the `isAbbreviatedOid` branch) |
| What it does | A 7–39 hex prefix is resolved against one ls-refs of `HEAD`, `refs/heads/`, and `refs/tags/` (oid and peeled). One hit rewrites `ref` to the full oid. Zero or many hits are `bad_request`. The handler then calls `resolveCommit`, which ls-refs again. Unique-among-advertised-tips is weaker than `git rev-parse`: an interior object that shares the prefix is invisible here. |

```ts
export type AbbrevResolution =
  | { readonly kind: 'unique_among_advertised'; readonly oid: string; readonly refs: readonly string[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly oids: readonly string[] }

export function resolveAbbrev(prefix: string, refs: LsRefsResult): Result<AbbrevResolution, PlyError>
// bad_request when prefix is not 4..39 lowercase hex

resolveCommit(t, ref, { abbrev?: 'advertised' | 'off' })
// one ls-refs; a ref name wins over an oid prefix (git's ref_rev_parse_rules)
```

### 8. editFile: create, delete, rename, root commit, distinct committer — ply #103 item 2

Depends on step 5 so a 40-hex base that is not a commit is `CommitMiss`, not a message match.

Items 1, 3, and 5 of #103 are done (`lsRefs` unborn, empty rename pick, `encodeTag`). Item 4 is done for `mergeBranch`, `rebaseBranch`, and `pickCommit` (separate stamps, 40-hex `from` / `onto`). Item 4 is still open for `editFile`: it stamps one identity (`author` line for both, `time` as a separate argument).

| | |
| --- | --- |
| Files | `src/write/tree.ts` (`emptyDir`, `putAt`, `removeAt`, `renameAt`, `encodeMem`, `replaceOnce`, and the `Mem` walk); `src/write/commit.ts` (`resolveTarget`, `resolveParent`, `applyOne`, `referencedBlobs`, `expandDirs`, `commitEdit`, `encodeCommit` for every change that is not a single find/replace); `src/write/identity.ts` `plyPerson` |
| What it does | A single find/replace on an existing file calls `editFile` and therefore cannot set a distinct committer (`streamEdit` passes `plyPerson` and the author's time). Create, delete, rename, a root commit (missing ref, old oid zero), a 40-hex base, a `changes` list, and a distinct committer are built in ply-web: in-memory tree, `encodeCommit`, `push`. |

```ts
editFile(url, {
  ref: string,
  base?: string, // ref name or 40-hex; omitted on a missing ref → root commit, CAS from ZERO_OID
  changes: ReadonlyArray<
    | { op: 'create' | 'write'; path: string; content: string; mode?: '100644' | '100755' | '120000' }
    | { op: 'edit'; path: string; find: string; replace: string }
    | { op: 'delete'; path: string }
    | { op: 'rename'; path: string; to: string }
  >,
  author: { name: string; email: string; tz?: string; time?: number },
  committer?: { name: string; email: string; tz?: string; time?: number }, // omitted = author
  message: string,
}, opts): Promise<Result<
  { outcome: 'commit' | 'noop'; ref: string; oid: string; oldOid: string | null; tree: string },
  PlyError
>>
// bad_request: zero oid, bad path, bad mode, bad ident (validateIdent)
// not_found: Miss.commit (step 5) or Miss.path (step 6, once it has landed)
// cas_conflict: { expected, actual }
// match_count: unchanged from today's editFile (HTTP 422)
```

`tree.ts` and most of `commit.ts` go. `commitEdit` becomes parse-then-call. `plyPerson` goes with the one-identity call.

### 9. Create and delete refs, create a tag — ply #116

Depends on step 5 (`fetchCommit` for a 40-hex target). `encodeTag` already shipped (#103 item 5); `tag.ts` calls it.

| | |
| --- | --- |
| Files | `src/write/branch.ts` `createBranch`, `deleteRef`, `bornTip`; `src/write/tag.ts` `createTag`, `removeTag`; `src/write/errors.ts` `refExists`, `staleExpected` |
| What it does | ls-refs, then a CAS push from `ZERO_OID` (create) or to `ZERO_OID` (delete). Artifacts reports every lost CAS as the same stale-ref text, so ply-web splits that into `ref_exists` (retry `no`) and `stale_expected` (retry `fresh`, with `expected` and `actual`) by reading the ref again. A zero oid and a 40-hex ref *name* are `bad_request` before any transport (`request.ts` `branchRef` / `refOrCommit`). |

```ts
createRef(url, { ref: string; target?: string /* ref name or 40-hex; default: born HEAD */ }, opts): Promise<
  Result<{ ref: string; oid: string; pushBytes: number }, PlyError>
>
deleteRef(url, { ref: string; expected?: string /* 40-hex; default: current */ }, opts): Promise<
  Result<{ ref: string; deleted: string }, PlyError>
>
createTag(url, { name: string; target: string; annotated?: { tagger: Ident; message: string } }, opts): Promise<
  Result<{ ref: string; oid: string; commit: string }, PlyError>
>
// cas_conflict detail: { expected: string | null; actual: string | null }
//   create that lost: expected === ZERO_OID && actual !== null
//   delete that lost: expected is the caller's oid, actual is the reread tip
// bad_request before transport: zero oid, 40-hex ref name
// not_found: Miss.ref, or Miss.commit for a 40-hex target
```

HTTP mapping of `cas_conflict` to `ref_exists` / `stale_expected` stays in `src/status.ts`. `branchRef` / `tagRef` shrink to JSON field parsing once ply owns the git ref rules.

### 10. Tag version order — ply #124

Depends on nothing.

| | |
| --- | --- |
| File | `src/viewer/tags.ts` `pieces`, `compareTagNames`; `tagsFromRefs` keeps the ls-refs scan and sorts with ply |
| What it does | Orders tag names "newest first" by splitting on digit runs. That disagrees with `git tag --sort=-version:refname` (`v1.0.0-rc1` vs `v1.0.0`, leading zeros). Listing the tags is plain `lsRefs` and stays. |

```ts
compareVersionRefnames(a: string, b: string, opts?: { suffixes?: readonly string[] }): number
// == git versioncmp, with versionsort.suffix. Pure. No error.
```

### 11. Pack layout — ply #121

Depends on nothing.

| | |
| --- | --- |
| File | `src/viewer/packmap.ts` `mapParsed` (resolve, re-hash, chain length, `/ref delta base/` on `pack_corrupt`) |
| What it does | Turns a parsed pack into the `verify-pack -v` table and detects a thin REF_DELTA base by regex on the error text. `previewOf` (commit subject, tree names, text sniff) is display and stays. |

```ts
describePack(buf: Uint8Array, limits: Limits): Result<{
  version: 2 | 3
  count: number
  trailer: string
  objects: ReadonlyArray<{
    offset: number
    headerBytes: number
    compressed: number
    size: number
    wireType: number
    type: ObjType | null
    oid: string | null
    base: { offset: number } | { oid: string } | null
    depth: number
  }>
  missingBases: readonly string[] // REF_DELTA bases outside the pack; typed, no message match
}, PlyError>
```

### 12. tree:0 fallback and a log window on the caller's transport — ply #118

Depends on nothing. The viewer's copy skips ply's wide-pack and deepen checks.

| | |
| --- | --- |
| Files | `src/viewer/session.ts` `loadWindow`, `historyOf`, and the tree:0 catch in `loadPack`; `src/gitcache.ts` `FILTER_REFUSAL` |
| What it does | `fetchPack` with `filter: 'tree:0'`, and on `isFilterRejection` retries `blob:none` and remembers it on the per-origin quirks object. `historyOf` walks first parents through the held objects and stops at a missing parent. GitCache caches a 400 whose body matches the same refusal text ply recognises. |

```ts
fetchPackFiltered(t, { wants, deepen?, filter: 'tree:0' | 'blob:none' }): Promise<Result<{
  objects: Map<string, Held>
  shallow: boolean
  filter: 'tree:0' | 'blob:none'
  learned: boolean
}, PlyError>>

isFilterRefusal(status: number, text: string): boolean

logOn(t, { commit, limit }): Promise<Result<{ commits: readonly Commit[]; truncated: boolean; cut: string | null }, PlyError>>
```

`src/quirks.ts` stays. ply keeps no module state; the isolate-wide map is ply-web's. Artifacts returns 400 for a partial-clone filter other than `blob:none`, and ply-web falls back to that filter (ply #118).

### 13. openBlob on the caller's transport — ply #119

Depends on step 4. The stream must hold its last chunk until verified.

| | |
| --- | --- |
| Files | `src/viewer/session.ts` `readBlob`, `refuseOversizedChunk`; the cursor and inflate casts in `src/viewer/ply.ts` |
| What it does | The viewer already walked the tree, so it cannot call `readFile(url, …)`. It reimplements `openBlob`: `packStream`, cursor until the object header, refuse a non-blob, stop when the declared size exceeds the display cap, inflate, `hashObject`. |

```ts
openBlob(t, oid, { maxBytes?: number }): Promise<Result<
  | { readonly kind: 'stream'; readonly size: number; readonly stream: ReadableStream<Uint8Array> }
  | { readonly kind: 'too_big'; readonly size: number }, // header only; fetch cancelled
  PlyError
>>

readBlob(t, oid, { maxBytes?: number }): Promise<Result<
  | { readonly kind: 'bytes'; readonly data: Uint8Array }
  | { readonly kind: 'too_big'; readonly size: number },
  PlyError
>>
// not_found Miss.commit when the oid is not a blob (step 6)
// pack_corrupt on a bad hash, with no byte released after the failure (step 4)
```

### 14. Git-compatible redirects — ply #113

Depends on nothing. The SSRF policy stays here.

| | |
| --- | --- |
| Files | `src/remote.ts` `createGuardedFetch` (the hop loop); `src/viewer/fetchguard.ts` `createViewerFetch` (the hop loop) |
| What it does | ply refuses every 3xx. ply-web follows up to 3 hops with `redirect: 'manual'`, including POSTs, and re-checks each hop against the allowlist. git's default `http.followRedirects=initial` follows only the first info/refs GET and then rebases later requests onto the new base. |

```ts
createTransport(url, {
  followRedirects?: 'never' | 'initial', // default 'never'
  allowUrl?: (url: URL) => Result<URL, PlyError>,
  maxRedirects?: number, // default 3, 'initial' only
})
// 'initial': 3xx on the info/refs GET whose Location keeps /info/refs?service=<svc> rebases t.url
// any other 3xx, and any 3xx on a POST, is today's http error
// span attrs: http.redirect.count, git.remote.rebased_from (scrubbed)
```

`decideRemote`, `assertUpstreamUrl`, credential stripping, and the viewer byte budget stay in ply-web. They become the `allowUrl` hook.

### 15. Decode an upload-pack request — ply #120

Depends on nothing. Step 16 is easier after this, because both touch `src/rays.ts`, but #123's API does not require the parser.

| | |
| --- | --- |
| Files | `src/gitcache.ts` `classify`, `wantsOf`, the `deepen` / `filter` regexes inside `verifyPackResponse`; `src/rays.ts` `phaseOf` (the `command=ls-refs` / `command=fetch` sniff) |
| What it does | Classifies a stateless-rpc body with regexes over a latin1 copy: ls-refs, a wants-only fetch (cacheable pack), or info/refs (discover). `verifyPackResponse` replays that through ply and stores the answer only when every want hashed. `phaseOf` sniffs the same command bytes to name a ray. |

```ts
parseUploadPackRequest(body: Uint8Array): Result<
  | { command: 'ls-refs'; prefixes: string[]; peel: boolean; symrefs: boolean; unborn: boolean }
  | { command: 'fetch'; wants: string[]; haves: string[]; wantRefs: string[]; shallow: string[]; deepen: number; deepenSince: number; deepenNot: string[]; filter: string; done: boolean; caps: string[] },
  PlyError // protocol on a body that is not a v2 request
>

exchangeKind(method: string, url: string, body: Uint8Array | null): 'pack' | 'refs' | 'discover' | null

verifyFetchAnswer(request: FetchRequest, answer: Uint8Array, limits: Limits): Result<{ objects: number }, PlyError>
```

Workers Cache plumbing stays: the `GitCache` entrypoint, key hash, Cache-Control, purge. `phaseOf`'s URL half (info/refs vs receive-pack path) can stay as HTTP routing; the pkt-line sniff goes.

### 16. Response headers on the exchange span — ply #123

No type dependency on step 15. Land it after #120 so `rays.ts` drops the body sniff before it drops the order matching.

| | |
| --- | --- |
| File | `src/rays.ts` `observeUpstream`, `stampUpstreamSpans` |
| What it does | Wraps `fetch`, records `cf-ray` and time-to-headers, then walks exported span lines and attaches the ray to the nth `git.upload-pack` / `git.receive-pack` span. A parent span in that list (this is why `git.head` is excluded) pairs the wrong exchange. Retries and redirects break the same matching. |

```ts
createTransport(url, { recordResponseHeaders?: readonly string[] })
// each exchange span:
//   http.response.header.<lowercased-name>  (only names from the list, scrubbed, length-capped)
//   http.response.status_code
//   http.time_to_headers_ms
```

`x-artifacts-ray` and `Server-Timing` stay. They are ply-web's header grammar, rendered from those attributes. `stampUpstreamSpans` goes.

### 17. Mirror one ref — ply #122

Depends on step 3 (the `Uint8Array` cast) and on step 9 (`cas_conflict.actual` filled by ply).

| | |
| --- | --- |
| File | `src/mirror.ts` `tip`, and the `fetchPack` / `push` half of `syncMirror` |
| What it does | ls-refs both tips; equal means in sync; otherwise fetch with `haves: [dstTip]` and CAS-push onto the destination. A rewritten source is followed. The pack is capped at 32 MiB. Token mint, revoke, and the mirror list are the Artifacts binding and stay. |

```ts
syncRef(src: Transport, dst: Transport, {
  ref: string
  dstRef?: string
  force?: boolean // default true: follow a rewrite
  maxPackBytes?: number
}): Promise<Result<
  | { outcome: 'in_sync'; oid: string }
  | { outcome: 'updated'; from: string | null; to: string; objects: number; pushBytes: number },
  PlyError
>>
// cas_conflict: { expected, actual } as in step 9
// not_fast_forward when force is false
// not_found: Miss.ref when the source has no such branch
```

## No ply issue

Do not open one from ply-web.

**Commit trailers** (`src/viewer/format.ts` `commitProse`, `trailerOf`). Splits a commit message into subject, body paragraphs, and trailers (`Token: value`, plus GitHub closing keywords). This is `git interpret-trailers` as a display parse, not a protocol error. A pure function would be:

```ts
commitTrailers(message: string): {
  subject: string
  body: string
  trailers: readonly { key: string; value: string }[]
}
// no error: unrecognised lines stay in the body
```

**The `lsRefsUnborn` origin cache** (`head.ts` `lsRefsUnbornOf`). No issue. It is isolate policy and disappears with step 6. Hardcoding the bit would skip the discover GET and would disagree with git on `allow` / `ignore` servers.

**A rejected CAS lists the ref twice.** `commitEdit` lists the target in `resolveTarget` (`src/write/commit.ts`), then lists it again on `cas_conflict` — both the streamed one-file path and the pack push — before throwing `refExists`. `createBranch` lists before the push and again when the CAS loses (`src/write/branch.ts`). `deleteRef` does the same pair, then throws `staleExpected`. The second listing is a ply follow-up. Do not file an issue.

## Not git logic (stays)

These are the Worker, not a git client:

- `src/status.ts` — ply and Worker codes to HTTP status. `merge_conflict` is 409, `bad_request` is 400, `internal` is 500. `auth` keeps the upstream 401 or 403.
- `src/write/result.ts` `writeResult`, `unifyPly` — the `/v1` JSON shape.
- `src/write/identity.ts` `stamp` — the JSON identity over `validateIdent`, after `parseTz` was deleted. `plyStamp` is the argument shape merge, rebase, and pick already take.
- `src/quirks.ts` — per-origin filter memory for the isolate.
- Remote allowlist, public-repo tokens, path guards, rate limits, viewer markdown and HTML, pack-object previews, the `x-artifacts-ray` / `Server-Timing` grammar, GitCache's Workers Cache entrypoint, mirror token TTL.
