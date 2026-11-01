// Pure tree edits. A `lazy` node is an object the server already has (we send nothing for it). A `dir` is a tree
// this commit is rebuilding. Empty directories are pruned; git does not store them. The root may be empty.
import { fail, encodeTree, hashObject } from 'ply';
import { mapGet } from '../absent.ts';
import { orNull } from '../option.ts';
import { MODE_TREE, NOT_FOUND } from './constants.ts';
import type { BlobMode } from './request.ts';

export type Mem =
  | { readonly kind: 'lazy'; readonly mode: string; readonly oid: string }
  | { readonly kind: 'dir'; readonly entries: ReadonlyMap<string, Mem> };

export type TreeObject = { readonly oid: string; readonly data: Uint8Array };

export function emptyDir(): Mem {
  return { kind: 'dir', entries: new Map() };
}

export function lazyNode(mode: string, oid: string): Mem {
  return { kind: 'lazy', mode, oid };
}

export function isTree(node: Mem): boolean {
  return node.kind === 'dir' || node.mode === MODE_TREE;
}

function withEntry(dir: Mem, name: string, child: Mem | null): Mem {
  if (dir.kind !== 'dir') throw fail('internal', 'withEntry on a file');
  const entries = new Map(dir.entries);
  if (child === null) entries.delete(name);
  else entries.set(name, child);
  return { kind: 'dir', entries };
}

/** Replace one child of an already-expanded directory. */
export function setChild(dir: Mem, name: string, child: Mem): Mem {
  return withEntry(dir, name, child);
}

export function lookup(node: Mem, comps: readonly string[]): Mem | null {
  let cur = node;
  for (const name of comps) {
    if (cur.kind !== 'dir') return null;
    const next = cur.entries.get(name);
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/** Where `comps` sits inside the caller's full `path`. `name` is the component under consideration. */
function pathPlace(path: string, comps: readonly string[], name: string): { readonly existingPath: string; readonly here: string } {
  const at = comps.join('/');
  const existingPath = path === at ? '' : path.slice(0, path.length - at.length - 1);
  return { existingPath, here: existingPath === '' ? name : `${existingPath}/${name}` };
}

function requireDir(node: Mem, path: string): asserts node is { kind: 'dir'; entries: ReadonlyMap<string, Mem> } {
  if (node.kind !== 'dir') throw fail('internal', `${path}: tree was not expanded before the edit`);
}

/** Insert or replace `leaf` at `comps`. Intermediate directories are created. `overwrite` is write, not create. */
export function putAt(node: Mem, comps: readonly string[], leaf: Mem, overwrite: boolean, path: string): Mem {
  requireDir(node, path);
  const [name, ...rest] = comps;
  if (!name) throw fail('bad_request', 'path is empty');
  const prev = orNull(mapGet(node.entries, name));
  if (rest.length === 0) {
    if (prev && isTree(prev)) throw fail('bad_request', `${path} is a directory`);
    if (prev && !overwrite) throw fail('bad_request', `${path} already exists`);
    return withEntry(node, name, leaf);
  }
  if (prev && !isTree(prev)) throw fail('bad_request', `${path} replaces a file with a directory`);
  const child = prev && prev.kind === 'dir' ? prev : emptyDir();
  if (prev && prev.kind !== 'dir') throw fail('internal', `${path}: tree was not expanded before the edit`);
  return withEntry(node, name, putAt(child, rest, leaf, overwrite, path));
}

/** Remove `comps`. A directory that becomes empty is dropped, so the root is the only tree that may have no entries. */
export function removeAt(node: Mem, comps: readonly string[], path: string): Mem {
  requireDir(node, path);
  const [name, ...rest] = comps;
  if (!name) throw fail('bad_request', 'path is empty');
  const prev = node.entries.get(name);
  const place = pathPlace(path, comps, name);
  if (!prev) throw fail('not_found', `${path} not found`, { miss: { kind: 'path', missing: name, existingPath: place.existingPath } });
  if (rest.length === 0) return withEntry(node, name, null);
  if (prev.kind !== 'dir') throw fail('not_found', `${path} not found`, { miss: { kind: 'not_directory', path: place.here, mode: prev.mode } });
  const child = removeAt(prev, rest, path);
  if (child.kind === 'dir' && child.entries.size === 0) return withEntry(node, name, null);
  return withEntry(node, name, child);
}

export function renameAt(node: Mem, from: readonly string[], to: readonly string[]): Mem {
  const source = from.join('/');
  const dest = to.join('/');
  if (source === dest) throw fail('bad_request', `${source} is already ${dest}`);
  if (dest.startsWith(`${source}/`)) throw fail('bad_request', `cannot rename ${source} into itself`);
  const found = lookup(node, from);
  if (!found) throw fail('not_found', `${source} not found`, { miss: { kind: 'path', missing: source, existingPath: '' } });
  if (lookup(node, to)) throw fail('bad_request', `${dest} already exists`);
  return putAt(removeAt(node, from, source), to, found, false, dest);
}

export function fileLeaf(mode: BlobMode, oid: string): Mem {
  return lazyNode(mode, oid);
}

/** Bottom-up encode. Lazy nodes contribute their oid and no bytes: the server already has them. */
export function encodeMem(node: Mem): { oid: string; trees: TreeObject[] } {
  if (node.kind === 'lazy') return { oid: node.oid, trees: [] };
  const trees: TreeObject[] = [];
  const seen = new Set<string>();
  const entries: { mode: string; name: string; oid: string }[] = [];
  for (const [name, child] of node.entries) {
    const sub = encodeMem(child);
    for (const tree of sub.trees) if (!seen.has(tree.oid)) { seen.add(tree.oid); trees.push(tree); }
    entries.push({ mode: child.kind === 'dir' ? MODE_TREE : child.mode, name, oid: sub.oid });
  }
  const data = encodeTree(entries) as Uint8Array;
  const oid = hashObject('tree', data) as string;
  if (!seen.has(oid)) trees.push({ oid, data });
  return { oid, trees };
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return from;
  const last = hay.length - needle.length;
  for (let i = from; i <= last; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) { matched = false; break; }
    if (matched) return i;
  }
  return NOT_FOUND;
}

export type ReplaceResult = { readonly kind: 'replaced'; readonly data: Uint8Array } | { readonly kind: 'count'; readonly matches: number };

/** Non-overlapping find, the same contract as ply's edit: exactly one match. */
export function replaceOnce(hay: Uint8Array, needle: Uint8Array, insert: Uint8Array): ReplaceResult {
  if (needle.length === 0) return { kind: 'count', matches: 0 };
  const at = indexOfBytes(hay, needle, 0);
  if (at === NOT_FOUND) return { kind: 'count', matches: 0 };
  const second = indexOfBytes(hay, needle, at + needle.length);
  if (second !== NOT_FOUND) {
    let matches = 2;
    let from = second + needle.length;
    for (;;) {
      const next = indexOfBytes(hay, needle, from);
      if (next === NOT_FOUND) break;
      matches += 1;
      from = next + needle.length;
    }
    return { kind: 'count', matches };
  }
  const out = new Uint8Array(hay.length - needle.length + insert.length);
  out.set(hay.subarray(0, at), 0);
  out.set(insert, at);
  out.set(hay.subarray(at + needle.length), at + insert.length);
  return { kind: 'replaced', data: out };
}
