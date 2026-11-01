// /v1 remote policy. decideRemote is the discriminated result. The fetch layer takes only an
// AllowedRemote, follows redirects manually, and re-runs the same policy on every hop.
import { fail } from 'ply';
import { atIndex, captureGroup, chainGet, recordGet } from './absent.ts';
import { unwrapOr } from './option.ts';
import { extractRequestPath, rawPathHasUnsafeSegment } from './pathguard.ts';

const allowedRemoteBrand: unique symbol = Symbol('AllowedRemote');

export type AllowedRemote = {
  readonly [allowedRemoteBrand]: 'AllowedRemote';
  readonly href: string;
  readonly origin: string;
  readonly hostname: string;
  readonly host: string;
};

export type Rejected = { readonly kind: 'rejected'; readonly reason: RemoteReason };
export type Allowed = { readonly kind: 'allowed'; readonly remote: AllowedRemote };
export type RemoteDecision = Allowed | Rejected;

export type RemoteReason =
  | 'empty'
  | 'too_long'
  | 'not_url'
  | 'userinfo'
  | 'query'
  | 'fragment'
  | 'trailing_dot'
  | 'scheme'
  | 'port'
  | 'ip_literal'
  | 'wildcard_dns'
  | 'private_name'
  | 'single_label'
  | 'bad_path'
  | 'control';

const MAX_REMOTE = 2048;

/** Wildcard-DNS names that answer with an address encoded in the label (or with 127.0.0.1 for the whole zone). */
const WILDCARD_DNS = Object.freeze([
  'nip.io',
  'sslip.io',
  'xip.io',
  'localtest.me',
  'lvh.me',
  'vcap.me',
  'lacolhost.com',
  'localho.st',
  'traefik.me',
]);

const PRIVATE_SUFFIX = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa|corp|private)$/i;

const REASON_TEXT: Record<RemoteReason, string> = {
  empty: 'remote is required',
  too_long: 'remote too long',
  not_url: 'remote is not a URL',
  userinfo: 'remote must not carry credentials; use Git-Authorization or Git-Token',
  query: 'remote must not have a query or fragment',
  fragment: 'remote must not have a query or fragment',
  trailing_dot: 'remote host is not a public name',
  scheme: 'remote must be https',
  port: 'remote must use the default port',
  ip_literal: 'remote must be a host name, not an IP address',
  wildcard_dns: 'remote host is not a public name',
  private_name: 'remote host is not a public name',
  single_label: 'remote host is not a public name',
  bad_path: 'remote is not a URL',
  control: 'remote is not a URL',
};

export type FetchLike = typeof globalThis.fetch;

function rejected(reason: RemoteReason): Rejected {
  return { kind: 'rejected', reason };
}

function brand(href: string, origin: string, hostname: string, host: string): AllowedRemote {
  return { [allowedRemoteBrand]: 'AllowedRemote', href, origin, hostname, host };
}

export function isAllowedRemote(value: unknown): value is AllowedRemote {
  return !!value && typeof value === 'object' && (value as AllowedRemote)[allowedRemoteBrand] === 'AllowedRemote';
}

/** True when the raw authority's host ends in `.`, even if a URL parser would keep or drop that dot. */
export function authorityHasTrailingDot(raw: string): boolean {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw.trim());
  const found = captureGroup(match, 1);
  if (found.tag === 'none' || !found.value) return false;
  let authority = found.value;
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end >= 0 && authority.slice(end + 1).startsWith('.');
  }
  const colon = authority.lastIndexOf(':');
  if (colon >= 0 && /^\d+$/.test(authority.slice(colon + 1))) authority = authority.slice(0, colon);
  return authority.endsWith('.');
}

function rawAuthorityHost(raw: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw.trim());
  const found = captureGroup(match, 1);
  if (found.tag === 'none' || !found.value) return '';
  let authority = found.value;
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end >= 0 ? authority.slice(1, end) : authority;
  }
  const colon = authority.lastIndexOf(':');
  if (colon >= 0 && /^\d+$/.test(authority.slice(colon + 1))) return authority.slice(0, colon);
  return authority;
}

/** Decimal, octal, hex, dotted-quad, and IPv6 textual forms, before the URL parser rewrites them. */
export function rawHostIsIpEncoding(host: string): boolean {
  const bare = host.trim().replace(/^\[|\]$/g, '');
  if (!bare) return false;
  if (bare.includes(':')) return true;
  if (/^0x[0-9a-f]+$/i.test(bare)) return true;
  if (/^\d+$/.test(bare)) return true;
  if (/^(\d+|0x[0-9a-f]+)(\.(\d+|0x[0-9a-f]+)){1,3}$/i.test(bare)) return true;
  return false;
}

