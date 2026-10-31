// Upstream Cloudflare ray ids for one Worker request.
//
// Every git HTTP exchange the Worker makes (info/refs, v2 ls-refs, upload-pack fetch including a
// blob:none retry, receive-pack) contributes one entry, in the order the exchange was started.
// The response header is a closed grammar, not a free string:
//
//   ray-header = entry *( ", " entry ) [ ", " overflow ]
//   entry      = phase "=" ray ";dur=" duration
//   overflow   = "overflow=" 1*DIGIT
//   phase      = "ls-refs" / "fetch" / "receive-pack"
//   ray        = cf-ray / "-" / "no-response"
//   cf-ray     = 16HEX "-" 3ALPHA          ; Cloudflare ray id (fundamentals/reference/cloudflare-ray-id)
//   duration   = 1*DIGIT                   ; milliseconds until response headers, or until the call failed
//
// "-" means a response arrived and it had no cf-ray (or the value was not a ray id, so it is not echoed).
// "no-response" means the call failed before any response headers arrived (timeout, abort, network).
// "overflow=N" means N further exchanges were dropped so the header stays bounded.
//
// Server-Timing uses the same phases and durations, then `total` for the Worker request.
// Nothing in either header is a URL, a credential, or a repository name.

/** Response header carrying the upstream ray log. */
export const RAY_HEADER = 'x-artifacts-ray';

/** Entries kept on one response. A rebase is one fetch per commit; past this the rest are counted, not listed. */
export const MAX_RAY_ENTRIES = 32;

/** Hex length of a Cloudflare ray id, before the colo. */
export const CF_RAY_HEX_CHARS = 16;
/** Airport-code length of a Cloudflare ray colo. */
export const CF_RAY_COLO_CHARS = 3;

const CF_RAY = new RegExp(`^[0-9a-f]{${CF_RAY_HEX_CHARS}}-[A-Za-z]{${CF_RAY_COLO_CHARS}}$`, 'i');

const rayBrand: unique symbol = Symbol('CfRay');
const durBrand: unique symbol = Symbol('DurationMs');

/** A Cloudflare ray id, `16 hex` + `-` + `3 letters`. Anything else is not echoed. */
export type CfRay = string & { readonly [rayBrand]: 'CfRay' };
/** Non-negative whole milliseconds. */
export type DurationMs = number & { readonly [durBrand]: 'DurationMs' };

export type Phase = 'ls-refs' | 'fetch' | 'receive-pack';

/** What the upstream call told us about its ray. */
export type Ray =
  | { readonly kind: 'id'; readonly id: CfRay }
  | { readonly kind: 'missing' }
  | { readonly kind: 'no_response' };

export type RayEntry = {
  readonly phase: Phase;
  readonly ray: Ray;
  readonly durMs: DurationMs;
  /** False for a redirect hop the guard followed. The header still lists it; the span gets the hop ply read. */
  readonly delivered: boolean;
};

export type RayReport =
  | { readonly kind: 'within'; readonly entries: readonly RayEntry[] }
  | { readonly kind: 'overflow'; readonly entries: readonly RayEntry[]; readonly omitted: number };

const MISSING = '-';
const NO_RESPONSE = 'no-response';
const ENTRY_GAP = ', ';

export function durationMs(start: number, end: number): DurationMs {
  const n = Math.round(end - start);
  return (n > 0 ? n : 0) as DurationMs;
}

/** A response header value, or "missing" when it is absent or not a ray id. */
export function parseCfRay(raw: string | null): Ray {
  if (raw !== null && CF_RAY.test(raw)) return { kind: 'id', id: raw as CfRay };
  return { kind: 'missing' };
}

export function renderRay(ray: Ray): string {
  if (ray.kind === 'id') return ray.id;
  if (ray.kind === 'no_response') return NO_RESPONSE;
  return MISSING;
}

/**
 * Which git exchange a URL is. `null` is not a smart-HTTP git call and is not recorded.
 * info/refs for upload-pack is `ls-refs` (the same phase as a v2 ls-refs POST). A fetch POST,
 * including a blob:none retry, is `fetch`. receive-pack advertisement and the push itself are
 * `receive-pack`.
 */
