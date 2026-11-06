// The only fetch the viewer uses. It cannot carry credentials: forbidden headers are dropped, the
// User-Agent is forced, redirects are never followed here (ply follows the first GET info/refs, git's rule), and
// every request and every Location must stay on the same git smart-HTTP endpoint. A Request with Authorization cannot be passed through this type.
import { plyError } from 'ply';
import type { PlyError } from '../ply-result.ts';
import { atIndex, chainGet } from '../absent.ts';
import { unwrapOr } from '../option.ts';
import type { Budget } from './budget.ts';
import { VIEWER_UA } from './limits.ts';
import { extractRequestPath, rawPathHasUnsafeSegment } from '../pathguard.ts';
import { assertUpstreamUrl, type AllowedHost, type ValidatedPublicRepoUrl } from './url.ts';

declare const credentialFree: unique symbol;
export type CredentialFreeHeaders = Headers & { readonly [credentialFree]: 'CredentialFreeHeaders' };

const ALLOWED = new Set(['content-type', 'accept', 'git-protocol', 'x-ply-cache']);

export function credentialFreeHeaders(source: HeadersInit | null): CredentialFreeHeaders {
  const incoming = source === null ? new Headers() : new Headers(source);
  const out = new Headers();
  for (const [key, value] of incoming) {
    if (ALLOWED.has(key.toLowerCase())) out.set(key, value);
  }
  out.set('user-agent', VIEWER_UA);
  return out as CredentialFreeHeaders;
}

export type ViewerUpstreamInit = {
  readonly credential: 'absent';
  method: string;
  headers: CredentialFreeHeaders;
  body: Uint8Array | null;
  signal: AbortSignal | null;
  redirect: 'manual';
};

export type FetchLike = typeof globalThis.fetch;

function limitBody(res: Response, budget: Budget): Response {
  if (!res.body) return res;
  const reader = res.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await reader.read();
        if (step.done) { controller.close(); return; }
        budget.addBytes(step.value.byteLength);
        controller.enqueue(step.value);
      } catch (err) {
        await reader.cancel(err).catch(() => {});
        controller.error(err);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// A 3xx Location the viewer will let ply see: no controls, no encoded dot or slash, no unsafe segment, and once resolved
// still this repo's smart-HTTP endpoint (assertUpstreamUrl). Anything else throws the bad_request it always has.
function vetLocation(location: string, current: string, repo: ValidatedPublicRepoUrl, allowed: readonly AllowedHost[]): void {
  // oxlint-disable-next-line no-control-regex -- controls in a Location are not a URL
  if (/[\u0000-\u001f\u007f]/.test(location) || location.includes('\\') || /%(2e|2f|5c)/i.test(location)) throw plyError('bad_request', 'redirect host is not an allowlisted host');
  const locationPath = unwrapOr(atIndex(location.split(/[?#]/), 0), '');
  if (rawPathHasUnsafeSegment(locationPath.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(location) ? extractRequestPath(location.startsWith('/') ? `https://reject.invalid${locationPath}` : location) : locationPath)) {
    throw plyError('bad_request', 'redirect host is not an allowlisted host');
  }
  let next: string;
  try { next = new URL(location, current).href; } catch { throw plyError('bad_request', 'redirect host is not an allowlisted host'); }
  assertUpstreamUrl(next, repo, allowed);
}

type Vetted = { readonly ok: true; readonly value: URL } | { readonly ok: false; readonly error: PlyError };

/**
 * ply's `allowUrl` for the viewer's transport (followRedirects 'initial'). ply calls it with the repo URL before any
 * request, and with the Location of a 3xx on the first GET info/refs before rebasing there: that Location must still be
 * this repo's upload-pack endpoint on the same host (assertUpstreamUrl), e.g. `name` → `name.git`.
 */
export function viewerAllowUrl(repo: ValidatedPublicRepoUrl, allowed: readonly AllowedHost[]): (url: URL) => Vetted {
  return url => {
    const isBase = url.search === '' && !url.pathname.endsWith('/info/refs');
    const probe = isBase ? `${url.href.replace(/\/+$/, '')}/info/refs?service=git-upload-pack` : url.href;
    try { assertUpstreamUrl(probe, repo, allowed); } catch (e) { return { ok: false, error: e as PlyError }; }
    return { ok: true, value: url };
  };
}

/**
 * Every request must be this repo's smart-HTTP endpoint on an allowlisted host, and carries no credential. A 3xx is
 * never followed here: ply follows the first GET info/refs (git's http.followRedirects=initial, vetted by
 * viewerAllowUrl) and reports any other. A Location that leaves the repo is refused here, before ply sees it.
 */
export function createViewerFetch(inner: FetchLike, repo: ValidatedPublicRepoUrl, allowed: readonly AllowedHost[], budget: Budget, pageSignal: AbortSignal): FetchLike {
  const guarded: FetchLike = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const current = assertUpstreamUrl(raw, repo, allowed);
    const methodField = chainGet(init, 'method');
    const method = methodField.tag === 'none' ? 'GET' : methodField.value as string;
    const headerField = chainGet(init, 'headers');
    const headers = credentialFreeHeaders(headerField.tag === 'none' ? null : headerField.value as HeadersInit);
    const bodyField = chainGet(init, 'body');
    const initBody = bodyField.tag === 'none' ? null : bodyField.value;
    // The transport posts a Uint8Array (the viewer never pushes).
    if (initBody !== null && !(initBody instanceof Uint8Array)) throw plyError('bad_request', 'upstream body is not replayable');
    const signals: AbortSignal[] = [pageSignal];
    const signalField = chainGet(init, 'signal');
    if (signalField.tag === 'some' && signalField.value) signals.push(signalField.value as AbortSignal);
    budget.countSubrequest();
    const upstream: ViewerUpstreamInit = { credential: 'absent', method, headers, body: initBody, redirect: 'manual', signal: signals.length ? AbortSignal.any(signals) : null };
    if (upstream.credential !== 'absent') throw plyError('bad_request', 'credentialed upstream request');
    const requestInit: RequestInit = { method: upstream.method, headers: upstream.headers, redirect: 'manual' };
    if (upstream.body !== null) requestInit.body = upstream.body as BodyInit;
    if (upstream.signal !== null) requestInit.signal = upstream.signal;
    const res = await inner(current, requestInit);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      try {
        if (!location) throw plyError('http', 'redirect without location', { status: res.status });
        vetLocation(location, current, repo, allowed);
      } catch (e) {
        if (res.body) await res.body.cancel().catch(() => {});
        throw e;
      }
      return res;
    }
    return limitBody(res, budget);
  };
  return guarded;
}