export function isIpHostname(hostname: string): boolean {
  if (hostname.startsWith('[') || hostname.includes(':')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  // 127.0.0.1.nip.io and 10.0.0.1.example.com both encode an address in the name.
  return /(^|\.)(\d{1,3}\.){3}\d{1,3}(\.|$)/.test(hostname);
}

export function isWildcardDns(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const suffix of WILDCARD_DNS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

export function isPrivateName(hostname: string): boolean {
  return PRIVATE_SUFFIX.test(hostname.toLowerCase().replace(/\.$/, ''));
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export type DecideOpts = Partial<{ allowQuery: boolean; maxLength: number }>;

/**
 * Strict parse of a caller-supplied remote. `allow` is an origin list (tests, ALLOW_REMOTE_ORIGINS)
 * that may use http, an IP, and a non-default port. Everything else must be https on the default
 * port, with a public DNS name: no IP literal in any encoding, no wildcard-DNS suffix, no trailing dot.
 */
export function decideRemote(raw: string, allow: readonly string[] = [], opts: DecideOpts = {}): RemoteDecision {
  const maxField = chainGet(opts, 'maxLength');
  const maxLength = maxField.tag === 'none' ? MAX_REMOTE : maxField.value as number;
  if (typeof raw !== 'string' || !raw.trim()) return rejected('empty');
  if (raw.length > maxLength) return rejected('too_long');
  // oxlint-disable-next-line no-control-regex -- a remote with controls is not a URL
  if (/[\u0000-\u001f\u007f\s]/.test(raw) || raw.includes('\\')) return rejected('control');
  if (authorityHasTrailingDot(raw)) return rejected('trailing_dot');
  const path = extractRequestPath(raw);
  if (rawPathHasUnsafeSegment(path)) return rejected('bad_path');
  const rawHost = rawAuthorityHost(raw);
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { return rejected('not_url'); }
  if (parsed.username || parsed.password) return rejected('userinfo');
  if (parsed.hash) return rejected('fragment');
  if (!opts.allowQuery && parsed.search) return rejected('query');
  if (parsed.hostname.endsWith('.') || authorityHasTrailingDot(parsed.href)) return rejected('trailing_dot');
  const hostname = parsed.hostname.toLowerCase();
  const origin = parsed.origin;
  // An allowlisted origin may be http, an IP, and a non-default port. The exemption is the
  // canonical origin, so a decimal or hex spelling of that same host is still an IP literal
  // unless the parsed origin itself is listed.
  if (!allow.includes(origin)) {
    if (parsed.protocol !== 'https:') return rejected('scheme');
    if (parsed.port !== '') return rejected('port');
    if (isIpHostname(hostname) || rawHostIsIpEncoding(rawHost) || rawHostIsIpEncoding(hostname)) return rejected('ip_literal');
    if (isWildcardDns(hostname)) return rejected('wildcard_dns');
    if (!hostname.includes('.')) return rejected('single_label');
    if (isPrivateName(hostname)) return rejected('private_name');
  }
  const href = `${origin}${parsed.pathname}${opts.allowQuery ? parsed.search : ''}`;
  return { kind: 'allowed', remote: brand(href, origin, hostname, parsed.host) };
}

export function reasonText(reason: RemoteReason): string {
  return REASON_TEXT[reason];
}

/** Throw the /v1 bad_request the worker already returns. The value is an AllowedRemote. */
export function checkRemote(raw: string, allow: readonly string[] = []): AllowedRemote {
  const decision = decideRemote(raw, allow);
  if (decision.kind === 'rejected') throw fail('bad_request', reasonText(decision.reason));
  return decision.remote;
}

function authorizeHop(raw: string, home: AllowedRemote, allow: readonly string[]): AllowedRemote {
  const decision = decideRemote(raw, allow, { allowQuery: true });
  if (decision.kind === 'rejected') throw fail('bad_request', reasonText(decision.reason));
  if (decision.remote.origin !== home.origin) throw fail('bad_request', 'redirect host is not an allowlisted host');
  return decision.remote;
}

function rejectRedirectLocation(location: string): boolean {
  if (!location || location.length > MAX_REMOTE) return true;
  // oxlint-disable-next-line no-control-regex -- a redirect with controls is not followed
  if (/[\u0000-\u001f\u007f]/.test(location) || location.includes('\\') || /%(2e|2f|5c)/i.test(location)) return true;
  const path = unwrapOr(atIndex(location.split(/[?#]/), 0), '');
  return rawPathHasUnsafeSegment(path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(location) ? extractRequestPath(location.startsWith('/') ? `https://reject.invalid${path}` : location) : path);
}

/**
 * Fetch wrapper ply calls. `remote` is the branded result of decideRemote. Each request and each
 * redirect hop is parsed again; a hop whose origin is not that remote is not followed.
 */
export function createGuardedFetch(inner: FetchLike, remote: AllowedRemote, allow: readonly string[] = [], maxRedirects = 3): FetchLike {
  if (!isAllowedRemote(remote)) throw fail('bad_request', 'remote was not allowlisted');
  const guarded: FetchLike = async (input, init) => {
    let current = authorizeHop(requestUrl(input), remote, allow);
    const methodField = chainGet(init, 'method');
    const method = methodField.tag === 'none' ? 'GET' : methodField.value as string;
    const bodyField = chainGet(init, 'body');
    const body = bodyField.tag === 'none' ? null : bodyField.value;
    if (body !== null && !(body instanceof Uint8Array)) throw fail('bad_request', 'upstream body is not replayable');
    const initRecord = init !== null && typeof init === 'object' ? init as Record<string, unknown> : null;
    const headerField = recordGet(initRecord, 'headers');
    const signalField = chainGet(init, 'signal');
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const requestInit: RequestInit = { method, redirect: 'manual' };
      if (headerField.tag === 'some') requestInit.headers = headerField.value as HeadersInit;
      if (body !== null) requestInit.body = body as BodyInit;
      if (signalField.tag === 'some') requestInit.signal = signalField.value as AbortSignal;
      const res = await inner(current.href, requestInit);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (res.body) await res.body.cancel().catch(() => {});
        if (!location || rejectRedirectLocation(location)) throw fail('bad_request', 'redirect host is not an allowlisted host');
        if (hop === maxRedirects) throw fail('bad_request', 'too many redirects');
        let next: string;
        try { next = new URL(location, current.href).href; }
        catch { throw fail('bad_request', 'redirect host is not an allowlisted host'); }
        current = authorizeHop(next, remote, allow);
        continue;
      }
      return res;
    }
    throw fail('bad_request', 'too many redirects');
  };
  return guarded;
}
