// The workbench's own reading of the git wire, independent of ply's parsers: the pkt-lines of a request or an answer,
// the refs and capabilities of an advertisement, the commands of a receive-pack request, the report-status a server
// sends back (through side-band-64k when it was asked for), and what a v2 request asks. The verdict compares this
// reading with ply's (src/bench/verdict.ts), so a disagreement between ply and the bytes is evidence, not a guess.
// Pure: bytes in, values out. Object ids and ref names only; a credential is never in a git body.
import { parseOid, type Oid } from 'ply';

const FLUSH = 0;
const DELIM = 1;
const RESPONSE_END = 2;
const HEADER_BYTES = 4;
const MAX_LINES = 2_000;
const TEXT_MAX = 400;
const BAND_DATA = 1;
const BAND_PROGRESS = 2;
const BAND_ERROR = 3;
const PACK_SIGNATURE = [0x50, 0x41, 0x43, 0x4b] as const;

export type Pkt =
  | { readonly tag: 'data'; readonly bytes: Uint8Array }
  | { readonly tag: 'flush' }
  | { readonly tag: 'delim' }
  | { readonly tag: 'response-end' };

// Where the framing stopped: the end of the body, a raw pack, a line cap, or bytes that are not a pkt-line.
export type PktStop = 'end' | 'pack' | 'cap' | 'malformed' | 'truncated';
export type PktRead = { readonly pkts: readonly Pkt[]; readonly stop: PktStop; readonly consumed: number };

const HEX = /^[0-9a-f]{4}$/;
const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8', { fatal: false });

function isPackAt(buf: Uint8Array, at: number): boolean {
  return PACK_SIGNATURE.every((b, i) => buf[at + i] === b);
}

export function readPkts(buf: Uint8Array, limit: number = MAX_LINES): PktRead {
  const pkts: Pkt[] = [];
  let at = 0;
  while (at < buf.length) {
    if (pkts.length >= limit) return { pkts, stop: 'cap', consumed: at };
    if (isPackAt(buf, at)) return { pkts, stop: 'pack', consumed: at };
    if (at + HEADER_BYTES > buf.length) return { pkts, stop: 'truncated', consumed: at };
    const head = latin1.decode(buf.subarray(at, at + HEADER_BYTES));
    if (!HEX.test(head)) return { pkts, stop: 'malformed', consumed: at };
    const n = parseInt(head, 16);
    if (n === FLUSH) { pkts.push({ tag: 'flush' }); at += HEADER_BYTES; continue; }
    if (n === DELIM) { pkts.push({ tag: 'delim' }); at += HEADER_BYTES; continue; }
    if (n === RESPONSE_END) { pkts.push({ tag: 'response-end' }); at += HEADER_BYTES; continue; }
    if (n < HEADER_BYTES) return { pkts, stop: 'malformed', consumed: at };
    if (at + n > buf.length) return { pkts, stop: 'truncated', consumed: at };
    pkts.push({ tag: 'data', bytes: buf.subarray(at + HEADER_BYTES, at + n) });
    at += n;
  }
  return { pkts, stop: 'end', consumed: at };
}

const textOf = (bytes: Uint8Array): string => latin1.decode(bytes).replace(/\n$/, '');
const dataLines = (pkts: readonly Pkt[]): string[] => pkts.flatMap(p => (p.tag === 'data' ? [textOf(p.bytes)] : []));

// ---- advertisement (GET info/refs?service=...) ----
export type AdvertisedRef = { readonly oid: Oid; readonly ref: string };
export type Advertisement = {
  readonly service: string | null;
  readonly version: 'v0' | 'v2';
  readonly refs: readonly AdvertisedRef[];
  readonly capabilities: readonly string[];
};

function oidRef(line: string): AdvertisedRef | null {
  const space = line.indexOf(' ');
  if (space < 0) return null;
  const oid = parseOid(line.slice(0, space));
  if (!oid.ok) return null;
  return { oid: oid.value, ref: line.slice(space + 1) };
}

