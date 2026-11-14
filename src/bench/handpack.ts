// Packs the harness writes and ply sends as written (PackForm 'hand' in ply/probes): plain entries, the first blob
// optionally as a REF_DELTA, then damaged, as ply's runner writes them (test/probes/runner.mjs writePack,
// deltaFor, damagePack), entry for entry; the zlib streams come from the platform's CompressionStream (so the bytes
// may differ from Node's zlib, the objects and the damage do not), the trailer from ply's SHA-1.
import { Sha1 } from 'ply';
import type { Damage, PackForm } from 'ply/probes';
import { type Result, err, ok } from './result.ts';
import { resolveObjRef, type SeedStore, type StoredObject } from './seed.ts';
import { mapGet } from '../absent.ts';

const TYPE_CODE: Readonly<Record<StoredObject['type'], number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const REF_DELTA = 7;
const TRAILER_BYTES = 20;
const LITERAL_MAX = 127;
const PAST_END = 1000;
const COPY_BYTES = 16;

export type PackEntry = { readonly tag: 'whole'; readonly type: number; readonly data: Uint8Array } | { readonly tag: 'ref-delta'; readonly base: Uint8Array; readonly delta: Uint8Array };

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const u32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
export function varint(value: number): Uint8Array {
  const out: number[] = [];
  let n = value;
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return Uint8Array.from(out);
}
export function entryHeader(type: number, size: number): Uint8Array {
  const out: number[] = [];
  let b = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) { out.push(b | 0x80); b = rest & 0x7f; rest = Math.floor(rest / 128); }
  out.push(b);
  return Uint8Array.from(out);
}
const sha1 = (b: Uint8Array): Uint8Array => new Sha1().update(b).digest();
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) || [], h => parseInt(h, 16));

export type WrittenPack = { readonly pack: Uint8Array; readonly zlibEnds: readonly number[] };
export async function writePack(entries: readonly PackEntry[]): Promise<WrittenPack> {
  const parts: Uint8Array[] = [new TextEncoder().encode('PACK'), u32(2), u32(entries.length)];
  let at = 12;
  const zlibEnds: number[] = [];
  for (const e of entries) {
    const head = e.tag === 'ref-delta' ? concat([entryHeader(REF_DELTA, e.delta.length), e.base]) : entryHeader(e.type, e.data.length);
    const z = await deflate(e.tag === 'ref-delta' ? e.delta : e.data);
    parts.push(head, z);
    at += head.length + z.length;
    zlibEnds.push(at);
  }
  const body = concat(parts);
  return { pack: concat([body, sha1(body)]), zlibEnds };
}

// A delta from a base of `srcSize` bytes: literal inserts only (valid when the base is there), or one copy reading 16
// bytes from past the end of the base (never valid).
export function deltaFor(srcSize: number, target: Uint8Array, kind: 'literal' | 'copy-past-end'): Uint8Array {
  if (kind === 'copy-past-end') {
    const off = srcSize + PAST_END;
    let op = 0x80;
    const args: number[] = [];
    for (let i = 0; i < 4; i++) { const b = Math.floor(off / 256 ** i) & 0xff; if (b !== 0) { op |= 1 << i; args.push(b); } }
    op |= 0x10;
    args.push(COPY_BYTES);
    return concat([varint(srcSize), varint(COPY_BYTES), Uint8Array.from([op, ...args])]);
  }
  const chunks: Uint8Array[] = [];
  for (let o = 0; o < target.length; o += LITERAL_MAX) { const c = target.subarray(o, o + LITERAL_MAX); chunks.push(Uint8Array.of(c.length), c); }
  return concat([varint(srcSize), varint(target.length), ...chunks]);
}

export function damagePack(written: WrittenPack, damage: Damage): Uint8Array {
  const b = written.pack.slice();
  switch (damage) {
    case 'none': return b;
    case 'bad-trailer': b[b.length - 1] = (b[b.length - 1] || 0) ^ 0xff; return b;
    case 'truncated': return b.subarray(0, Math.floor(b.length / 2));
    case 'bad-zlib': {
      const end = written.zlibEnds[0] || 0;
      b[end - 1] = (b[end - 1] || 0) ^ 0xff; // the last byte of the first object's Adler-32
      const body = b.subarray(0, b.length - TRAILER_BYTES);
      return concat([body, sha1(body)]);
    }
  }
}

export async function handPack(store: SeedStore, objects: readonly StoredObject[], form: Extract<PackForm, { readonly tag: 'hand' }>): Promise<Result<Uint8Array, string>> {
  let entries: PackEntry[] = objects.map(o => ({ tag: 'whole', type: TYPE_CODE[o.type], data: o.data }));
  if (form.deltaBase !== null) {
    const i = objects.findIndex(o => o.type === 'blob');
    if (i < 0) return err('hand pack: no blob to send as a delta');
    const base = resolveObjRef(store, form.deltaBase);
    if (!base.ok) return base;
    const baseObj = mapGet(store.objects, base.value);
    if (baseObj.tag === 'none') return err(`hand pack: delta base ${base.value} is not in the seed`);
    entries = entries.map((e, k) => (k === i && e.tag === 'whole' ? { tag: 'ref-delta', base: fromHex(base.value), delta: deltaFor(baseObj.value.data.length, e.data, form.delta) } : e));
  }
  return ok(damagePack(await writePack(entries), form.damage));
}
