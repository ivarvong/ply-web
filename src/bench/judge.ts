// The judge: reads the repository back after the steps, the way ply's runner reads it with stock git (observeEnd),
// over the `judge` channel with ply itself: ls-refs (with the unborn HEAD, as git's clone asks), then one fetch of every
// tip. refs, HEAD, every reachable object, each ref's tree and the commit graph; no fsck and no merge bases (a Worker
// has no git), so neither is compared (ply/probes soloDiffs does not read them).
import type { GitHttp } from 'ply';
import type { EndState } from 'ply/probes';
import { type Result, err, ok } from './result.ts';

const COMMIT = 1;
const TAG = 4;
const MAX_PEEL = 8;
const dec = new TextDecoder();

type Obj = { readonly type: number; readonly data: Uint8Array };
const headerLines = (data: Uint8Array): string[] => {
  const text = dec.decode(data);
  const end = text.indexOf('\n\n');
  return (end < 0 ? text : text.slice(0, end)).split('\n');
};
const field = (data: Uint8Array, name: string): string[] => headerLines(data).filter(l => l.startsWith(`${name} `)).map(l => l.slice(name.length + 1));

// The tree a ref peels to: through tags to a commit, then its tree. null when it peels to no commit in hand.
export function treeOf(objects: ReadonlyMap<string, Obj>, oid: string): string | null {
  let at = oid;
  for (let i = 0; i < MAX_PEEL; i++) {
    const o = objects.get(at);
    if (typeof o !== 'object') return null;
    if (o.type === COMMIT) return field(o.data, 'tree')[0] || null;
    if (o.type !== TAG) return null;
    at = field(o.data, 'object')[0] || '';
  }
  return null;
}
// `git rev-list --parents --all`: one line per reachable commit, its id then its parents, sorted.
export const ancestryOf = (objects: ReadonlyMap<string, Obj>): string[] =>
  [...objects].filter(([, o]) => o.type === COMMIT).map(([oid, o]) => [oid, ...field(o.data, 'parent')].join(' ')).sort();

export type Judged = { readonly end: EndState; readonly fetchedBytes: number };

export async function readEnd(client: GitHttp): Promise<Result<Judged, string>> {
  const ls = await client.lsRefs([], { unborn: true });
  if (!ls.ok) return err(`judge ls-refs: ${ls.error.code}: ${ls.error.message}`);
  const refs: Record<string, string> = {};
  for (const [name, r] of ls.value.refs) if (name !== 'HEAD') refs[name] = String(r.oid);
  const head = ls.value.head === null ? (ls.value.unborn === null ? null : ls.value.unborn.target) : ls.value.head;
  const tips = [...new Set(Object.values(refs))].sort();
  if (tips.length === 0) return ok({ end: { head, refs, objects: [], trees: {}, ancestry: [], mergeBases: {}, fsck: [] }, fetchedBytes: 0 });
  const f = await client.fetchPack({ wants: tips });
  if (!f.ok) return err(`judge fetch: ${f.error.code}: ${f.error.message}`);
  const objects: ReadonlyMap<string, Obj> = f.value.objects === null ? new Map() : f.value.objects;
  const trees: Record<string, string> = {};
  for (const [name, oid] of Object.entries(refs)) {
    const t = treeOf(objects, oid);
    if (t !== null) trees[name] = t;
  }
  const fetchedBytes = f.value.parsed === null ? 0 : f.value.parsed.bytes;
  return ok({ end: { head, refs, objects: [...objects.keys()].sort(), trees, ancestry: ancestryOf(objects), mergeBases: {}, fsck: [] }, fetchedBytes });
}
