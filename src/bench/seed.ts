// A scenario's seed objects built in memory, byte for byte as ply's probe runner builds them with git plumbing
// (test/probes/runner.mjs buildSeed: fixed identity and dates, `git commit-tree -m <name>`, `git mktag`), so a plan run
// from a Worker holds the same object ids as every run of it in ply's suite. test/bench-seed.test.ts checks that against
// git itself. Pure apart from SHA-256 (the noise stream), which is the platform's crypto.subtle.
import { hashObject, parseOid, toHex, treeSort, encodeTree, type Oid } from 'ply';
import type { Content, ObjRef, ObjectSpec, OidExpr, Push, Scenario, Seed } from 'ply/probes';
import { mapGet } from '../absent.ts';
import { type Result, err, ok } from './result.ts';

export const ZERO_OID = '0'.repeat(40) as Oid;
const IDENT = 'ply probe <probe@ply.invalid> 1700000000 +0000';
const SHA256_BYTES = 32;
const MODE_FILE = '100644';
const MODE_DIR = '40000';
const enc = new TextEncoder();

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export type StoredObject = { readonly oid: Oid; readonly type: ObjType; readonly data: Uint8Array; readonly links: readonly Oid[] };
export type SeedStore = {
  readonly names: ReadonlyMap<string, Oid>; // seed name -> oid
  readonly byOid: Readonly<Record<string, string>>; // oid -> seed name (ply/probes Names)
  readonly objects: ReadonlyMap<string, StoredObject>;
  readonly trees: ReadonlyMap<string, Oid>; // commit name -> its root tree
};

// The deterministic incompressible bytes of a noise file: SHA-256 of `${seed}:${i}` for i = 0, 1, 2, ...
export async function noiseBytes(seed: string, n: number): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  const blocks = Math.ceil(n / SHA256_BYTES);
  const digests = await Promise.all(Array.from({ length: blocks }, (_, i) => crypto.subtle.digest('SHA-256', enc.encode(`${seed}:${i}`))));
  for (const [i, d] of digests.entries()) out.set(new Uint8Array(d).subarray(0, Math.min(SHA256_BYTES, n - i * SHA256_BYTES)), i * SHA256_BYTES);
  return out;
}
export async function contentBytes(c: Content): Promise<Uint8Array> {
  if (c.tag === 'text') return enc.encode(c.text);
  return noiseBytes(c.seed, c.bytes);
}
// The bytes a seed asks for, so a runner can refuse a plan too large for its memory before building it.
export function seedBytes(seed: Seed): number {
  return seed.objects.reduce((sum, o) => sum + (o.tag === 'commit' ? o.files.reduce((s, f) => s + (f.content.tag === 'text' ? f.content.text.length : f.content.bytes), 0) : 0), 0);
}

type Dir = { readonly files: Map<string, Oid>; readonly dirs: Map<string, Dir> };
const emptyDir = (): Dir => ({ files: new Map(), dirs: new Map() });

function put(objects: Map<string, StoredObject>, type: ObjType, data: Uint8Array, links: readonly Oid[]): Oid {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { oid, type, data, links });
  return oid;
}

function writeDir(objects: Map<string, StoredObject>, dir: Dir): Result<Oid, string> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  for (const [name, oid] of dir.files) entries.push({ mode: MODE_FILE, name, oid });
  for (const [name, sub] of dir.dirs) {
    const t = writeDir(objects, sub);
    if (!t.ok) return t;
    entries.push({ mode: MODE_DIR, name, oid: t.value });
  }
  const sorted = treeSort(entries);
  if (!sorted.ok) return err(`tree sort: ${sorted.error.message}`);
  const data = encodeTree(sorted.value);
  if (!data.ok) return err(`tree encode: ${data.error.message}`);
  return ok(put(objects, 'tree', data.value, sorted.value.map(e => e.oid as Oid)));
}

// The tree of a commit as a nested map: its first parent's files, then its own written over them.
function treeOf(objects: ReadonlyMap<string, StoredObject>, root: Oid): Dir {
  const dir = emptyDir();
  const t = mapGet(objects, root);
  if (t.tag === 'none') return dir;
  for (const e of parseTreeEntries(t.value.data)) {
    if (e.mode === MODE_DIR) dir.dirs.set(e.name, treeOf(objects, e.oid));
    else dir.files.set(e.name, e.oid);
  }
  return dir;
}
export type TreeRow = { readonly mode: string; readonly name: string; readonly oid: Oid };
export function parseTreeEntries(data: Uint8Array): TreeRow[] {
  const rows: TreeRow[] = [];
  const dec = new TextDecoder();
  let at = 0;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    rows.push({ mode: dec.decode(data.subarray(at, sp)), name: dec.decode(data.subarray(sp + 1, nul)), oid: toHex(data.subarray(nul + 1, nul + 21)) as Oid });
    at = nul + 21;
  }
  return rows;
}

function placeFile(root: Dir, path: string, oid: Oid): void {
  const parts = path.split('/');
  const last = parts.pop();
  let dir = root;
  for (const p of parts) {
    const next = mapGet(dir.dirs, p);
    const sub = next.tag === 'some' ? next.value : emptyDir();
    if (next.tag === 'none') dir.dirs.set(p, sub);
    dir = sub;
  }
  dir.files.set(String(last), oid);
}

