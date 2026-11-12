// One public page: discover, then either a pack map or a ref → commit → tree walk → optional blob.
// Quirks are the isolate's per-origin map (src/quirks.ts), shared with /v1: a server that refuses tree:0 costs that 400
// once per isolate, not once per page. The trace still names the fallback on every fetch that uses it.
import { chainGet, fromNullable, mapGet } from '../absent.ts';
import { unwrapOr } from '../option.ts';
import { REFS_MEMO_ENTRIES, REFS_MEMO_MAX_REFS, REFS_STALE_BUDGET_MS, createRefsMemo, refsOrStale, type StaleInfo } from './refmemo.ts';
import { commitView, concat, createTransport, discover, entryType, fetchObject, fetchPack, fetchPackFiltered, hashObject, inflate, isFilterRejection, limitError, lsMode, lsRefs, packStream, parseTree, plyError, refCandidates, spFinish, spInit, spStep, TYPE, walkCommit, walkPath } from 'ply';
import type { Walked } from 'ply/read';
import { pathTreesOf, tree0Taken } from 'ply/transport';
import type { SpState, Tracer, Transport } from 'ply';
import type { SpStepped } from 'ply/fetch';
import { unwrap, type OkOf } from '../ply-result.ts';
import type { Budget } from './budget.ts';
import { clampText, safeFilename } from './escape.ts';
import { viewerAllowUrl, type FetchLike } from './fetchguard.ts';
import { VIEWER_CAPS, VIEWER_GIT_LIMITS, VIEWER_UA } from './limits.ts';
import { mapParsed } from './packmap.ts';
import type { CommitInfo, FilterName, Loaded, RepoHeader, ServerInfo, TreeEntry } from './model.ts';
import type { ViewerRoute } from './route.ts';
import type { AllowedHost, RepoLocation, ValidatedPublicRepoUrl } from './url.ts';
import { viewerHref } from './url.ts';

import { quirksFor, type Quirks } from '../quirks.ts';
import { isAbbreviatedOid, matchAbbreviatedOid } from '../abbrev.ts';
import { nearbyRefs, type ViewerHint } from './hint.ts';
import { tagsFromRefs } from './tags.ts';

export type SessionDeps = {
  tracer: Tracer;
  fetchImpl: FetchLike;
  signal: AbortSignal;
  budget: Budget;
  /** waitUntil, so an ls-refs that outlives a stale-refs page still refreshes the last good list. */
  defer: ((p: Promise<unknown>) => void) | null;
};

const REFS_MEMO = createRefsMemo<{ refs: Map<string, RefRec>; head: string | null }>(REFS_MEMO_ENTRIES, REFS_MEMO_MAX_REFS, v => v.refs.size);

type RefRec = { oid: string };
type DiscoverInfo = OkOf<ReturnType<typeof discover>>;

function openTransport(url: ValidatedPublicRepoUrl, allowed: readonly AllowedHost[], opts: {
  tracer: Tracer;
  fetchImpl: FetchLike;
  signal: AbortSignal;
  quirks: Quirks;
}): Transport {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw plyError('bad_request', 'remote must not carry credentials');
  // git's http.followRedirects=initial: a moved repo (name → name.git) answers its first GET info/refs with a 3xx that ply
  // follows, after viewerAllowUrl has checked it is still this repo; a 3xx on a POST is an error naming the target.
  return unwrap(createTransport(url, { ...opts, userAgent: VIEWER_UA, limits: VIEWER_GIT_LIMITS, followRedirects: 'initial', allowUrl: viewerAllowUrl(url, allowed), maxRedirects: VIEWER_CAPS.maxRedirects }));
}

function serverOf(info: DiscoverInfo): ServerInfo {
  return {
    agent: info.agent,
    protocol: info.version,
    objectFormat: info.objectFormat,
    caps: [...info.caps.keys()],
    fetchFeatures: [...info.fetch],
    filterAdvertised: info.filter,
  };
}

function textOrEmpty(value: unknown): string {
  const present = fromNullable(value);
  if (present.tag === 'none') return '';
  return typeof present.value === 'string' ? present.value : String(present.value);
}

