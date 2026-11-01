import { fail } from 'ply';
import { validatePath } from 'ply';
import { VIEWER_CAPS, VIEWER_GIT_LIMITS } from './limits.ts';
import type { FilterName } from './model.ts';
import { interpretRemote } from './paste.ts';
import { extractRequestPath, rawPathHasUnsafeSegment, rawQueryPathUnsafe } from '../pathguard.ts';
import { allowlistFromEnv, validatePublicRepoUrl, viewerPathFor, withHost, type AllowedHost, type RepoLocation } from './url.ts';
import { PUBLIC_GIT_HOST, PUBLIC_GIT_ORIGIN, PUBLIC_NAMESPACE, isPublicRepoName, publicRemote, publicRepoOfRemote, publicRepoShortName } from '../public.ts';

export type ViewerRoute =
  | { kind: 'css'; hash: string | null }
  | { kind: 'home' }
  | { kind: 'namespace' }
  | { kind: 'redirect'; location: string }
  | {
      kind: 'repo';
      loc: RepoLocation;
      ref: string | null;
      path: string;
      raw: boolean;
      pack: { want: string; filter: FilterName; offset: number | null } | null;
    };

export type RouteOpts = {
  allowedHosts: readonly AllowedHost[];
};

const SECRET_QUERY = /^(access_token|token|password|auth|authorization|git-token|git-authorization)$/i;
const OID = /^[0-9a-f]{40}$/;

function bad(message: string): never {
  throw fail('bad_request', message);
}

export function routeOptsFromEnv(env: { VIEWER_EXTRA_HOSTS?: string }): RouteOpts {
  return { allowedHosts: allowlistFromEnv(env.VIEWER_EXTRA_HOSTS) };
}

function chosenRef(url: URL, fallback: string | null = null): string | null {
  const at = url.searchParams.get('at')
  if (at !== null && at !== '') return parseRef(at)
  const commit = url.searchParams.get('commit')
  if (commit !== null && commit !== '') return parseRef(commit)
  const ref = url.searchParams.get('ref')
  if (ref !== null && ref !== '') return parseRef(ref)
  return fallback
}

/** `at` and `commit` are aliases of `ref`. A public-namespace page on the long host path canonicalises to `/r/<name>`. */
function canonicalLocation(url: URL, loc: RepoLocation, ref: string | null, path: string, raw: boolean, pack: Extract<ViewerRoute, { kind: 'repo' }>['pack']): string | null {
  const alias = url.searchParams.has('at') || url.searchParams.has('commit')
  const short = publicRepoShortName(loc.host, loc.repoPath)
  const onShort = short !== null && url.pathname === `/r/${encodeURIComponent(short)}`
  if (!alias && (short === null || onShort)) return null
  const query: Record<string, string | undefined> = {
    ref: ref ?? undefined,
    path: path || undefined,
    raw: raw ? '1' : undefined,
    trace: url.searchParams.get('trace') === '1' ? '1' : undefined,
    want: pack?.want,
    filter: pack ? pack.filter : undefined,
    offset: pack?.offset !== null && pack?.offset !== undefined ? String(pack.offset) : undefined,
  }
  return viewerPathFor(loc, query)
}

function parseRef(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  if (raw.length > 1024) bad('ref is too long');
  if (raw === 'HEAD') return 'HEAD';
  if (OID.test(raw)) return raw;
  if (raw.startsWith('refs/')) {
    // Control characters are rejected on purpose: a ref is a git name, not free text.
    // oxlint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f ~^:?*[\\]|\.\.|@\{|\/\/|\s/.test(raw)) bad('ref is not a valid name');
    return raw;
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(raw) || raw.includes('..') || raw.startsWith('/') || raw.endsWith('/') || raw.endsWith('.lock')) bad('ref is not a valid name');
  return raw;
}

function parsePath(raw: string | null): string {
  if (raw === null || raw === '') return '';
  const stripped = raw.replace(/^\/+|\/+$/g, '');
  if (!stripped) return '';
  if (stripped.length > 1024) bad('path is too long');
  validatePath(stripped, VIEWER_GIT_LIMITS);
  return stripped;
}

function parseFilter(raw: string | null, wantPresent: boolean): FilterName {
  if (raw === null || raw === '') return 'tree:0';
  if (raw === 'tree:0' || raw === 'blob:none') return raw;
  if (!wantPresent) bad('filter is only valid on a pack map');
  bad('filter must be tree:0 or blob:none');
}

/**
 * The Artifacts host of the public namespace is served without VIEWER_EXTRA_HOSTS, but only for one repo directly under
 * /git/<PUBLIC_NAMESPACE>/. Any other path on that host (another namespace, a nested path) is refused before a fetch.
 */
function validateLocation(raw: string, opts: RouteOpts): RepoLocation {
  if (raw.startsWith(`${PUBLIC_GIT_ORIGIN}/`)) {
    if (publicRepoOfRemote(raw) === null) bad(`only /git/${PUBLIC_NAMESPACE}/<repo> is served from ${PUBLIC_GIT_HOST}`);
    return validatePublicRepoUrl(raw, { allowedHosts: withHost(opts.allowedHosts, PUBLIC_GIT_HOST), maxLength: VIEWER_CAPS.maxUrlLength });
  }
  return validatePublicRepoUrl(raw, { allowedHosts: opts.allowedHosts, maxLength: VIEWER_CAPS.maxUrlLength });
}