async function buildCommit(objects: Map<string, StoredObject>, names: Map<string, Oid>, trees: Map<string, Oid>, o: Extract<ObjectSpec, { readonly tag: 'commit' }>): Promise<Result<Oid, string>> {
  const parents: Oid[] = [];
  for (const p of o.parents) {
    const id = mapGet(names, p);
    if (id.tag === 'none') return err(`commit ${o.name}: parent ${p} is not defined before it`);
    parents.push(id.value);
  }
  const first = o.parents.length > 0 ? mapGet(trees, String(o.parents[0])) : mapGet(trees, '');
  const root = first.tag === 'some' ? treeOf(objects, first.value) : emptyDir();
  for (const f of o.files) placeFile(root, f.path, put(objects, 'blob', await contentBytes(f.content), []));
  const tree = writeDir(objects, root);
  if (!tree.ok) return tree;
  trees.set(o.name, tree.value);
  const text = `tree ${tree.value}\n${parents.map(p => `parent ${p}\n`).join('')}author ${IDENT}\ncommitter ${IDENT}\n\n${o.message}\n`;
  return ok(put(objects, 'commit', enc.encode(text), [tree.value, ...parents]));
}

export async function buildSeed(seed: Seed): Promise<Result<SeedStore, string>> {
  const objects = new Map<string, StoredObject>();
  const names = new Map<string, Oid>();
  const trees = new Map<string, Oid>();
  for (const o of seed.objects) {
    if (o.tag === 'commit') {
      const c = await buildCommit(objects, names, trees, o);
      if (!c.ok) return c;
      names.set(o.name, c.value);
      continue;
    }
    const target = mapGet(names, o.target);
    if (target.tag === 'none') return err(`tag ${o.name}: target ${o.target} is not defined before it`);
    const body = `object ${target.value}\ntype commit\ntag ${o.tagName}\ntagger ${IDENT}\n\n${o.message}\n`;
    names.set(o.name, put(objects, 'tag', enc.encode(body), [target.value]));
  }
  const byOid: Record<string, string> = {};
  for (const [n, oid] of names) byOid[oid] = n;
  return ok({ names, byOid, objects, trees });
}

// ---- reading a plan against a built seed ----
export function oidOf(store: SeedStore, e: OidExpr): Result<Oid, string> {
  if (e.tag === 'zero') return ok(ZERO_OID);
  const id = mapGet(store.names, e.name);
  return id.tag === 'some' ? ok(id.value) : err(`no seed object ${e.name}`);
}
export function resolveObjRef(store: SeedStore, r: ObjRef): Result<Oid, string> {
  if (r.tag === 'commit') return oidOf(store, { tag: 'obj', name: r.name });
  const tree = mapGet(store.trees, r.of);
  if (tree.tag === 'none') return err(`no tree for ${r.of}`);
  let at: Oid = tree.value;
  for (const part of r.path.split('/')) {
    const t = mapGet(store.objects, at);
    if (t.tag === 'none') return err(`tree ${at} not in the seed`);
    const row = parseTreeEntries(t.value.data).find(e => e.name === part);
    if (typeof row !== 'object') return err(`${r.of}:${r.path}: no entry ${part}`);
    at = row.oid;
  }
  return ok(at);
}

// Every object reachable from `tips` (commits, their trees and parents, tags and their targets), in walk order.
export function reachable(store: SeedStore, tips: readonly Oid[]): Oid[] {
  const seen = new Set<string>();
  const order: Oid[] = [];
  const stack = [...tips].reverse();
  while (stack.length > 0) {
    const oid = stack.pop();
    if (typeof oid !== 'string' || seen.has(oid) || oid === ZERO_OID) continue;
    seen.add(oid);
    const o = mapGet(store.objects, oid);
    if (o.tag === 'none') continue;
    order.push(oid);
    for (const l of [...o.value.links].reverse()) stack.push(l);
  }
  return order;
}

// The objects a push carries: reachable from its new ids and not from `have` (the ids the target holds), minus the
// plan's `omit` (test/probes/runner.mjs objectsFor).
export function objectsFor(store: SeedStore, push: Push, have: readonly Oid[]): Result<StoredObject[], string> {
  const news: Oid[] = [];
  for (const u of push.updates) {
    const n = oidOf(store, u.new);
    if (!n.ok) return n;
    if (n.value !== ZERO_OID) news.push(n.value);
  }
  const omit = new Set<string>();
  for (const r of push.omit) {
    const id = resolveObjRef(store, r);
    if (!id.ok) return id;
    omit.add(id.value);
  }
  const held = new Set<string>(reachable(store, have));
  const out: StoredObject[] = [];
  for (const oid of reachable(store, news)) {
    const o = mapGet(store.objects, oid);
    if (o.tag === 'some' && !held.has(oid) && !omit.has(oid)) out.push(o.value);
  }
  return ok(out);
}

export function seedTips(store: SeedStore, s: Scenario): Result<Oid[], string> {
  const tips: Oid[] = [];
  for (const r of s.seed.refs) {
    const id = oidOf(store, { tag: 'obj', name: r.at });
    if (!id.ok) return id;
    tips.push(id.value);
  }
  return ok(tips);
}

export const isOid = (s: string): s is Oid => parseOid(s).ok;
