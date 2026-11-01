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

function loose<T>(fn: unknown): T {
  return fn as T;
}

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
  quirks: Quirks;
}): GitTransport {
  return loose<(url: string, opts: object) => GitTransport>(createTransportJs)(url, opts);
}

export const discoverRepo: (transport: GitTransport) => Promise<DiscoverInfo> = loose(discoverJs);
export const listRefs: (transport: GitTransport, prefixes: string[]) => Promise<{ refs: Map<string, { oid: string } & Partial<{ peeled: string }>>; head: string | null }> = loose(lsRefsJs);
export const candidates: (ref: string | null) => string[] = loose(refCandidatesJs);
export const viewCommit: (data: Uint8Array, limits: object) => CommitView = loose(commitViewJs);
export const treeEntryType: (mode: string) => string = loose(entryTypeJs);
export const treeMode: (mode: string) => string = loose(lsModeJs);
export const readObject: (transport: GitTransport, opts: { oid: string } & Partial<{ filter: string; deepen: number; expectType: number | null }>) => Promise<Fetched> = loose(fetchObjectJs);
export const readPack: (transport: GitTransport, opts: object, extra: Partial<{ resolve: boolean; attrs: Record<string, unknown> }> | null) => Promise<{ parsed: ParsedPack | null; objects: Map<string, { type: number; data: Uint8Array }> | null }> = loose(fetchPackJs);
export const filterRejected: (err: unknown) => boolean = loose(isFilterRejectionJs);
export const streamPack: (transport: GitTransport, opts: object, span: ViewerSpan) => AsyncIterable<Uint8Array> = loose(packStreamJs);
export const cursorInit: () => PackCursor = loose(spInitJs);
export const cursorStep: (cursor: PackCursor, chunk: Uint8Array) => { state: PackCursor; zlib: Uint8Array[] } = loose(spStepJs);
export const cursorFinish: (cursor: PackCursor) => PackCursor = loose(spFinishJs);
export const inflateObject: (buf: Uint8Array, offset: number, opts: { expectedSize: number; maxOutput: number }) => { out: Uint8Array } = loose(inflateJs);
export const plyCode: (code: unknown) => boolean = loose(isPlyCodeJs);

export function spanCollector(): { lines: unknown[]; exporter: (line: unknown) => void } {
  const exporter = loose<() => { lines: unknown[] } & ((line: unknown) => void)>(arrayExporterJs)();
  return { lines: exporter.lines, exporter };
}

export function makeTracer(exporter: (line: unknown) => void, opts: { maxEvents: number; resource: Record<string, string> }): ViewerTracer {
  return new (TracerJs as unknown as new (options: object) => ViewerTracer)({ exporter, maxEvents: opts.maxEvents, resource: opts.resource });
}
