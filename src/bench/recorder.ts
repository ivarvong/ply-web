// The recording transport: a fetch the workbench hands to each ply client it runs (one per channel), which forwards
// every request upstream and records the exchange: when it started, when the server's headers came, when its answer
// ended, the bytes each way, the status, the cf-ray, the headers (a credential never: request headers are an allow-list
// and every text passes the run's scrubber), and what the git bytes say (src/bench/wire.ts). It also applies a step's
// fault (ply/probes Fault) to the first matching request of the `main` channel, as ply's recording proxy does.
// Channels: `main` (ply, the client under test), `side` (seeding and the racing writer), `judge` (reading the result).
import type { Fault } from 'ply/probes';
import type { Span, Tracer } from 'ply';
import { parseCfRay, renderRay, type Ray } from '../rays.ts';
import { readAdvertisement, readFetchAnswer, readPkts, readReceiveRequest, readReport, readV2Request, reportVerdict, type Advertisement, type FetchAnswer, type ReceiveRequest, type Report, type V2Request, type AdvertisedRef } from './wire.ts';

export type Channel = 'main' | 'side' | 'judge';
// Which part of the run an exchange belongs to.
export type Phase = { readonly tag: 'seed' } | { readonly tag: 'step'; readonly index: number } | { readonly tag: 'judge' } | { readonly tag: 'cleanup' };
export type ExchangeKind = 'advertise-upload' | 'advertise-receive' | 'ls-refs' | 'fetch' | 'receive-pack' | 'other';

export type Wire =
  | { readonly tag: 'advertisement'; readonly advertisement: Advertisement }
  | { readonly tag: 'receive-pack'; readonly request: ReceiveRequest; readonly report: Report }
  | { readonly tag: 'ls-refs'; readonly request: V2Request; readonly refs: readonly AdvertisedRef[] }
  | { readonly tag: 'fetch'; readonly request: V2Request; readonly answer: FetchAnswer }
  | { readonly tag: 'opaque' };

export type Answer =
  | { readonly tag: 'http'; readonly status: number }
  // no HTTP answer reached the recorder: the upstream closed, a fault cut the request, or the client gave up
  | { readonly tag: 'no-response'; readonly error: string };

// The fault applied to this exchange, as it happened.
export type Applied =
  | { readonly tag: 'race'; readonly moved: number }
  | { readonly tag: 'cut-response'; readonly heldBytes: number }
  | { readonly tag: 'cut-request'; readonly sentBytes: number }
  | { readonly tag: 'stall-request'; readonly atBytes: number; readonly ms: number }
  | { readonly tag: 'stall-response'; readonly ms: number }
  | { readonly tag: 'drop-response'; readonly deliveredBytes: number };

export type Exchange = {
  readonly i: number;
  readonly phase: Phase;
  readonly channel: Channel;
  readonly method: string;
  readonly path: string;
  readonly kind: ExchangeKind;
  readonly answer: Answer;
  // milliseconds from the start of the run; headersMs is null when no headers came
  readonly startMs: number;
  readonly headersMs: number | null;
  readonly endMs: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly cfRay: Ray;
  readonly requestHeaders: ReadonlyArray<readonly [string, string]>;
  readonly responseHeaders: ReadonlyArray<readonly [string, string]>;
  readonly wire: Wire;
  readonly applied: Applied | null;
};

// A fault armed for the next matching request of `main`: a push step's first receive-pack POST, or a fetch step's first
// upload-pack POST that carries command=fetch. A race runs the other writer before forwarding.
export type Armed = { readonly fault: Exclude<Fault, { readonly tag: 'none' }>; readonly on: 'receive' | 'fetch'; readonly race: () => Promise<number> };

export type Recorder = {
  readonly exchanges: Exchange[];
  readonly fetchFor: (channel: Channel) => typeof fetch;
  readonly arm: (a: Armed) => void;
  readonly disarm: () => boolean; // true when the armed fault never fired
  readonly setPhase: (p: Phase, span: Span | null) => void;
};

export type RecorderDeps = {
  readonly upstream: typeof fetch;
  readonly now: () => number; // milliseconds since the run started
  readonly scrub: (text: string) => string;
  readonly tracer: Tracer;
  // the bodies of an exchange, for the run's blob store (R2); never awaited on the request path's answer
  readonly keepBodies: (i: number, request: Uint8Array, response: Uint8Array) => void;
};