export function phaseOf(method: string, url: string, body: Uint8Array | null): Phase | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const path = parsed.pathname;
  const verb = method.toUpperCase();
  if (path.endsWith('/info/refs')) {
    const service = parsed.searchParams.get('service');
    if (service === 'git-upload-pack') return 'ls-refs';
    if (service === 'git-receive-pack') return 'receive-pack';
    return null;
  }
  if (verb === 'POST' && path.endsWith('/git-receive-pack')) return 'receive-pack';
  if (verb === 'POST' && path.endsWith('/git-upload-pack')) {
    const head = body ? latin1(body.subarray(0, COMMAND_PREFIX)) : '';
    if (head.includes('command=ls-refs')) return 'ls-refs';
    if (head.includes('command=fetch')) return 'fetch';
  }
  return null;
}

/** Bytes of the pkt-line command. `command=ls-refs` is the longer of the two. */
const COMMAND_PREFIX = 24;

function latin1(body: Uint8Array): string {
  let out = '';
  const n = Math.min(body.length, COMMAND_PREFIX);
  for (let i = 0; i < n; i++) out += String.fromCharCode(body[i] as number);
  return out;
}

function encodeEntry(entry: RayEntry): string {
  return `${entry.phase}=${renderRay(entry.ray)};dur=${entry.durMs}`;
}

/** The `x-artifacts-ray` value. An empty report encodes as the empty string (the header is omitted). */
export function encodeRayHeader(report: RayReport): string {
  const parts = report.entries.map(encodeEntry);
  if (report.kind === 'overflow') parts.push(`overflow=${report.omitted}`);
  return parts.join(ENTRY_GAP);
}

/** Server-Timing metrics for the same exchanges, without `total`. */
export function encodePhaseTiming(report: RayReport): string {
  const parts = report.entries.map(entry => `${entry.phase};dur=${entry.durMs}`);
  if (report.kind === 'overflow') parts.push(`overflow;desc="${report.omitted}"`);
  return parts.join(ENTRY_GAP);
}

/** Phase metrics plus `total` for the Worker request, in whole milliseconds. */
export function encodeServerTiming(report: RayReport, totalMs: number): string {
  const phases = encodePhaseTiming(report);
  const total = `total;dur=${durationMs(0, totalMs)}`;
  return phases ? `${phases}${ENTRY_GAP}${total}` : total;
}

type Slot = {
  phase: Phase;
  ray: Ray;
  durMs: DurationMs;
  delivered: boolean;
  filled: boolean;
};

export type RayLog = {
  reserve(phase: Phase): number | null;
  fill(index: number, ray: Ray, durMs: DurationMs, delivered: boolean): void;
  report(): RayReport;
};

export function createRayLog(): RayLog {
  const slots: Slot[] = [];
  let omitted = 0;
  return {
    reserve(phase) {
      if (slots.length >= MAX_RAY_ENTRIES) { omitted += 1; return null; }
      slots.push({ phase, ray: { kind: 'no_response' }, durMs: durationMs(0, 0), delivered: true, filled: false });
      return slots.length - 1;
    },
    fill(index, ray, durMs, delivered) {
      const slot = slots[index];
      if (!slot) return;
      slot.ray = ray;
      slot.durMs = durMs;
      slot.delivered = delivered;
      slot.filled = true;
    },
    report() {
      const entries: RayEntry[] = slots.filter(slot => slot.filled).map(slot => ({
        phase: slot.phase, ray: slot.ray, durMs: slot.durMs, delivered: slot.delivered,
      }));
      return omitted === 0 ? { kind: 'within', entries } : { kind: 'overflow', entries, omitted };
    },
  };
}

const REDIRECT_MIN = 300;
const REDIRECT_MAX = 400;

export type UpstreamFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function bodyBytes(body: BodyInit | null | undefined): Uint8Array | null {
  return body instanceof Uint8Array ? body : null;
}

/**
 * Record every git exchange `inner` performs. A redirect (3xx) is listed and marked not delivered:
 * the guard follows it, and the span is stamped with the hop ply actually read.
 * A throw before headers is `no-response` and is rethrown unchanged.
 */
