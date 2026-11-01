// Tag names for the ref picker. ls-refs has no commit time, so "newest" is a version-shaped guess:
// tags with numbers outrank tags without, and numeric pieces compare as integers, high first.
import { atIndex, captureGroup } from '../absent.ts';
import { unwrapOr } from '../option.ts';
import type { TagInfo } from './model.ts';

const TAG_PREFIX = 'refs/tags/';
const PIECE = /(\d+)|(\D+)/g;

type Piece = { kind: 'num'; n: number } | { kind: 'text'; s: string };

function pieces(name: string): Piece[] {
  const short = name.startsWith(TAG_PREFIX) ? name.slice(TAG_PREFIX.length) : name;
  const out: Piece[] = [];
  for (const match of short.matchAll(PIECE)) {
    const digits = unwrapOr(captureGroup(match, 1), '');
    if (digits !== '') out.push({ kind: 'num', n: Number(digits) });
    else {
      const text = unwrapOr(captureGroup(match, 2), '');
      if (text !== '') out.push({ kind: 'text', s: text });
    }
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
    const x = atIndex(pa, i);
    const y = atIndex(pb, i);
    if (x.tag === 'none') return 1;
    if (y.tag === 'none') return -1;
    const left = x.value;
    const right = y.value;
    if (left.kind === 'num' && right.kind === 'num' && left.n !== right.n) return right.n - left.n;
    if (left.kind === 'text' && right.kind === 'text' && left.s !== right.s) return right.s < left.s ? -1 : 1;
    if (left.kind !== right.kind) return left.kind === 'num' ? -1 : 1;
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