const REQUEST_HEADERS = new Set(['content-type', 'accept', 'git-protocol', 'user-agent', 'content-encoding', 'content-length']);
const PROBE_BYTES = 4; // stock git's 4-byte probe POST; ply sends none, but a 4-byte body is never the push
const CUT_REQUEST_DELAY_MS = 500;
// A streamed request body: Node's fetch (the tests) wants duplex 'half'; the Workers runtime ignores it.
const streamed = (init: RequestInit): RequestInit => (init.body instanceof ReadableStream ? ({ ...init, duplex: 'half' } as RequestInit) : init);

export function kindOf(method: string, path: string, body: Uint8Array): ExchangeKind {
  const bare = path.split('?')[0] || '';
  if (method === 'GET' && bare.endsWith('/info/refs')) return path.includes('service=git-receive-pack') ? 'advertise-receive' : 'advertise-upload';
  if (method === 'POST' && bare.endsWith('/git-receive-pack')) return 'receive-pack';
  if (method === 'POST' && bare.endsWith('/git-upload-pack')) {
    const cmd = readV2Request(body).command;
    if (cmd === 'ls-refs') return 'ls-refs';
    if (cmd === 'fetch') return 'fetch';
  }
  return 'other';
}

function wireOf(kind: ExchangeKind, request: Uint8Array, response: Uint8Array, answered: boolean): Wire {
  switch (kind) {
    case 'advertise-upload':
    case 'advertise-receive':
      return answered ? { tag: 'advertisement', advertisement: readAdvertisement(response) } : { tag: 'opaque' };
    case 'receive-pack':
      return { tag: 'receive-pack', request: readReceiveRequest(request), report: readReport(response) };
    case 'ls-refs': {
      const refs = readPkts(response).pkts.flatMap(p => {
        if (p.tag !== 'data') return [];
        const [oid, ref] = new TextDecoder('latin1').decode(p.bytes).replace(/\n$/, '').split(' ');
        return typeof oid === 'string' && /^[0-9a-f]{40}$/.test(oid) && typeof ref === 'string' ? [{ oid: oid as AdvertisedRef['oid'], ref }] : [];
      });
      return { tag: 'ls-refs', request: readV2Request(request), refs };
    }
    case 'fetch':
      return { tag: 'fetch', request: readV2Request(request), answer: readFetchAnswer(response) };
    case 'other':
      return { tag: 'opaque' };
  }
}

const sleep = (ms: number, signal: AbortSignal | null): Promise<void> => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal !== null) signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});
const errorText = (e: unknown): string => {
  const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
  return `${m}${cause}`.slice(0, 300);
};

async function plainBody(req: Request): Promise<Uint8Array> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.body === null) return new Uint8Array(0);
  const raw = new Uint8Array(await req.arrayBuffer());
  if (req.headers.get('content-encoding') !== 'gzip') return raw;
  return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

