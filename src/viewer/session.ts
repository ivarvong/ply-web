// One public page: discover, then either a pack map or a ref → commit → tree walk → optional blob.
// Quirks are the isolate's per-origin map (src/quirks.ts), shared with /v1: a server that refuses tree:0 costs that 400
// once per isolate, not once per page. The trace still names the fallback on every fetch that uses it.
import { atIndex, chainGet, fromNullable, mapGet } from '../absent.ts';
import { unwrapOr } from '../option.ts';
import { concat } from 'ply';
import { fail } from 'ply';
import { limitError } from 'ply';
import { TYPE, hashObject, parseTree } from 'ply';
import type { Budget } from './budget.ts';
import { clampText, safeFilename } from './escape.ts';
import type { FetchLike } from './fetchguard.ts';
import { VIEWER_CAPS, VIEWER_GIT_LIMITS, VIEWER_UA } from './limits.ts';
import { mapParsed, type ParsedPack } from './packmap.ts';
import type { CommitInfo, FilterName, Loaded, RepoHeader, ServerInfo, TreeEntry } from './model.ts';
import { candidates, createGitTransport, cursorFinish, cursorInit, cursorStep, discoverRepo, filterRejected, inflateObject, listRefs, readObject, readPack, streamPack, treeEntryType, treeMode, viewCommit, type GitTransport, type PackCursor, type ViewerTracer } from './ply.ts';
import type { ViewerRoute } from './route.ts';
import type { RepoLocation, ValidatedPublicRepoUrl } from './url.ts';
import { viewerHref } from './url.ts';

import { quirksFor, type Quirks } from '../quirks.ts';
import { isAbbreviatedOid, matchAbbreviatedOid } from '../abbrev.ts';
import { nearbyRefs, type ViewerHint } from './hint.ts';
import { tagsFromRefs } from './tags.ts';

export type SessionDeps = {
  tracer: ViewerTracer;
  fetchImpl: FetchLike;
  signal: AbortSignal;
  budget: Budget;
};

type RefRec = { oid: string };

function openTransport(url: ValidatedPublicRepoUrl, opts: {
  tracer: ViewerTracer;
  fetchImpl: FetchLike;
  signal: AbortSignal;
  quirks: Quirks;
}): GitTransport {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw fail('bad_request', 'remote must not carry credentials');
  return createGitTransport(url, { ...opts, userAgent: VIEWER_UA, limits: VIEWER_GIT_LIMITS });
}

function serverOf(info: { version: number; agent: string; objectFormat: string; caps: Map<string, string>; fetch: string[]; filter: boolean }): ServerInfo {
  return {
    agent: info.agent,
    protocol: info.version,
    objectFormat: info.objectFormat,
    caps: [...info.caps.keys()],
    fetchFeatures: info.fetch,
    filterAdvertised: info.filter,
  };
}

function textOrEmpty(value: unknown): string {
  const present = fromNullable(value);
  if (present.tag === 'none') return '';
  return typeof present.value === 'string' ? present.value : String(present.value);
}

