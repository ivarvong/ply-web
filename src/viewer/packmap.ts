// Layout of one pack: offsets, types, delta links. Object bytes are not retained; previews are capped text.
import { atIndex, chainGet, fromAbsent, fromNullable, mapGet } from '../absent.ts';
import { unwrapOr } from '../option.ts';
import { limitError } from 'ply';
import { TYPE, TYPE_NAME, parseCommit, parseTree, hashObject } from 'ply';
import { parsePack, resolvePack } from 'ply';
import { VIEWER_CAPS, VIEWER_GIT_LIMITS } from './limits.ts';
import { clampText } from './escape.ts';

export type ObjectKind = 'commit' | 'tree' | 'blob' | 'tag' | 'ofs_delta' | 'ref_delta';

export type ObjectPreview =
  | { kind: 'commit'; summary: string; tree: string; parents: string[] }
  | { kind: 'tree'; names: string[] }
  | { kind: 'blob'; binary: boolean; text: string | null }
  | { kind: 'tag'; text: string }
  | { kind: 'unresolved' };

export type PackObjectView = {
  offset: number;
  length: number;
  headerBytes: number;
  compressed: number;
  inflated: number;
  wireType: ObjectKind;
  resolvedType: ObjectKind | null;
  oid: string | null;
  baseOffset: number | null;
  baseOid: string | null;
  chain: number;
  preview: ObjectPreview | null;
};

export type DeltaLink = {
  deltaOffset: number;
  baseOffset: number | null;
  baseOid: string | null;
  depth: number;
};

export type PackMap = {
  bytes: number;
  version: number;
  count: number;
  trailer: string;
  headerLength: 12;
  trailerLength: 20;
  objects: PackObjectView[];
  links: DeltaLink[];
  ofsDelta: number;
  refDelta: number;
  thin: boolean;
  maxChain: number;
  counts: Record<string, number>;
  unresolved: boolean;
};

// ply's own parsed-pack type: resolvePack needs each object's inflate stats, which a hand-written copy left out.
export type ParsedPack = ReturnType<typeof parsePack>;

type ResolvedObject = {
  oid: string;
  type: number;
  data: Uint8Array;
  chain: number;
  offset: number;
  size: number;
  compressed: number;
};

function textOrEmpty(value: unknown): string {
  const present = fromNullable(value);
  if (present.tag === 'none') return '';
  return typeof present.value === 'string' ? present.value : String(present.value);
}

function kindOf(type: number): ObjectKind {
  const found = fromAbsent((TYPE_NAME as Record<number, string>)[type]);
  const name = found.tag === 'some' ? found.value : '';
  if (name === 'commit' || name === 'tree' || name === 'blob' || name === 'tag' || name === 'ofs_delta' || name === 'ref_delta') return name;
  return 'blob';
}

function isText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n)); return true; }
  catch { return false; }
}

function previewOf(type: number, data: Uint8Array, limits: object): ObjectPreview | null {
  if (data.length > VIEWER_CAPS.maxPreviewChars * 4 && type === TYPE.BLOB) {
    return { kind: 'blob', binary: !isText(data.subarray(0, 512)), text: null };
  }
  try {
    if (type === TYPE.COMMIT) {
      const commit = parseCommit(data, limits);
      const message = textOrEmpty(commit.message);
      const summary = unwrapOr(atIndex(message.split('\n'), 0), '');
      return { kind: 'commit', summary: clampText(summary, 200), tree: textOrEmpty(commit.tree), parents: commit.parents.slice(0, 8) };
    }
    if (type === TYPE.TREE) {
      const entries = parseTree(data, limits);
      return { kind: 'tree', names: entries.slice(0, 40).map((entry: { name: string }) => entry.name) };
    }
    if (type === TYPE.BLOB) {
      if (!isText(data)) return { kind: 'blob', binary: true, text: null };
      return { kind: 'blob', binary: false, text: clampText(new TextDecoder().decode(data), VIEWER_CAPS.maxPreviewChars) };
    }
    if (type === TYPE.TAG) return { kind: 'tag', text: clampText(new TextDecoder().decode(data), VIEWER_CAPS.maxPreviewChars) };
  } catch {
    return null;
  }
  return null;
}

export function mapPack(buf: Uint8Array, limits = VIEWER_GIT_LIMITS): PackMap {
  if (buf.length > VIEWER_CAPS.maxPackBytes) throw limitError('pack bytes', buf.length, VIEWER_CAPS.maxPackBytes);
  const parsed = parsePack(buf, { limits, maxObjects: VIEWER_CAPS.maxPackObjects, maxInflatedTotal: VIEWER_CAPS.maxInflatedTotal });
  return mapParsed(parsed, limits);
}

