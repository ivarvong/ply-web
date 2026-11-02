// The viewer's narrowed view of ply. ply now ships .d.ts types, but these signatures predate them and are looser
// (opaque transport, `object` options, a partial pack cursor), so loose() still casts at this one boundary. Replacing
// them with ply's own types (Transport, FetchOpts, SpState, Limits) is the follow-up.
import { discover as discoverJs } from 'ply';
import { isPlyCode as isPlyCodeJs } from 'ply';
import { fetchObject as fetchObjectJs, isFilterRejection as isFilterRejectionJs, packStream as packStreamJs, spFinish as spFinishJs, spInit as spInitJs, spStep as spStepJs } from 'ply';
import { fetchPack as fetchPackJs } from 'ply';
import { createTransport as createTransportJs } from 'ply';
import { inflate as inflateJs } from 'ply';
import { lsRefs as lsRefsJs } from 'ply';
import { Tracer as TracerJs, arrayExporter as arrayExporterJs } from 'ply';
import { commitView as commitViewJs, entryType as entryTypeJs, lsMode as lsModeJs, refCandidates as refCandidatesJs } from 'ply';
import type { FetchLike } from './fetchguard.ts';
import type { ParsedPack } from './packmap.ts';
import type { Quirks } from '../quirks.ts';
import { unwrap, unwrapAsync } from '../ply-result.ts';

function loose<T>(fn: unknown): T {
  return fn as T;
}

// ply 0.2.0 returns its failures as values; the viewer throws them (ply-result.ts), as ply 0.1 did.
type PlyResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export type GitTransport = object;

export type ViewerSpan = {
  set: (attrs: Record<string, unknown>) => ViewerSpan;
  end: () => ViewerSpan;
  error: (err: unknown) => ViewerSpan;
};

type StartOpts = Partial<{ parent: unknown; kind: number; attrs: Record<string, unknown> }>;

export type ViewerTracer = {
  start: (name: string, opts: StartOpts | null) => ViewerSpan;
};

export type DiscoverInfo = {
  version: number;
  agent: string;
  objectFormat: string;
  caps: Map<string, string>;
  fetch: string[];
  filter: boolean;
};

export type PackCursor = { phase: string; type: number; size: number; bytes: number };

type Fetched = { type: number; data: Uint8Array; oid: string; size: number };
type CommitView = {
  tree: string | null;
  parents: string[];
  author: Partial<{ name: string; email: string; time: string | null; tz: string }> | null;
  message: string | null;
  signed: boolean;
};

export function createGitTransport(url: string, opts: {
  tracer: ViewerTracer;
  fetchImpl: FetchLike;
  userAgent: string;
  limits: object;
  signal: AbortSignal;
  quirks: Partial<Quirks>;
}): GitTransport {
  return unwrap(loose<(url: string, opts: object) => PlyResult<GitTransport>>(createTransportJs)(url, opts));
}

export const discoverRepo = async (transport: GitTransport): Promise<DiscoverInfo> => unwrapAsync(loose<(t: GitTransport) => Promise<PlyResult<DiscoverInfo>>>(discoverJs)(transport));
type Listing = { refs: Map<string, { oid: string } & Partial<{ peeled: string }>>; head: string | null };
export const listRefs = async (transport: GitTransport, prefixes: string[]): Promise<Listing> => unwrapAsync(loose<(t: GitTransport, p: string[]) => Promise<PlyResult<Listing>>>(lsRefsJs)(transport, prefixes));
export const candidates = (ref: string | null): string[] => unwrap(loose<(r: string | null) => PlyResult<string[]>>(refCandidatesJs)(ref));
export const viewCommit = (data: Uint8Array, limits: object): CommitView => unwrap(loose<(d: Uint8Array, l: object) => PlyResult<CommitView>>(commitViewJs)(data, limits));
export const treeEntryType: (mode: string) => string = loose(entryTypeJs);
export const treeMode: (mode: string) => string = loose(lsModeJs);
type ObjectOpts = { oid: string } & Partial<{ filter: string; deepen: number; expectType: number | null }>;
export const readObject = async (transport: GitTransport, opts: ObjectOpts): Promise<Fetched> => unwrapAsync(loose<(t: GitTransport, o: ObjectOpts) => Promise<PlyResult<Fetched>>>(fetchObjectJs)(transport, opts));
type PackExtra = Partial<{ resolve: boolean; attrs: Record<string, unknown> }> | null;
type FetchedPack = { parsed: ParsedPack | null; objects: Map<string, { type: number; data: Uint8Array }> | null };
export const readPack = async (transport: GitTransport, opts: object, extra: PackExtra): Promise<FetchedPack> => unwrapAsync(loose<(t: GitTransport, o: object, e: PackExtra) => Promise<PlyResult<FetchedPack>>>(fetchPackJs)(transport, opts, extra));
export const filterRejected: (err: unknown) => boolean = loose(isFilterRejectionJs);
export const streamPack: (transport: GitTransport, opts: object, span: ViewerSpan) => AsyncIterable<Uint8Array> = loose(packStreamJs);
export const cursorInit: () => PackCursor = loose(spInitJs);
type Stepped = { state: PackCursor; zlib: Uint8Array[] };
export const cursorStep = (cursor: PackCursor, chunk: Uint8Array): Stepped => unwrap(loose<(c: PackCursor, b: Uint8Array) => PlyResult<Stepped>>(spStepJs)(cursor, chunk));
export const cursorFinish = (cursor: PackCursor): PackCursor => unwrap(loose<(c: PackCursor) => PlyResult<PackCursor>>(spFinishJs)(cursor));
type InflateOpts = { expectedSize: number; maxOutput: number };
export const inflateObject = (buf: Uint8Array, offset: number, opts: InflateOpts): { out: Uint8Array } => unwrap(loose<(b: Uint8Array, o: number, x: InflateOpts) => PlyResult<{ out: Uint8Array }>>(inflateJs)(buf, offset, opts));
export const plyCode: (code: unknown) => boolean = loose(isPlyCodeJs);

export function spanCollector(): { lines: unknown[]; exporter: (line: unknown) => void } {
  const exporter = loose<() => { lines: unknown[] } & ((line: unknown) => void)>(arrayExporterJs)();
  return { lines: exporter.lines, exporter };
}

export function makeTracer(exporter: (line: unknown) => void, opts: { maxEvents: number; resource: Record<string, string> }): ViewerTracer {
  return new (TracerJs as unknown as new (options: object) => ViewerTracer)({ exporter, maxEvents: opts.maxEvents, resource: opts.resource });
}