function toCommit(oid: string, data: Uint8Array): CommitInfo {
  const view = unwrap(commitView(data, VIEWER_GIT_LIMITS));
  const author = fromNullable(view.author);
  const who = author.tag === 'some' ? author.value : { name: '', email: '', time: '', tz: '' };
  const parents = fromNullable(view.parents);
  return {
    oid,
    tree: textOrEmpty(view.tree),
    parents: parents.tag === 'none' ? [] : [...parents.value],
    authorName: textOrEmpty(who.name),
    authorEmail: textOrEmpty(who.email),
    authorTime: textOrEmpty(who.time),
    authorTz: textOrEmpty(who.tz),
    message: textOrEmpty(view.message),
    signed: !!view.signed,
  };
}

function headerFor(loc: RepoLocation, ref: string, commit: string, server: ServerInfo): RepoHeader {
  return { host: loc.host, repoPath: loc.repoPath, ref, commit, treeHref: viewerHref(loc.host, loc.repoPath, { ref }), server };
}

/** A viewer failure carrying the error page's hint (src/viewer/hint.ts reads it back); ply's Extra has no such field. */
function withHint<E extends object>(err: E, viewerHint: ViewerHint): E & { viewerHint: ViewerHint } {
  return Object.assign(err, { viewerHint });
}

function refPrefixes(ref: string | null, allTags = true): string[] {
  const prefixes = new Set<string>(allTags ? ['HEAD', 'refs/heads/', 'refs/tags/'] : ['HEAD', 'refs/heads/']);
  for (const cand of unwrap(refCandidates(ref))) {
    if (cand === 'HEAD') continue;
    prefixes.add(cand);
  }
  return [...prefixes];
}

function refMiss(listedRefs: { refs: Map<string, RefRec>; head: string | null }, wanted: string, code: 'not_found' | 'bad_request', message: string): never {
  const catalog = refCatalog(listedRefs);
  throw withHint(plyError(code, message), { nearby: nearbyRefs(wanted, catalog.branches, catalog.tags), path: null });
}

function textRef(ref: string | null): string {
  return ref === null ? '' : ref;
}

function peeledOid(rec: RefRec): string {
  const peeled = chainGet(rec, 'peeled');
  if (peeled.tag === 'none') return rec.oid;
  return typeof peeled.value === 'string' ? peeled.value : rec.oid;
}

function resolveRef(listedRefs: { refs: Map<string, RefRec>; head: string | null }, ref: string | null): { name: string; commit: string } {
  const refs = listedRefs.refs;
  const cands = unwrap(refCandidates(ref));
  if (!cands.length) return { name: textRef(ref), commit: textRef(ref) };
  for (const cand of cands) {
    const rec = refs.get(cand);
    if (!rec) continue;
    const head = listedRefs.head === null ? 'HEAD' : listedRefs.head;
    return { name: cand === 'HEAD' ? head : cand, commit: peeledOid(rec) };
  }
  if (ref && isAbbreviatedOid(ref)) {
    const match = matchAbbreviatedOid(ref, refs);
    if (match.kind === 'unique') return { name: match.oid, commit: match.oid };
    refMiss(listedRefs, ref, 'bad_request', match.message);
  }
  const message = cands[0] === 'HEAD' ? 'remote HEAD is unborn or absent; pass ref explicitly' : `ref ${ref} not found`;
  refMiss(listedRefs, textRef(ref), 'not_found', message);
}

