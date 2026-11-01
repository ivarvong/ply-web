// The only fetch the viewer uses. It cannot carry credentials: forbidden headers are dropped, the
// User-Agent is forced, redirects are manual and re-validated, and each hop must stay on the same
// git smart-HTTP endpoint. A Request with Authorization cannot be passed through this type.
import { fail } from 'ply';
import { atIndex, chainGet } from '../absent.ts';
import { unwrapOr } from '../option.ts';
import type { Budget } from './budget.ts';
import { VIEWER_CAPS, VIEWER_UA } from './limits.ts';
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

export function createViewerFetch(inner: FetchLike, repo: ValidatedPublicRepoUrl, allowed: readonly AllowedHost[], budget: Budget, pageSignal: AbortSignal): FetchLike {
  const guarded: FetchLike = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let current = assertUpstreamUrl(raw, repo, allowed);
    const methodField = chainGet(init, 'method');
    const method = methodField.tag === 'none' ? 'GET' : methodField.value as string;
    const headerField = chainGet(init, 'headers');
    const headers = credentialFreeHeaders(headerField.tag === 'none' ? null : headerField.value as HeadersInit);
    const bodyField = chainGet(init, 'body');
    const initBody = bodyField.tag === 'none' ? null : bodyField.value;
    // Only resend a body we can replay. The transport posts a Uint8Array.
    if (initBody !== null && !(initBody instanceof Uint8Array)) throw fail('bad_request', 'upstream body is not replayable');
    const signals: AbortSignal[] = [pageSignal];
    const signalField = chainGet(init, 'signal');
    if (signalField.tag === 'some' && signalField.value) signals.push(signalField.value as AbortSignal);
    for (let hop = 0; hop <= VIEWER_CAPS.maxRedirects; hop++) {
      budget.countSubrequest();
      const upstream: ViewerUpstreamInit = { credential: 'absent', method, headers, body: initBody, redirect: 'manual', signal: signals.length ? AbortSignal.any(signals) : null };
      if (upstream.credential !== 'absent') throw fail('bad_request', 'credentialed upstream request');
      const requestInit: RequestInit = { method: upstream.method, headers: upstream.headers, redirect: 'manual' };
      if (upstream.body !== null) requestInit.body = upstream.body as BodyInit;
      if (upstream.signal !== null) requestInit.signal = upstream.signal;
      const res = await inner(current, requestInit);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (res.body) await res.body.cancel().catch(() => {});
        if (!location) throw fail('http', 'redirect without location', { status: res.status });
        if (hop === VIEWER_CAPS.maxRedirects) throw fail('bad_request', 'too many redirects');
        // oxlint-disable-next-line no-control-regex -- controls in a Location are not a URL
        if (/[\u0000-\u001f\u007f]/.test(location) || location.includes('\\') || /%(2e|2f|5c)/i.test(location)) throw fail('bad_request', 'redirect host is not an allowlisted host');
        const locationPath = unwrapOr(atIndex(location.split(/[?#]/), 0), '');
        if (rawPathHasUnsafeSegment(locationPath.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(location) ? extractRequestPath(location.startsWith('/') ? `https://reject.invalid${locationPath}` : location) : locationPath)) {
          throw fail('bad_request', 'redirect host is not an allowlisted host');
        }
        const next = new URL(location, current).href;
        current = assertUpstreamUrl(next, repo, allowed);
        continue;
      }
      return limitBody(res, budget);
    }
    throw fail('bad_request', 'too many redirects');
  };
  return guarded;
}