function toCommit(oid: string, data: Uint8Array): CommitInfo {
  const view = viewCommit(data, VIEWER_GIT_LIMITS);
  const author = fromNullable(view.author);
  const who = author.tag === 'some' ? author.value : { name: '', email: '', time: '', tz: '' };
  const parents = fromNullable(view.parents);
  return {
    oid,
    tree: textOrEmpty(view.tree),
    parents: parents.tag === 'none' ? [] : parents.value,
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
  for (const cand of candidates(ref)) {
    if (cand === 'HEAD') continue;
    prefixes.add(cand);
  }
  return [...prefixes];
}

function refMiss(listedRefs: { refs: Map<string, RefRec>; head: string | null }, wanted: string, code: 'not_found' | 'bad_request', message: string): never {
  const catalog = refCatalog(listedRefs);
  throw withHint(fail(code, message), { nearby: nearbyRefs(wanted, catalog.branches, catalog.tags), path: null });
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
  const cands = candidates(ref);
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

async function loadTreeBytes(transport: GitTransport, oid: string, cache: Map<string, Uint8Array>): Promise<Uint8Array> {
  const hit = cache.get(oid);
  if (hit) return hit;
  const obj = await readObject(transport, { oid, filter: 'tree:0', expectType: TYPE.TREE });
  cache.set(oid, obj.data);
  return obj.data;
}

function listed(entries: { name: string; mode: string; oid: string }[]): { shown: TreeEntry[]; truncated: number } {
  if (entries.length > VIEWER_GIT_LIMITS.maxTreeEntries) throw limitError('tree entries', entries.length, VIEWER_GIT_LIMITS.maxTreeEntries);
  const mapped: TreeEntry[] = entries.map(entry => ({ name: entry.name, mode: treeMode(entry.mode), oid: entry.oid, type: treeEntryType(entry.mode) }));
  mapped.sort((a, b) => (a.type === 'tree' ? 0 : 1) - (b.type === 'tree' ? 0 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { shown: mapped.slice(0, VIEWER_CAPS.maxTreeShown), truncated: Math.max(0, mapped.length - VIEWER_CAPS.maxTreeShown) };
}

// zlib can be a little larger than the inflated file cap. Same slack ply uses before inflate.
const COMPRESSED_SLACK_BYTES = 64 * 1024;

async function closeIterator(it: AsyncIterator<Uint8Array>): Promise<void> {
  await (it.return as (this: AsyncIterator<Uint8Array>) => Promise<unknown>).call(it).catch(() => {});
}

function refuseOversizedChunk(cursor: PackCursor, chunk: Uint8Array): void {
  const next = cursor.bytes + chunk.byteLength;
  if (next > VIEWER_CAPS.maxPackBytes) throw limitError('pack bytes', next, VIEWER_CAPS.maxPackBytes);
}

async function readBlob(transport: GitTransport, tracer: ViewerTracer, oid: string): Promise<{ size: number; bytes: Uint8Array | null; tooBig: boolean }> {
  const span = tracer.start('git.viewer.blob', { attrs: { 'git.read.blob.oid': oid } });
  const fetchSpan = tracer.start('git.upload-pack fetch', { parent: span, kind: 3 });
  const it = streamPack(transport, { wants: [oid], ofsDelta: true, thinPack: false }, fetchSpan)[Symbol.asyncIterator]();
  let sp = cursorInit();
  const early: Uint8Array[] = [];
  try {
    while (sp.phase !== 'body') {
      const step = await it.next();
      if (step.done) throw fail('pack_corrupt', 'pack ended before the object header');
      refuseOversizedChunk(sp, step.value);
      const r = cursorStep(sp, step.value);
      sp = r.state;
      early.push(...r.zlib);
    }
    if (sp.type !== TYPE.BLOB) throw fail('pack_corrupt', `expected blob, got type ${sp.type}`);
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
      const r = cursorStep(sp, step.value);
      sp = r.state;
      for (const z of r.zlib) { zlibParts.push(z); zlibLen += z.byteLength; }
      if (zlibLen > VIEWER_CAPS.maxFileDisplayBytes + COMPRESSED_SLACK_BYTES) throw limitError('compressed object bytes', zlibLen, VIEWER_CAPS.maxFileDisplayBytes);
    }
    sp = cursorFinish(sp);
    const { out } = inflateObject(concat(zlibParts), 0, { expectedSize: sp.size, maxOutput: VIEWER_CAPS.maxFileDisplayBytes });
    const got = hashObject('blob', out);
    if (got !== oid) throw fail('pack_corrupt', `blob content hashes to ${got}, not ${oid}`);
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
async function loadWindow(transport: GitTransport, head: string, quirks: Quirks): Promise<Map<string, Held> | null> {
  const common = { wants: [head], deepen: VIEWER_CAPS.maxLogCommits, ofsDelta: true as const, thinPack: false as const };
  const wide = (learned: boolean) => readPack(transport, { ...common, filter: 'blob:none' }, {
    attrs: { 'git.fetch.filter.fallback': 'blob:none', 'git.fetch.filter.requested': 'tree:0', 'git.fetch.filter.learned': learned, 'git.viewer.window': VIEWER_CAPS.maxLogCommits },
  });
  try {
    let result;
    if (quirks.treeFilter === 'blob:none') result = await wide(false);
    else {
      try {
        result = await readPack(transport, { ...common, filter: 'tree:0' }, { attrs: { 'git.viewer.window': VIEWER_CAPS.maxLogCommits } });
      } catch (err) {
        if (!filterRejected(err)) throw err;
        quirks.treeFilter = 'blob:none';
        result = await wide(true);
      }
    }
    const objects = chainGet(result, 'objects');
    return objects.tag === 'none' ? null : objects.value as Map<string, Held>;
  } catch (err) {
    const code = chainGet(err, 'code');
    const message = (err as { message: unknown }).message;
    // Too big for the window (a huge tree under blob:none): fall back to the single-commit read. Timeouts and aborts end the page.
    if (code.tag === 'some' && code.value === 'limit_exceeded' && !/upstream/.test(String(message))) return null;
    throw err;
  }
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
export async function listPageRefs(transport: GitTransport, ref: string | null): Promise<{ refs: Map<string, RefRec>; head: string | null }> {
  try {
    return await listRefs(transport, refPrefixes(ref));
  } catch (err) {
    const code = chainGet(err, 'code');
    const what = chainGet(err, 'what');
    const message = chainGet(err, 'message');
    const detail = what.tag === 'some' ? String(what.value) : message.tag === 'some' ? String(message.value) : '';
    if (code.tag !== 'some' || code.value !== 'limit_exceeded' || !/^ls-refs /.test(detail)) throw err;
    return await listRefs(transport, refPrefixes(ref, false));
  }
}

async function loadTree(transport: GitTransport, route: Extract<ViewerRoute, { kind: 'repo' }>, server: ServerInfo, quirks: Quirks, budget: Budget, tracer: ViewerTracer): Promise<Loaded> {
  const listedRefs = await listPageRefs(transport, route.ref);
  const resolved = resolveRef(listedRefs, route.ref);
  const catalog = refCatalog(listedRefs);
  // Raw bytes need no history: read the commit alone. Every page reads the window (it replaces the commit read).
  const held = route.raw ? null : await loadWindow(transport, resolved.commit, quirks);
  const headObj = held === null ? null : unwrapOr(mapGet(held, resolved.commit), null);
  const commitData = headObj && headObj.type === TYPE.COMMIT
    ? headObj.data
    : (await readObject(transport, { oid: resolved.commit, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT })).data;
  const commit = toCommit(resolved.commit, commitData);
  const header = headerFor(route.loc, resolved.name, resolved.commit, server);
  const cache = new Map<string, Uint8Array>();
  for (const [oid, obj] of held === null ? [] : held) if (obj.type === TYPE.TREE) cache.set(oid, obj.data);
  const comps = route.path ? route.path.split('/') : [];
  let treeOid = commit.tree;
  let file: { mode: string; oid: string } | null = null;
  for (let depth = 0; depth < comps.length; depth++) {
    const name = unwrapOr(atIndex(comps, depth), '');
    const data = await loadTreeBytes(transport, treeOid, cache);
    const entries = parseTree(data, VIEWER_GIT_LIMITS);
    if (entries.length > VIEWER_GIT_LIMITS.maxTreeEntries) throw limitError('tree entries', entries.length, VIEWER_GIT_LIMITS.maxTreeEntries);
    const entry = entries.find((item: { name: string }) => item.name === name);
    const existingPath = comps.slice(0, depth).join('/');
    if (!entry) throw withHint(fail('not_found', `path component ${name} not found`, { miss: { kind: 'path', missing: name, existingPath } }), { nearby: [], path: { missing: name, existingPath, notDirectory: false } });
    const last = depth === comps.length - 1;
    if (!last) {
      const walked = existingPath === '' ? name : `${existingPath}/${name}`;
      if (entry.mode !== '40000') throw withHint(fail('not_found', `${name} is not a directory`, { miss: { kind: 'not_directory', path: walked, mode: entry.mode } }), { nearby: [], path: { missing: name, existingPath, notDirectory: true } });
      treeOid = entry.oid;
      continue;
    }
    if (entry.mode === '40000') treeOid = entry.oid;
    else file = { mode: entry.mode, oid: entry.oid };
  }
  if (file) {
    const mode = treeMode(file.mode);
    if (file.mode === '160000') {
      if (route.raw) throw fail('not_found', 'submodule has no blob in this repository', { miss: { kind: 'submodule', path: route.path, commit: file.oid } });
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
  if (route.raw) throw fail('bad_request', 'raw is a file view');
  const data = await loadTreeBytes(transport, treeOid, cache);
  const parsed = parseTree(data, VIEWER_GIT_LIMITS);
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
    kind: 'tree', header, path: route.path, commit, log, logStopped, ...catalog,
    entries: entries.shown,
    entriesTruncated: entries.truncated,
    readme,
  };
}

async function loadPack(transport: GitTransport, route: Extract<ViewerRoute, { kind: 'repo' }>, server: ServerInfo, quirks: Quirks): Promise<Loaded> {
  const pack = route.pack;
  if (!pack) throw fail('internal', 'pack view without a want');
  const want = pack.want;
  const requested: FilterName = pack.filter;
  const common = { wants: [want], deepen: 1, ofsDelta: true as const, thinPack: false as const };
  let honoured: FilterName = requested;
  let result;
  if (requested === 'tree:0') {
    try {
      result = await readPack(transport, { ...common, filter: 'tree:0' }, { resolve: false });
    } catch (err) {
      if (!filterRejected(err)) throw err;
      quirks.treeFilter = 'blob:none';
      honoured = 'blob:none';
      result = await readPack(transport, { ...common, filter: 'blob:none' }, {
        resolve: false,
        attrs: { 'git.fetch.filter.fallback': 'blob:none', 'git.fetch.filter.requested': 'tree:0', 'git.fetch.filter.learned': true },
      });
    }
  } else {
    result = await readPack(transport, { ...common, filter: 'blob:none' }, { resolve: false });
  }
  const parsed = chainGet(result, 'parsed');
  if (parsed.tag === 'none' || !parsed.value) throw fail('pack_corrupt', 'server sent no pack');
  return {
    kind: 'pack',
    header: headerFor(route.loc, route.ref === null ? 'HEAD' : route.ref, want, server),
    want,
    filterRequested: requested,
    filterHonoured: honoured,
    map: mapParsed(parsed.value as ParsedPack, VIEWER_GIT_LIMITS),
    offset: pack.offset,
    askedOfsDelta: true,
    askedThinPack: false,
  };
}

export async function loadRepo(route: Extract<ViewerRoute, { kind: 'repo' }>, deps: SessionDeps): Promise<Loaded> {
  const quirks = quirksFor(route.loc.origin);
  const transport = openTransport(route.loc.url, { tracer: deps.tracer, fetchImpl: deps.fetchImpl, signal: deps.signal, quirks });
  const info = await discoverRepo(transport);
  const server = serverOf(info);
  if (route.pack) return loadPack(transport, route, server, quirks);
  return loadTree(transport, route, server, quirks, deps.budget, deps.tracer);
}