export function mapParsed(parsed: ParsedPack, limits = VIEWER_GIT_LIMITS): PackMap {
  let resolved: Map<string, ResolvedObject> | null = null;
  let unresolved = false;
  let maxChain = 0;
  let externalBases = 0;
  try {
    const out = resolvePack({ objects: parsed.objects }, () => null, limits);
    resolved = out.objects;
    maxChain = out.stats.maxChain;
    externalBases = out.stats.externalBases;
    // resolvePack's depth guard counts a recursive walk. A base-first ofs chain never recurses that
    // deep, so the resolved chain length is checked here against the viewer cap.
    if (maxChain > limits.maxDeltaChain) throw limitError('delta chain depth', maxChain, limits.maxDeltaChain);
  } catch (err) {
    const messageField = chainGet(err, 'message');
    const message = String(messageField.tag === 'some' ? messageField.value : err);
    const code = chainGet(err, 'code');
    if (code.tag === 'some' && code.value === 'pack_corrupt' && /ref delta base/.test(message)) unresolved = true;
    else throw err;
  }
  const byOffset = new Map<number, ResolvedObject>();
  if (resolved) for (const obj of resolved.values()) byOffset.set(obj.offset, obj);
  const objects: PackObjectView[] = parsed.objects.map((obj) => {
    const wire = kindOf(obj.type);
    const full = obj.type >= 1 && obj.type <= 4;
    const placed = mapGet(byOffset, obj.offset);
    const placedOid = placed.tag === 'some' ? chainGet(placed.value, 'oid') : fromNullable(null);
    const typeLabel = fromAbsent((TYPE_NAME as Record<number, string>)[obj.type]);
    const label = typeLabel.tag === 'some' ? typeLabel.value : 'blob';
    const oid = placedOid.tag === 'some' ? (typeof placedOid.value === 'string' ? placedOid.value : String(placedOid.value)) : (full ? hashObject(label, obj.data) : null);
    const resolvedType = placed.tag === 'some' ? kindOf(placed.value.type) : (full ? wire : null);
    const dataField = placed.tag === 'some' ? chainGet(placed.value, 'data') : fromNullable(null);
    const data = dataField.tag === 'some' ? dataField.value as Uint8Array : (full ? obj.data : null);
    const chainField = placed.tag === 'some' ? chainGet(placed.value, 'chain') : fromNullable(null);
    const chain = chainField.tag === 'some' && typeof chainField.value === 'number' ? chainField.value : 0;
    const typeField = placed.tag === 'some' ? chainGet(placed.value, 'type') : fromNullable(null);
    const previewType = typeField.tag === 'some' && typeof typeField.value === 'number' ? typeField.value : obj.type;
    const baseOffset = fromAbsent(obj.baseOffset);
    const baseOid = fromAbsent(obj.baseOid);
    return {
      offset: obj.offset,
      length: obj.headerBytes + obj.compressed,
      headerBytes: obj.headerBytes,
      compressed: obj.compressed,
      inflated: obj.size,
      wireType: wire,
      resolvedType,
      oid,
      baseOffset: baseOffset.tag === 'some' ? baseOffset.value as number | null : null,
      baseOid: baseOid.tag === 'some' ? baseOid.value as string | null : null,
      chain,
      preview: data ? previewOf(previewType, data, limits) : (wire === 'ofs_delta' || wire === 'ref_delta' ? { kind: 'unresolved' } : null),
    };
  });
  const links: DeltaLink[] = objects.filter(obj => obj.baseOffset !== null || obj.baseOid !== null).map(obj => ({
    deltaOffset: obj.offset,
    baseOffset: obj.baseOffset,
    baseOid: obj.baseOid,
    depth: obj.chain,
  }));
  const thin = unresolved || externalBases > 0 || objects.some(obj => obj.wireType === 'ref_delta' && !objects.some(other => other.oid === obj.baseOid));
  const counts: Record<string, number> = {};
  for (const obj of objects) {
    const seen = fromAbsent(counts[obj.wireType]);
    counts[obj.wireType] = (seen.tag === 'some' && typeof seen.value === 'number' ? seen.value : 0) + 1;
  }
  return {
    bytes: parsed.bytes,
    version: parsed.stats.version,
    count: parsed.stats.count,
    trailer: parsed.trailer,
    headerLength: 12,
    trailerLength: 20,
    objects,
    links,
    ofsDelta: parsed.stats.ofsDelta,
    refDelta: parsed.stats.refDelta,
    thin,
    maxChain: Math.max(maxChain, ...objects.map(obj => obj.chain), 0),
    counts,
    unresolved,
  };
}