export function readAdvertisement(body: Uint8Array): Advertisement {
  const lines = dataLines(readPkts(body).pkts);
  let service: string | null = null;
  let version: 'v0' | 'v2' = 'v0';
  const refs: AdvertisedRef[] = [];
  let capabilities: string[] = [];
  for (const line of lines) {
    if (line.startsWith('# service=')) { service = line.slice('# service='.length); continue; }
    if (line === 'version 2') { version = 'v2'; continue; }
    if (version === 'v2') { capabilities.push(line); continue; }
    const nul = line.indexOf('\0');
    const head = nul < 0 ? line : line.slice(0, nul);
    if (nul >= 0) capabilities = line.slice(nul + 1).split(' ').filter(c => c.length > 0);
    const r = oidRef(head);
    if (r !== null && r.ref !== 'capabilities^{}') refs.push(r);
  }
  return { service, version, refs, capabilities };
}

// ---- a receive-pack request: commands, then a pack ----
export type Command = { readonly old: Oid; readonly new: Oid; readonly ref: string };
export type ReceiveRequest = { readonly commands: readonly Command[]; readonly capabilities: readonly string[]; readonly shallow: readonly Oid[]; readonly packBytes: number };

export function readReceiveRequest(body: Uint8Array): ReceiveRequest {
  const read = readPkts(body);
  const commands: Command[] = [];
  const shallow: Oid[] = [];
  let capabilities: string[] = [];
  for (const line of dataLines(read.pkts)) {
    if (line.startsWith('shallow ')) {
      const s = parseOid(line.slice('shallow '.length));
      if (s.ok) shallow.push(s.value);
      continue;
    }
    const nul = line.indexOf('\0');
    if (nul >= 0) capabilities = line.slice(nul + 1).split(' ').filter(c => c.length > 0);
    const [old, next, ref] = (nul < 0 ? line : line.slice(0, nul)).split(' ');
    const o = parseOid(String(old));
    const n = parseOid(String(next));
    if (o.ok && n.ok && typeof ref === 'string' && ref.length > 0) commands.push({ old: o.value, new: n.value, ref });
  }
  return { commands, capabilities, shallow, packBytes: read.stop === 'pack' ? body.length - read.consumed : 0 };
}

// ---- side-band-64k ----
export type Sideband = {
  readonly bands: { readonly data: number; readonly progress: number; readonly error: number };
  readonly progress: string;
  readonly error: string;
};
// The demultiplexed band-1 bytes beside the summary; only the summary is kept with an exchange.
export type Demuxed = { readonly sideband: Sideband; readonly data: Uint8Array };

export function demuxSideband(pkts: readonly Pkt[]): Demuxed {
  const parts: Uint8Array[] = [];
  let data = 0;
  let progress = 0;
  let error = 0;
  let progressText = '';
  let errorText = '';
  for (const p of pkts) {
    if (p.tag !== 'data' || p.bytes.length === 0) continue;
    const band = p.bytes[0];
    const payload = p.bytes.subarray(1);
    if (band === BAND_DATA) { data += payload.length; parts.push(payload); }
    else if (band === BAND_PROGRESS) { progress += payload.length; if (progressText.length < TEXT_MAX) progressText += utf8.decode(payload); }
    else if (band === BAND_ERROR) { error += payload.length; if (errorText.length < TEXT_MAX) errorText += utf8.decode(payload); }
  }
  const joined = new Uint8Array(data);
  let at = 0;
  for (const part of parts) { joined.set(part, at); at += part.length; }
  return { sideband: { bands: { data, progress, error }, progress: progressText.slice(0, TEXT_MAX), error: errorText.slice(0, TEXT_MAX) }, data: joined };
}

const isBanded = (pkts: readonly Pkt[]): boolean => {
  const first = pkts.find(p => p.tag === 'data');
  if (first === null || typeof first !== 'object' || first.tag !== 'data' || first.bytes.length === 0) return false;
  const b = first.bytes[0];
  return b === BAND_DATA || b === BAND_PROGRESS || b === BAND_ERROR;
};