function refCatalog(listedRefs: { refs: Map<string, RefRec>; head: string | null }) {
  const heads = [];
  for (const [name, rec] of listedRefs.refs) {
    if (!name.startsWith('refs/heads/')) continue;
    heads.push({ name, oid: rec.oid, head: name === listedRefs.head });
  }
  heads.sort((a, b) => Number(b.head) - Number(a.head) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const branches = heads.slice(0, VIEWER_CAPS.maxBranchesShown);
  const tagView = tagsFromRefs(listedRefs.refs, VIEWER_CAPS.maxTagsShown);
  return { branches, branchesTruncated: heads.length - branches.length, tags: tagView.tags, tagsTruncated: tagView.truncated };
}

async function loadTreeBytes(transport: Transport, oid: string, cache: Map<string, Uint8Array>): Promise<Uint8Array> {
  const hit = cache.get(oid);
  if (hit) return hit;
  const obj = unwrap(await fetchObject(transport, { oid, filter: 'tree:0', expectType: TYPE.TREE }));
  cache.set(oid, obj.data);
  return obj.data;
}

// ply's walk answer, or its not_found carrying the viewer's path hint (the page names the missing component and the
// directory it was looked for in).
function walkResult<T>(r: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (r.ok) return r.value;
  const e = r.error;
  const miss = chainGet(e, 'miss');
  const kind = textOrEmpty(unwrapOr(chainGet(miss.tag === 'some' ? miss.value : null, 'kind'), ''));
  const field = (key: string) => textOrEmpty(unwrapOr(chainGet(miss.tag === 'some' ? miss.value : null, key), ''));
  if (kind === 'path') throw withHint(e as object, { nearby: [], path: { missing: field('missing'), existingPath: field('existingPath'), notDirectory: false } });
  if (kind === 'not_directory') {
    const parts = field('path').split('/');
    const missing = unwrapOr(fromNullable(parts.pop()), '');
    throw withHint(e as object, { nearby: [], path: { missing, existingPath: parts.join('/'), notDirectory: true } });
  }
  throw e;
}

function listed(entries: { name: string; mode: string; oid: string }[]): { shown: TreeEntry[]; truncated: number } {
  if (entries.length > VIEWER_GIT_LIMITS.maxTreeEntries) throw limitError('tree entries', entries.length, VIEWER_GIT_LIMITS.maxTreeEntries);
  const mapped: TreeEntry[] = entries.map(entry => ({ name: entry.name, mode: lsMode(entry.mode), oid: entry.oid, type: entryType(entry.mode) }));
  mapped.sort((a, b) => (a.type === 'tree' ? 0 : 1) - (b.type === 'tree' ? 0 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { shown: mapped.slice(0, VIEWER_CAPS.maxTreeShown), truncated: Math.max(0, mapped.length - VIEWER_CAPS.maxTreeShown) };
}

// zlib can be a little larger than the inflated file cap. Same slack ply uses before inflate.
const COMPRESSED_SLACK_BYTES = 64 * 1024;

async function closeIterator(it: AsyncIterator<Uint8Array>): Promise<void> {
  await (it.return as (this: AsyncIterator<Uint8Array>) => Promise<unknown>).call(it).catch(() => {});
}

function refuseOversizedChunk(cursor: SpState, chunk: Uint8Array): void {
  const next = cursor.bytes + chunk.byteLength;
  if (next > VIEWER_CAPS.maxPackBytes) throw limitError('pack bytes', next, VIEWER_CAPS.maxPackBytes);
}

async function readBlob(transport: Transport, tracer: Tracer, oid: string): Promise<{ size: number; bytes: Uint8Array | null; tooBig: boolean }> {
  const span = tracer.start('git.viewer.blob', { attrs: { 'git.read.blob.oid': oid } });
  const fetchSpan = tracer.start('git.upload-pack fetch', { parent: span, kind: 3 });
  const it = packStream(transport, { wants: [oid], ofsDelta: true, thinPack: false }, fetchSpan)[Symbol.asyncIterator]();
  let sp: SpState = spInit();
  const early: Uint8Array[] = [];
  try {
    while (sp.phase !== 'body') {
      const step = await it.next();
      if (step.done) throw plyError('pack_corrupt', 'pack ended before the object header');
      refuseOversizedChunk(sp, step.value);
      const r: SpStepped = unwrap(spStep(sp, step.value));
      sp = r.state;
      early.push(...r.zlib);
    }
    if (sp.type !== TYPE.BLOB) throw plyError('pack_corrupt', `expected blob, got type ${sp.type}`);
    if (sp.size > VIEWER_CAPS.maxFileDisplayBytes) {
      span.set({ 'git.viewer.blob.too_big': true, 'git.viewer.blob.size': sp.size });
      await closeIterator(it);
      fetchSpan.set({ 'git.viewer.blob.too_big': true, 'git.viewer.blob.size': sp.size });
      fetchSpan.end();
      span.end();
      return { size: sp.size, bytes: null, tooBig: true };
    }
    const zlibParts = early;
    let zlibLen = early.reduce((n, c) => n + c.byteLength, 0);
    for (;;) {
      const step = await it.next();
      if (step.done) break;
      refuseOversizedChunk(sp, step.value);
      const r: SpStepped = unwrap(spStep(sp, step.value));
      sp = r.state;
      for (const z of r.zlib) { zlibParts.push(z); zlibLen += z.byteLength; }
      if (zlibLen > VIEWER_CAPS.maxFileDisplayBytes + COMPRESSED_SLACK_BYTES) throw limitError('compressed object bytes', zlibLen, VIEWER_CAPS.maxFileDisplayBytes);
    }
    sp = unwrap(spFinish(sp));
    const { out } = unwrap(inflate(concat(zlibParts), 0, { expectedSize: sp.size, maxOutput: VIEWER_CAPS.maxFileDisplayBytes }));
    const got = hashObject('blob', out);
    if (got !== oid) throw plyError('pack_corrupt', `blob content hashes to ${got}, not ${oid}`);
    fetchSpan.end();
    span.set({ 'git.viewer.blob.size': sp.size });
    span.end();
    return { size: sp.size, bytes: out, tooBig: false };
  } catch (err) {
    await closeIterator(it);
    fetchSpan.error(err).end();
    span.error(err).end();
    throw err;
  }
}

function asText(bytes: Uint8Array): string | null {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
}

type Held = { type: number; data: Uint8Array };

/**
 * The page's commit, its first-parent history and (on a blob:none server) every tree, in ONE fetch:
 * `want <head> deepen N` with `filter tree:0`, or `blob:none` where the server refuses tree:0 (Cloudflare Artifacts).
 * Measured 2026-10-30 against the same graphs on GitHub: curl tree:0 deepen 10 is 6.1 KB (10 commits);
 * blob:none deepen 1 is 121.6 KB (1 commit + 48 trees) and deepen 10 is 129.0 KB (+6%, 10 commits + 77 trees).
 * So the history costs one round trip and a few KB instead of one blob:none fetch per commit. The old walk stopped
 * after the first commit on any server that refuses tree:0, which is every Artifacts page.
 * Returns null when the window does not fit the caps; the caller then reads the commit alone.
 */
async function loadWindow(transport: Transport, head: string): Promise<Map<string, Held> | null> {
  // ply picks the filter from what it learned about the server (fetchPackFiltered): tree:0, blob:none after a refusal
  // (Artifacts), or none where the advertisement lists no `filter` (git.sr.ht, stock git; ply-web#121).
  const result = await fetchPackFiltered(transport, { wants: [head], filter: 'tree:0', deepen: VIEWER_CAPS.maxLogCommits });
  if (!result.ok) {
    const error = result.error;
    // Too big for the window (a huge tree under blob:none): fall back to the single-commit read. Timeouts and aborts end the page.
    if (error.code === 'limit_exceeded' && !/upstream/.test(error.message)) return null;
    throw error;
  }
  return result.value.objects;
}

function historyOf(first: CommitInfo, held: Map<string, Held> | null): { log: CommitInfo[]; logStopped: boolean } {
  const log = [first];
  if (!held) return { log, logStopped: first.parents.length > 0 };
  let parent = first.parents[0];
  while (parent && log.length < VIEWER_CAPS.maxLogCommits) {
    const obj = held.get(parent);
    if (!obj || obj.type !== TYPE.COMMIT) return { log, logStopped: true };
    const commit = toCommit(parent, obj.data);
    log.push(commit);
    parent = commit.parents[0];
  }
  return { log, logStopped: false };
}

/**
 * Branches and every tag (for the picker). A repository whose tags alone pass maxRefs (or the ls-refs byte cap) still
 * opens: one more ls-refs lists branches and the asked-for name only, and the picker shows no tags.
 */
export async function listPageRefs(transport: Transport, ref: string | null): Promise<{ refs: Map<string, RefRec>; head: string | null }> {
  const listed = await lsRefs(transport, refPrefixes(ref));
  if (listed.ok) return listed.value;
  const error = listed.error;
  if (error.code !== 'limit_exceeded' || !/^ls-refs /.test(error.what)) throw error;
  return unwrap(await lsRefs(transport, refPrefixes(ref, false)));
}

async function loadTree(transport: Transport, route: Extract<ViewerRoute, { kind: 'repo' }>, advertised: Promise<ServerInfo>, quirks: Quirks, budget: Budget, tracer: Tracer, deps: SessionDeps): Promise<Loaded> {
  // A full object id names the commit without the ref listing (resolveRef never reads it then), so the listing, which
  // only fills the branch and tag picker, runs beside the window fetch instead of before it, and a raw read skips it.
  // An ls-refs miss is 140-490 ms on /r pages (59f39490).
  const direct = unwrap(refCandidates(route.ref)).length === 0 && route.ref !== null;
  let listing: Promise<{ refs: Map<string, RefRec>; head: string | null }> | null = null;
  let refsStale: StaleInfo | null = null;
  const refsNow = () => {
    if (listing === null) {
      const key = `${String(route.loc.url)}\n${refPrefixes(route.ref).join('\n')}`;
      listing = refsOrStale(REFS_MEMO, key, listPageRefs(transport, route.ref), {
        budgetMs: REFS_STALE_BUDGET_MS,
        now: Date.now,
        defer: deps.defer,
      }).then(got => { refsStale = got.stale; return got.value; });
    }
    return listing;
  };
  // ls-refs does not wait for discover (ply-web#120; ply#220 makes the two share one advertisement GET): nothing before
  // the header needs the advertisement. The window and the walk still wait for it, because discover is what tells ply's
  // transport a server takes no `filter` at all.
  if (!(direct && route.raw)) refsNow().catch(() => {});
  const server = await advertised;
  const resolved: { name: string; commit: string } = direct
    ? { name: route.ref as string, commit: route.ref as string }
    : resolveRef(await refsNow(), route.ref);
  const comps = route.path ? route.path.split('/') : [];
  const cache = new Map<string, Uint8Array>();
  // Raw bytes need no history: no window, and the walk is ply's walkCommit. Every other page reads the window (history,
  // and on a blob:none or unfiltered host every tree too). On a host ply knows takes tree:0 and has not seen refuse
  // `combine:blob:none+tree:K` (GitLab, Codeberg), walkCommit runs beside the window: the commit and the path's first two
  // tree levels in one fetch (ply#219/#222). Anywhere else (GitHub refuses the combined filter; a first contact knows
  // nothing yet) walkCommit's commit fetch would only repeat the window's, so the walk starts from the window's commit.
  const windowed = route.raw ? Promise.resolve(null) : loadWindow(transport, resolved.commit);
  const beside = route.raw || (tree0Taken(quirks) && pathTreesOf(quirks) !== 'refused');
  const walking = beside ? walkCommit(transport, resolved.commit, comps, { cache }) : null;
  const held = await windowed;
  const catalog = route.raw && direct ? { branches: [], branchesTruncated: 0, tags: [], tagsTruncated: 0 } : refCatalog(await refsNow());
  let commitData: Uint8Array;
  let walked: Walked;
  if (walking) {
    const got = walkResult(await walking);
    commitData = got.data;
    walked = got;
  } else {
    for (const [oid, obj] of held === null ? [] : held) if (obj.type === TYPE.TREE) cache.set(oid, obj.data);
    const headObj = held === null ? null : unwrapOr(mapGet(held, resolved.commit), null);
    commitData = headObj && headObj.type === TYPE.COMMIT
      ? headObj.data
      : unwrap(await fetchObject(transport, { oid: resolved.commit, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT })).data;
    walked = walkResult(await walkPath(transport, toCommit(resolved.commit, commitData).tree, comps, { cache }));
  }
  const commit = toCommit(resolved.commit, commitData);
  const header = headerFor(route.loc, resolved.name, resolved.commit, server);
  let treeOid = commit.tree;
  let file: { mode: string; oid: string } | null = null;
  if (walked.entry) {
    if (walked.entry.mode === '40000') treeOid = walked.entry.oid;
    else file = { mode: walked.entry.mode, oid: walked.entry.oid };
  }
  if (file) {
    const mode = lsMode(file.mode);
    if (file.mode === '160000') {
      if (route.raw) throw plyError('not_found', 'submodule has no blob in this repository', { miss: { kind: 'submodule', path: route.path, commit: file.oid } });
      return { kind: 'file', header, path: route.path, ...catalog, mode, blob: file.oid, size: 0, note: 'submodule', text: null };
    }
    const blob = await readBlob(transport, tracer, file.oid);
    if (blob.tooBig || !blob.bytes) {
      if (route.raw) throw limitError('file bytes', blob.size, VIEWER_CAPS.maxFileDisplayBytes);
      return { kind: 'file', header, path: route.path, ...catalog, mode, blob: file.oid, size: blob.size, note: 'too-big', text: null };
    }
    if (route.raw) return { kind: 'raw', filename: safeFilename(route.path), bytes: blob.bytes, size: blob.size };
    const text = asText(blob.bytes);
    return { kind: 'file', header, path: route.path, ...catalog, mode, blob: file.oid, size: blob.size, note: text === null ? 'binary' : 'text', text };
  }
  if (route.raw) throw plyError('bad_request', 'raw is a file view');
  const data = await loadTreeBytes(transport, treeOid, cache);
  const parsed = unwrap(parseTree(data, VIEWER_GIT_LIMITS));
  const entries = listed(parsed);
  let readme: { name: string; text: string } | { name: string; tooBig: true } | null = null;
  if (!route.path && budget.canSpend(1)) {
    const hit = parsed.find((entry: { name: string; mode: string; oid: string }) => (entry.name === 'README.md' || entry.name === 'README') && entry.mode !== '40000' && entry.mode !== '160000');
    if (hit) {
      try {
        const blob = await readBlob(transport, tracer, hit.oid);
        if (blob.tooBig || !blob.bytes) readme = { name: hit.name, tooBig: true };
        else {
          const text = asText(blob.bytes);
          readme = text === null ? { name: hit.name, tooBig: true } : { name: hit.name, text: clampText(text, 20_000) };
        }
      } catch (err) {
        const code = (err as { code: unknown }).code;
        if (code === 'limit_exceeded' || code === 'timeout' || code === 'aborted') throw err;
        readme = null;
      }
    }
  }
  const { log, logStopped } = historyOf(commit, held);
  return {
    kind: 'tree', header, path: route.path, commit, log, logStopped, refsStale, ...catalog,
    entries: entries.shown,
    entriesTruncated: entries.truncated,
    readme,
  };
}

async function loadPack(transport: Transport, route: Extract<ViewerRoute, { kind: 'repo' }>, server: ServerInfo, quirks: Quirks): Promise<Loaded> {
  const pack = route.pack;
  if (!pack) throw plyError('internal', 'pack view without a want');
  const want = pack.want;
  const requested: FilterName = pack.filter;
  const common = { wants: [want], deepen: 1, ofsDelta: true as const, thinPack: false as const };
  let honoured: FilterName = requested;
  let result = await fetchPack(transport, { ...common, filter: requested }, { resolve: false });
  if (requested === 'tree:0' && !result.ok && isFilterRejection(result.error)) {
    quirks.treeFilter = 'blob:none';
    honoured = 'blob:none';
    result = await fetchPack(transport, { ...common, filter: 'blob:none' }, {
      resolve: false,
      attrs: { 'git.fetch.filter.fallback': 'blob:none', 'git.fetch.filter.requested': 'tree:0', 'git.fetch.filter.learned': true },
    });
  }
  const parsed = unwrap(result).parsed;
  if (parsed === null) throw plyError('pack_corrupt', 'server sent no pack');
  return {
    kind: 'pack',
    header: headerFor(route.loc, route.ref === null ? 'HEAD' : route.ref, want, server),
    want,
    filterRequested: requested,
    filterHonoured: honoured,
    map: mapParsed(parsed, VIEWER_GIT_LIMITS),
    offset: pack.offset,
    askedOfsDelta: true,
    askedThinPack: false,
  };
}

export async function loadRepo(route: Extract<ViewerRoute, { kind: 'repo' }>, deps: SessionDeps): Promise<Loaded> {
  const quirks = quirksFor(route.loc.origin);
  const transport = openTransport(route.loc.url, route.loc.allowedHosts, { tracer: deps.tracer, fetchImpl: deps.fetchImpl, signal: deps.signal, quirks });
  const advertised = discover(transport).then(info => serverOf(unwrap(info)));
  if (route.pack) return loadPack(transport, route, await advertised, quirks);
  return loadTree(transport, route, advertised, quirks, deps.budget, deps.tracer, deps);
}