export function createRecorder(deps: RecorderDeps): Recorder {
  const exchanges: Exchange[] = [];
  let armed: Armed | null = null;
  let phase: Phase = { tag: 'seed' };
  let parent: Span | null = null;

  const fetchFor = (channel: Channel): typeof fetch => async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const path = `${url.pathname}${url.search}`;
    const body = await plainBody(req);
    const kind = kindOf(req.method, path, body);
    const i = exchanges.length;
    const startMs = deps.now();
    const span = deps.tracer.start('bench.exchange', { parent, attrs: { 'bench.channel': channel, 'bench.exchange': i, 'bench.kind': kind, 'http.request.method': req.method, 'url.path': url.pathname, 'http.request.body.size': body.length } });
    let fault: Armed | null = null;
    if (armed !== null && channel === 'main' && (armed.on === 'receive' ? kind === 'receive-pack' && body.length > PROBE_BYTES : kind === 'fetch')) { fault = armed; armed = null; }
    const headers = new Headers();
    for (const [k, v] of req.headers) if (k !== 'content-encoding' && k !== 'content-length') headers.set(k, v);
    const requestHeaders = [...req.headers].filter(([k]) => REQUEST_HEADERS.has(k)).map(([k, v]) => [k, deps.scrub(v)] as const);
    let applied: Applied | null = null;
    const finish = (answer: Answer, headersMs: number | null, response: Uint8Array, res: Response | null): void => {
      const ray = res === null ? { kind: 'no_response' } as const : parseCfRay(res.headers.get('cf-ray'));
      const ex: Exchange = {
        i, phase, channel, method: req.method, path: deps.scrub(path), kind, answer, startMs, headersMs, endMs: deps.now(),
        requestBytes: body.length, responseBytes: response.length, cfRay: ray, requestHeaders,
        responseHeaders: res === null ? [] : [...res.headers].map(([k, v]) => [k, deps.scrub(v)] as const),
        wire: wireOf(kind, body, response, answer.tag === 'http' && answer.status === 200), applied,
      };
      exchanges.push(ex);
      deps.keepBodies(i, body, response);
      const report = ex.wire.tag === 'receive-pack' ? reportVerdict(ex.wire.report) : 'n/a';
      span.set({ 'cf.ray': renderRay(ray), 'http.response.body.size': response.length, 'bench.report': report, 'bench.fault': applied === null ? 'none' : applied.tag, 'bench.ttfb_ms': headersMs === null ? -1 : headersMs - startMs });
      if (answer.tag === 'http') span.set({ 'http.response.status_code': answer.status });
      if (answer.tag === 'no-response') span.error(new Error(answer.error)); else span.ok();
      span.end();
    };
    try {
      if (fault !== null && fault.fault.tag === 'race') applied = { tag: 'race', moved: await fault.race() };
      const reqBody = req.method === 'GET' || req.method === 'HEAD' ? null : body;
      if (fault !== null && fault.fault.tag === 'cut-request' && reqBody !== null) {
        const cutAt = Math.max(1, Math.floor(reqBody.length * fault.fault.fraction));
        applied = { tag: 'cut-request', sentBytes: cutAt };
        const ctl = new AbortController();
        const part = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(reqBody.slice(0, cutAt)); setTimeout(() => { c.error(new Error('probe: request body cut')); ctl.abort(); }, CUT_REQUEST_DELAY_MS); } });
        try {
          const up = await deps.upstream(req.url, streamed({ method: req.method, headers, body: part, redirect: 'manual', signal: ctl.signal }));
          if (up.body !== null) await up.body.cancel();
          finish({ tag: 'http', status: up.status }, deps.now(), new Uint8Array(0), up);
        } catch (e) {
          finish({ tag: 'no-response', error: `cut at ${cutAt} of ${reqBody.length} bytes: ${errorText(e)}` }, null, new Uint8Array(0), null);
        }
        throw new TypeError('network connection lost (probe: request body cut)');
      }
      let sent: BodyInit | null = reqBody === null ? null : reqBody.slice();
      if (fault !== null && fault.fault.tag === 'stall-request' && reqBody !== null) {
        const at = Math.max(1, Math.floor(reqBody.length * fault.fault.fraction));
        const ms = fault.fault.ms;
        applied = { tag: 'stall-request', atBytes: at, ms };
        sent = new ReadableStream<Uint8Array>({ async start(c) { c.enqueue(reqBody.slice(0, at)); await sleep(ms, null); c.enqueue(reqBody.slice(at)); c.close(); } });
      }
      const up = await deps.upstream(req.url, streamed({ method: req.method, headers, body: sent, redirect: 'manual', signal: req.signal }));
      const headersMs = deps.now();
      const buf = new Uint8Array(await up.arrayBuffer());
      finish({ tag: 'http', status: up.status }, headersMs, buf, up);
      const out = new Headers(up.headers);
      out.delete('content-encoding');
      out.set('content-length', String(buf.length));
      if (fault !== null && fault.fault.tag === 'cut-response') {
        applied = { tag: 'cut-response', heldBytes: buf.length };
        exchanges[i] = { ...exchanges[i] as Exchange, applied };
        throw new TypeError('network connection lost (probe: answer cut)');
      }
      if (fault !== null && fault.fault.tag === 'stall-response') {
        applied = { tag: 'stall-response', ms: fault.fault.ms };
        exchanges[i] = { ...exchanges[i] as Exchange, applied };
        await sleep(fault.fault.ms, req.signal);
      }
      if (fault !== null && fault.fault.tag === 'drop-response') {
        const cut = Math.floor(buf.length * fault.fault.fraction);
        applied = { tag: 'drop-response', deliveredBytes: cut };
        exchanges[i] = { ...exchanges[i] as Exchange, applied };
        const part = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(buf.slice(0, cut)); c.error(new TypeError('network connection lost (probe: answer dropped)')); } });
        return new Response(part, { status: up.status, statusText: up.statusText, headers: out });
      }
      return new Response(up.status === 204 || up.status === 304 ? null : buf, { status: up.status, statusText: up.statusText, headers: out });
    } catch (e) {
      if (exchanges.length === i) finish({ tag: 'no-response', error: errorText(e) }, null, new Uint8Array(0), null);
      throw e;
    }
  };

  return {
    exchanges,
    fetchFor,
    arm: a => { armed = a; },
    disarm: () => { const left = armed !== null; armed = null; return left; },
    setPhase: (p, span) => { phase = p; parent = span; },
  };
}