// ---- report-status: what the server says it did with a push ----
export type Unpack = { readonly tag: 'ok' } | { readonly tag: 'error'; readonly reason: string };
export type RefStatus = { readonly tag: 'ok'; readonly ref: string } | { readonly tag: 'ng'; readonly ref: string; readonly reason: string };
export type Report =
  | { readonly tag: 'report'; readonly unpack: Unpack; readonly refs: readonly RefStatus[]; readonly sideband: Sideband | null }
  // the answer carried no report-status (empty, cut, or only an error band)
  | { readonly tag: 'none'; readonly why: string; readonly sideband: Sideband | null };

export function readReport(body: Uint8Array): Report {
  if (body.length === 0) return { tag: 'none', why: 'empty answer', sideband: null };
  const outer = readPkts(body);
  const banded = isBanded(outer.pkts);
  const demuxed = banded ? demuxSideband(outer.pkts) : null;
  const sideband = demuxed === null ? null : demuxed.sideband;
  const lines = dataLines(demuxed === null ? outer.pkts : readPkts(demuxed.data).pkts);
  const unpackLine = lines.find(l => l.startsWith('unpack '));
  if (typeof unpackLine !== 'string') return { tag: 'none', why: sideband !== null && sideband.error.length > 0 ? `no report; band 3: ${sideband.error}` : `no report-status (${outer.stop})`, sideband };
  const said = unpackLine.slice('unpack '.length);
  const unpack: Unpack = said === 'ok' ? { tag: 'ok' } : { tag: 'error', reason: said };
  const refs: RefStatus[] = [];
  for (const l of lines) {
    if (l.startsWith('ok ')) refs.push({ tag: 'ok', ref: l.slice(3) });
    else if (l.startsWith('ng ')) {
      const rest = l.slice(3);
      const sp = rest.indexOf(' ');
      refs.push(sp < 0 ? { tag: 'ng', ref: rest, reason: '' } : { tag: 'ng', ref: rest.slice(0, sp), reason: rest.slice(sp + 1) });
    }
  }
  return { tag: 'report', unpack, refs, sideband };
}

// What the report says happened to the push as a whole: every ref ok, some, none, or no report at all.
export type ReportVerdict = 'all-ok' | 'some-ok' | 'none-ok' | 'no-report';
export function reportVerdict(r: Report): ReportVerdict {
  if (r.tag === 'none') return 'no-report';
  if (r.unpack.tag === 'error') return 'none-ok';
  const ok = r.refs.filter(x => x.tag === 'ok').length;
  if (r.refs.length > 0 && ok === r.refs.length) return 'all-ok';
  return ok > 0 ? 'some-ok' : 'none-ok';
}

// ---- protocol v2 requests ----
export type V2Request = { readonly command: string | null; readonly args: readonly string[] };
export function readV2Request(body: Uint8Array): V2Request {
  const lines = dataLines(readPkts(body).pkts);
  const cmd = lines.find(l => l.startsWith('command='));
  const args = lines.filter(l => !l.startsWith('command=') && !l.startsWith('agent=') && !l.startsWith('object-format=')).slice(0, 64);
  return { command: typeof cmd === 'string' ? cmd.slice('command='.length) : null, args };
}

// The answer of a v2 fetch: its sections, and the side-band of its packfile section.
export type FetchAnswer = { readonly sections: readonly string[]; readonly sideband: Sideband | null };
export function readFetchAnswer(body: Uint8Array): FetchAnswer {
  const pkts = readPkts(body).pkts;
  const sections: string[] = [];
  let at = -1;
  for (const [i, p] of pkts.entries()) {
    if (p.tag !== 'data') continue;
    const t = textOf(p.bytes);
    if (t === 'acknowledgments' || t === 'shallow-info' || t === 'wanted-refs' || t === 'packfile-uris' || t === 'packfile') { sections.push(t); if (t === 'packfile') at = i; }
  }
  return { sections, sideband: at < 0 ? null : demuxSideband(pkts.slice(at + 1)).sideband };
}
