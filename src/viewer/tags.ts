// Tag names for the ref picker. ls-refs has no commit time, so "newest" is a version-shaped guess:
// tags with numbers outrank tags without, and numeric pieces compare as integers, high first.
import type { TagInfo } from './model.ts';

const TAG_PREFIX = 'refs/tags/';
const PIECE = /(\d+)|(\D+)/g;

type Piece = { kind: 'num'; n: number } | { kind: 'text'; s: string };

function pieces(name: string): Piece[] {
  const short = name.startsWith(TAG_PREFIX) ? name.slice(TAG_PREFIX.length) : name;
  const out: Piece[] = [];
  for (const match of short.matchAll(PIECE)) {
    if (match[1] !== undefined) out.push({ kind: 'num', n: Number(match[1]) });
    else if (match[2] !== undefined) out.push({ kind: 'text', s: match[2] });
  }
  return out;
}

function hasNumber(parts: readonly Piece[]): boolean {
  return parts.some(part => part.kind === 'num');
}

/** Negative when `a` should be listed before `b` (newer-ish first). */
export function compareTagNames(a: string, b: string): number {
  const pa = pieces(a);
  const pb = pieces(b);
  const aNum = hasNumber(pa);
  const bNum = hasNumber(pb);
  if (aNum !== bNum) return aNum ? -1 : 1;
  const count = Math.max(pa.length, pb.length);
  for (let i = 0; i < count; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    if (x.kind === 'num' && y.kind === 'num' && x.n !== y.n) return y.n - x.n;
    if (x.kind === 'text' && y.kind === 'text' && x.s !== y.s) return y.s < x.s ? -1 : 1;
    if (x.kind !== y.kind) return x.kind === 'num' ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function tagsFromRefs(refs: Iterable<readonly [string, { oid: string }]>, cap: number): { tags: TagInfo[]; truncated: number } {
  const all: TagInfo[] = [];
  for (const [name, rec] of refs) {
    if (!name.startsWith(TAG_PREFIX)) continue;
    all.push({ name, oid: rec.oid });
  }
  all.sort((a, b) => compareTagNames(a.name, b.name));
  return { tags: all.slice(0, cap), truncated: Math.max(0, all.length - cap) };
}