function locate(host: string, repoPath: string, opts: RouteOpts): RepoLocation {
  // oxlint-disable-next-line no-control-regex -- hostnames cannot contain controls or whitespace
  if (!host || host.length > 253 || /[\u0000-\u001f\u007f\s/@\\]/.test(host)) bad(`remote host is not allowed. Supported hosts: ${opts.allowedHosts.join(', ')}.`);
  return validateLocation(`https://${host.toLowerCase()}/${repoPath}`, opts);
}

/** Parse a viewer URL from the raw request target, before `new URL` collapses dot segments. */
export function parseViewerRequest(raw: string, opts: RouteOpts): ViewerRoute {
  if (typeof raw !== 'string' || raw.length > VIEWER_CAPS.maxUrlLength * 2) bad('URL is too long');
  if (raw.includes('\\') || rawPathHasUnsafeSegment(extractRequestPath(raw)) || rawQueryPathUnsafe(raw)) bad('remote path is not allowed');
  let url: URL;
  try { url = new URL(raw); }
  catch { bad('remote path is not allowed'); }
  if (rawPathHasUnsafeSegment(url.pathname)) bad('remote path is not allowed');
  return parseViewerRoute(url, opts);
}

export function parseViewerRoute(url: URL, opts: RouteOpts): ViewerRoute {
  if (url.pathname.length > VIEWER_CAPS.maxUrlLength || url.href.length > VIEWER_CAPS.maxUrlLength * 2) bad('URL is too long');
  if (url.href.includes('\\') || rawPathHasUnsafeSegment(url.pathname) || rawQueryPathUnsafe(url.href)) bad('remote path is not allowed');
  for (const key of url.searchParams.keys()) if (SECRET_QUERY.test(key)) bad('query must not carry credentials');
  if (url.pathname === '/view.css') return { kind: 'css', hash: null };
  const hashed = /^\/view\.([0-9a-f]{12})\.css$/.exec(url.pathname);
  if (hashed?.[1]) return { kind: 'css', hash: hashed[1] };
  if (url.pathname === '/view' || url.pathname === '/view/') {
    const remote = url.searchParams.get('remote');
    if (!remote) return { kind: 'home' };
    const pasted = interpretRemote(remote);
    const loc = validateLocation(pasted.remote, opts);
    const ref = chosenRef(url, pasted.ref ?? null);
    return { kind: 'redirect', location: viewerPathFor(loc, { ref: ref ?? undefined, path: pasted.path || undefined }) };
  }
  if (url.pathname === '/r' || url.pathname === '/r/') return { kind: 'namespace' };
  let loc: RepoLocation;
  if (url.pathname.startsWith('/r/')) {
    const rest = url.pathname.slice('/r/'.length);
    let name: string;
    try { name = decodeURIComponent(rest); } catch { throw fail('not_found', `not a repository in ${PUBLIC_NAMESPACE}`, { miss: { kind: 'repository' } }); }
    if (name.includes('/') || !isPublicRepoName(name)) throw fail('not_found', `not a repository in ${PUBLIC_NAMESPACE}`, { miss: { kind: 'repository' } });
    loc = validateLocation(publicRemote(name), opts);
  } else {
    if (!url.pathname.startsWith('/view/')) bad('not a viewer route');
    let decoded: string;
    try { decoded = decodeURIComponent(url.pathname.slice('/view/'.length)); } catch { bad('remote path is not allowed'); }
    if (decoded.includes('%') || decoded.includes('\\') || decoded.includes('\0') || decoded.includes('..')) bad('remote path is not allowed');
    for (const segment of decoded.split('/')) {
      if (segment === '.' || segment === '..') bad('remote path is not allowed');
    }
    const parts = decoded.split('/').filter(part => part.length > 0);
    if (parts.length < 2) bad('remote path is not allowed');
    const host = parts[0] ?? '';
    const repoPath = parts.slice(1).join('/');
    loc = locate(host, repoPath, opts);
  }
  const wantRaw = url.searchParams.get('want');
  const filter = parseFilter(url.searchParams.get('filter'), wantRaw !== null);
  let pack: { want: string; filter: FilterName; offset: number | null } | null = null;
  if (wantRaw !== null) {
    if (!OID.test(wantRaw)) bad('want must be a 40-hex object id');
    const offsetRaw = url.searchParams.get('offset');
    let offset: number | null = null;
    if (offsetRaw !== null && offsetRaw !== '') {
      if (!/^\d+$/.test(offsetRaw)) bad('offset must be a byte offset');
      offset = Number(offsetRaw);
      if (offset > VIEWER_CAPS.maxPackBytes) bad('offset is past the pack cap');
    }
    pack = { want: wantRaw, filter, offset };
  } else if (url.searchParams.get('filter') || url.searchParams.get('offset')) bad('filter and offset need a want');
  const raw = url.searchParams.get('raw') === '1';
  if (raw && pack) bad('raw is a file view');
  const ref = chosenRef(url);
  const path = parsePath(url.searchParams.get('path'));
  const location = canonicalLocation(url, loc, ref, path, raw, pack);
  if (location) return { kind: 'redirect', location };
  return { kind: 'repo', loc, ref, path, raw, pack };
}