export function observeUpstream(inner: UpstreamFetch, log: RayLog): UpstreamFetch {
  return async (input, init) => {
    const method = init?.method ?? 'GET';
    const phase = phaseOf(method, requestUrl(input), bodyBytes(init?.body));
    const index = phase === null ? null : log.reserve(phase);
    const start = Date.now();
    try {
      const res = await inner(input, init);
      if (index !== null) {
        const delivered = res.status < REDIRECT_MIN || res.status >= REDIRECT_MAX;
        log.fill(index, parseCfRay(res.headers.get('cf-ray')), durationMs(start, Date.now()), delivered);
      }
      return res;
    } catch (err) {
      if (index !== null) log.fill(index, { kind: 'no_response' }, durationMs(start, Date.now()), true);
      throw err;
    }
  };
}

type OtlpAttribute = { key: string; value: { stringValue: string } | { intValue: string } };
type OtlpSpan = { name?: string; startTimeUnixNano?: string; attributes?: OtlpAttribute[] };
type OtlpLine = { resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[] };

/**
 * Span names that wrap exactly one git HTTP exchange, in the order those exchanges start.
 * `git.head` is not one of them: it is the parent of a discover GET (the first time an origin is seen) and an
 * ls-refs POST, and each of those has its own span. Counting the parent would pair rays with the wrong exchange.
 */
const SPAN_PHASE: Readonly<Record<string, Phase>> = {
  'git.upload-pack ls-refs': 'ls-refs',
  'git.upload-pack discover': 'ls-refs',
  'git.upload-pack fetch': 'fetch',
  'git.receive-pack': 'receive-pack',
  'git.receive-pack advertise': 'receive-pack',
};

const ATTR_RAY = 'git.upstream.cf_ray';
const ATTR_PHASE = 'git.upstream.phase';
const ATTR_DUR = 'git.upstream.dur_ms';

/**
 * Copy each delivered exchange onto the span that performed it, in start order.
 * Attributes are `git.upstream.cf_ray`, `git.upstream.phase`, and `git.upstream.dur_ms`.
 * The value is the same token the header uses (`-` or `no-response` included).
 */
export function stampUpstreamSpans(lines: readonly unknown[], report: RayReport): void {
  const spans: { start: bigint; span: OtlpSpan }[] = [];
  for (const line of lines as OtlpLine[]) {
    for (const resource of line.resourceSpans ?? []) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          if (!span.name || !(span.name in SPAN_PHASE)) continue;
          spans.push({ start: BigInt(span.startTimeUnixNano ?? '0'), span });
        }
      }
    }
  }
  spans.sort((a, b) => {
    if (a.start < b.start) return -1;
    if (a.start > b.start) return 1;
    return 0;
  });
  const delivered = report.entries.filter(entry => entry.delivered);
  const n = Math.min(spans.length, delivered.length);
  for (let i = 0; i < n; i++) {
    const entry = delivered[i];
    const span = spans[i];
    if (!entry || !span) continue;
    const attributes = span.span.attributes ?? (span.span.attributes = []);
    attributes.push(
      { key: ATTR_RAY, value: { stringValue: renderRay(entry.ray) } },
      { key: ATTR_PHASE, value: { stringValue: entry.phase } },
      { key: ATTR_DUR, value: { intValue: String(entry.durMs) } },
    );
  }
}

const EXPOSE = [RAY_HEADER, 'server-timing'];

/**
 * When a response already opts into CORS, let browsers read the ray log and Server-Timing.
 * A response with no Access-Control-Allow-Origin is left alone.
 */
export function exposeRayHeaders(headers: Headers): void {
  if (!headers.has('access-control-allow-origin')) return;
  const have = new Set((headers.get('access-control-expose-headers') ?? '').split(',').map(part => part.trim().toLowerCase()).filter(Boolean));
  for (const name of EXPOSE) have.add(name);
  headers.set('access-control-expose-headers', [...have].join(', '));
}

/** Set `x-artifacts-ray` when the log is non-empty, and Server-Timing (phases plus total) always. */
export function applyUpstreamHeaders(headers: Headers, report: RayReport, totalMs: number): void {
  const ray = encodeRayHeader(report);
  if (ray) headers.set(RAY_HEADER, ray);
  const phases = encodePhaseTiming(report);
  const total = `total;dur=${durationMs(0, totalMs)}`;
  const prior = headers.get('server-timing');
  headers.set('server-timing', prior ? [phases, prior].filter(Boolean).join(ENTRY_GAP) : [phases, total].filter(Boolean).join(ENTRY_GAP));
  exposeRayHeaders(headers);
}
