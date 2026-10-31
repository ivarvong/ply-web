// The public namespace: one Cloudflare Artifacts namespace this Worker serves read-only, with no PLY_TOKEN and no caller
// credential. The Worker holds no stored secret for it. It mints a short-lived read token per repo through the
// namespace-scoped Artifacts binding (PUBLIC_REPOS, declared in cloudflare.config.ts with the same PUBLIC_NAMESPACE),
// caches it per isolate until near expiry, and attaches it only to an upload-pack request whose URL is exactly
// `${PUBLIC_GIT_ORIGIN}/git/${PUBLIC_NAMESPACE}/<repo>(.git)/info/refs?service=git-upload-pack` or `…/git-upload-pack`.
// That check runs on the raw URL of every request ply makes and of every redirect hop, because the attaching fetch sits
// below the redirect-following guards (createGuardedFetch, createViewerFetch) and each hop calls it again.
import { fail } from 'ply';
import { extractRequestPath, rawPathHasUnsafeSegment } from './pathguard.ts';

import { PUBLIC_NAMESPACE } from './public-namespace.ts';

export { PUBLIC_NAMESPACE };

/** The account's Artifacts git host (account 5ad2236b…, the account that owns the `ply` Worker). */
export const PUBLIC_GIT_HOST = '5ad2236b39de4c8bd8f6270ea63f3ea9.artifacts.cloudflare.net';
export const PUBLIC_GIT_ORIGIN = `https://${PUBLIC_GIT_HOST}`;

/** Read-token lifetime asked of Artifacts, and how long before expiry the Worker stops using a cached token. */
export const READ_TOKEN_TTL_S = 3600;
export const READ_TOKEN_REFRESH_S = 300;
const MAX_CACHED_TOKENS = 64;
const MS_PER_SECOND = 1000;

// Artifacts names: start with a letter or digit, then letters, digits, `.`, `_`, `-` (developers.cloudflare.com/artifacts/platform/limits).
// `..` and a trailing `.git` are refused here so the name and its `.git` URL form are one-to-one.
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isPublicRepoName(name: string): boolean {
  return typeof name === 'string' && REPO_NAME.test(name) && !name.includes('..') && !/\.git$/i.test(name);
}

const GIT_SUFFIX = '.git';

/**
 * The public-namespace repo name when `host` + `repoPath` is exactly one repo under PUBLIC_NAMESPACE.
 * That name is the short viewer URL `/r/<name>`.
 */
export function publicRepoShortName(host: string, repoPath: string): string | null {
  if (host !== PUBLIC_GIT_HOST) return null;
  const prefix = `git/${PUBLIC_NAMESPACE}/`;
  if (!repoPath.startsWith(prefix) || !repoPath.endsWith(GIT_SUFFIX)) return null;
  const name = repoPath.slice(prefix.length, -GIT_SUFFIX.length);
  return isPublicRepoName(name) ? name : null;
}

export type RepoPresence = true | false | 'unknown';

/** True when the namespace binding has the repo. `unknown` when the binding is missing or errors for another reason. */
export async function publicRepoExists(binding: ArtifactsNamespace | undefined | null, name: string): Promise<RepoPresence> {
  if (!isPublicRepoName(name)) return false;
  if (!binding || typeof binding.get !== 'function') return 'unknown';
  try {
    const handle = await binding.get(name);
    try { handle[Symbol.dispose]?.(); } catch { /* releasing the RPC stub is best effort */ }
    return true;
  } catch (e) {
    if (/not.?found|does not exist|no such/i.test(String((e as { message?: string })?.message ?? e))) return false;
    return 'unknown';
  }
}

/** The canonical remote for a repo in the public namespace. */
export function publicRemote(name: string, origin: string = PUBLIC_GIT_ORIGIN): string {
  if (!isPublicRepoName(name)) throw fail('bad_request', 'not a public repository name');
  return `${origin}/git/${PUBLIC_NAMESPACE}/${name}.git`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NS = escapeRegExp(PUBLIC_NAMESPACE);
const REPO_PATH = new RegExp(`^/git/${NS}/([^/]+?)(?:\\.git)?$`);
const ENDPOINT_PATH = new RegExp(`^/git/${NS}/([^/]+?)(?:\\.git)?/(info/refs|git-upload-pack)$`);

/** The repo name when `raw` is exactly a public-namespace repo URL on `origin` (no trailing endpoint). */
export function publicRepoOfRemote(raw: string, origin: string = PUBLIC_GIT_ORIGIN): string | null {
  const path = cleanPath(raw, origin);
  if (path === null) return null;
  const m = REPO_PATH.exec(path);
  return m?.[1] && isPublicRepoName(m[1]) ? m[1] : null;
}

/**
 * True when `raw` names any repo under the public namespace on `origin`, compared case-insensitively. Used only to
 * refuse writes, so a case or `.git` variant that Artifacts might also resolve is refused, never allowed.
 */
export function isPublicNamespaceRemote(raw: string, origin: string = PUBLIC_GIT_ORIGIN): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.origin.toLowerCase() !== origin.toLowerCase()) return false;
  return u.pathname.toLowerCase().startsWith(`/git/${PUBLIC_NAMESPACE.toLowerCase()}/`);
}

// The raw path of `raw` when its origin is exactly `origin`, with no userinfo, fragment, or unsafe segment. The raw
// string is checked before the URL parser folds `.`, `..`, or encoded separators away.
function cleanPath(raw: string, origin: string): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  // oxlint-disable-next-line no-control-regex -- a URL with controls is not one we attach a credential to
  if (/[\u0000-\u001f\u007f\s\\#]/.test(raw)) return null;
  const rawPath = extractRequestPath(raw);
  if (/[%@]/.test(rawPath)) return null;
  if (rawPathHasUnsafeSegment(rawPath)) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.hash) return null;
  if (u.origin !== origin) return null;
  // The raw string's own origin must be the canonical one too: no `HTTPS://`, no `:443`, no trailing dot.
  if (!raw.startsWith(`${origin}/`)) return null;
  if (u.pathname !== rawPath) return null;
  return u.pathname;
}

/**
 * The repo name when (`method`, `raw`) is a git upload-pack exchange for a public repo: `GET …/info/refs` with exactly
 * `?service=git-upload-pack`, or `POST …/git-upload-pack` with no query. Anything else, receive-pack included, is null.
 */
export function publicUploadPackRepo(method: string, raw: string, origin: string = PUBLIC_GIT_ORIGIN): string | null {
  const path = cleanPath(raw, origin);
  if (path === null) return null;
  const m = ENDPOINT_PATH.exec(path);
  if (!m?.[1] || !isPublicRepoName(m[1])) return null;
  const query = raw.slice(origin.length + path.length);
  const verb = method.toUpperCase();
  if (m[2] === 'info/refs') return verb === 'GET' && query === '?service=git-upload-pack' ? m[1] : null;
  return verb === 'POST' && query === '' ? m[1] : null;
}

/** The subset of the Artifacts Workers binding this module uses. */
export type ArtifactsNamespace = {
  get(name: string): Promise<{ createToken(scope: 'read' | 'write', ttl: number): Promise<{ plaintext: string; expiresAt?: string | number | Date }> } & Partial<Disposable>>;
  list?(opts?: { limit?: number }): Promise<{ repos: { name: string; status?: string }[] }>;
};

type Cached = { token: string; expiresAtMs: number };

export type TokenSource = {
  /** A read token for `repo` that has more than READ_TOKEN_REFRESH_S left. */
  readToken(repo: string): Promise<string>;
  /** Every token this isolate has minted and not yet dropped, with each string form that could be echoed. */
  secrets(): string[];
};

function expiryMs(expiresAt: unknown, token: string, now: number): number {
  if (expiresAt instanceof Date) return expiresAt.getTime();
  if (typeof expiresAt === 'number') return expiresAt < 1e12 ? expiresAt * MS_PER_SECOND : expiresAt;
  if (typeof expiresAt === 'string' && !Number.isNaN(Date.parse(expiresAt))) return Date.parse(expiresAt);
  // Token format: art_v1_<40 hex>?expires=<unix seconds> (developers.cloudflare.com/artifacts/api/git-protocol).
  const m = /[?&]expires=(\d+)/.exec(token);
  return m?.[1] ? Number(m[1]) * MS_PER_SECOND : now + READ_TOKEN_TTL_S * MS_PER_SECOND;
}

/**
 * Per-isolate read tokens, minted through the namespace-scoped binding. Concurrent requests for one repo share one
 * mint. Only `createToken('read', …)` is ever called.
 */
export function createTokenSource(binding: ArtifactsNamespace, now: () => number = Date.now): TokenSource {
  const cache = new Map<string, Cached>();
  const pending = new Map<string, Promise<string>>();
  const retired: string[] = [];
  const mint = async (repo: string): Promise<string> => {
    const handle = await binding.get(repo);
    try {
      const minted = await handle.createToken('read', READ_TOKEN_TTL_S);
      const token = String(minted?.plaintext ?? '');
      if (token.length < 8) throw fail('upstream_5xx', 'the public namespace did not return a read token');
      const old = cache.get(repo);
      if (old) retired.push(old.token);
      if (retired.length > MAX_CACHED_TOKENS) retired.splice(0, retired.length - MAX_CACHED_TOKENS);
      if (cache.size >= MAX_CACHED_TOKENS && !cache.has(repo)) {
        const first = cache.keys().next().value;
        if (first !== undefined) { retired.push(cache.get(first)?.token ?? ''); cache.delete(first); }
      }
      cache.set(repo, { token, expiresAtMs: expiryMs(minted?.expiresAt, token, now()) });
      return token;
    } finally {
      try { handle[Symbol.dispose]?.(); } catch { /* releasing the RPC stub is best effort */ }
    }
  };
  return {
    async readToken(repo) {
      if (!isPublicRepoName(repo)) throw fail('bad_request', 'not a public repository name');
      const hit = cache.get(repo);
      if (hit && hit.expiresAtMs - now() > READ_TOKEN_REFRESH_S * MS_PER_SECOND) return hit.token;
      let p = pending.get(repo);
      if (!p) {
        p = mint(repo).finally(() => pending.delete(repo));
        pending.set(repo, p);
      }
      try { return await p; }
      catch (e) {
        if ((e as { code?: string })?.code === 'upstream_5xx') throw e;
        // binding.get throws when the repo does not exist (developers.cloudflare.com/artifacts/api/workers-binding/#getname).
        if (/not.?found|does not exist|no such/i.test(String((e as { message?: string })?.message ?? e))) throw fail('not_found', `no repository ${repo} in the public namespace`);
        throw fail('upstream_5xx', 'could not mint a read token for the public namespace');
      }
    },
    secrets() {
      const out: string[] = [];
      for (const t of [...[...cache.values()].map(c => c.token), ...retired]) {
        if (!t) continue;
        const bare = t.split('?')[0] ?? t;
        out.push(t, bare, btoa(`x-access-token:${t}`), btoa(`x-access-token:${bare}`), encodeURIComponent(t));
      }
      return out;
    },
  };
}

// One token source per binding object, so an isolate shares its cached tokens across requests.
const SOURCES = new WeakMap<object, TokenSource>();

export function tokenSourceFor(binding: ArtifactsNamespace | undefined | null): TokenSource | null {
  if (!binding || typeof binding !== 'object' || typeof binding.get !== 'function') return null;
  let source = SOURCES.get(binding);
  if (!source) { source = createTokenSource(binding); SOURCES.set(binding, source); }
  return source;
}

const LIST_TTL_MS = 60_000;
const LIST_LIMIT = 100;
let listed: { at: number; names: string[] } | null = null;

/** Names from `binding.list()`. `/view` and `/r/` both render this value. */
export type PublicRepoList = {
  names: readonly string[];
  /** True only when `list()` threw and this isolate has no cached page to show. */
  unavailable: boolean;
};

export const EMPTY_PUBLIC_REPOS: PublicRepoList = { names: [], unavailable: false };

/**
 * Repo names in the public namespace, cached for a minute per isolate.
 * A missing binding or an empty namespace is an empty list, not a failure.
 * `unavailable` is set only when the upstream `list()` call throws and nothing is cached.
 */
export async function listPublicRepos(binding: ArtifactsNamespace | undefined | null, now: number = Date.now()): Promise<PublicRepoList> {
  if (!binding || typeof binding.list !== 'function') return EMPTY_PUBLIC_REPOS;
  if (listed && now - listed.at < LIST_TTL_MS) return { names: listed.names, unavailable: false };
  try {
    const page = await binding.list({ limit: LIST_LIMIT });
    const names = (page?.repos ?? []).filter(r => !r.status || r.status === 'ready').map(r => String(r.name)).filter(isPublicRepoName).sort();
    listed = { at: now, names };
    return { names, unavailable: false };
  } catch {
    if (listed) return { names: listed.names, unavailable: false };
    return { names: [], unavailable: true };
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * The innermost fetch. When the request is a public upload-pack exchange (`publicUploadPackRepo`) and carries no
 * Authorization of its own, it gets `Authorization: Bearer <read token>`. Every other request passes through unchanged.
 * A caller's own credential always wins: the Worker's token is never added next to it or in place of it.
 */
export function withPublicReadCredential(inner: FetchLike, tokens: TokenSource | null, origin: string = PUBLIC_GIT_ORIGIN): FetchLike {
  return async (input, init) => {
    if (!tokens) return inner(input, init);
    const url = requestUrl(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const repo = publicUploadPackRepo(method, url, origin);
    if (repo === null) return inner(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has('authorization')) return inner(input, init);
    headers.set('authorization', `Bearer ${await tokens.readToken(repo)}`);
    return inner(url, { ...init, method, headers });
  };
}

/** Removes every string form of every minted token from `text`. */
export function scrubSecrets(secrets: readonly string[]): (text: string) => string {
  const list = [...new Set(secrets.filter(s => typeof s === 'string' && s.length >= 8))].sort((a, b) => b.length - a.length);
  return text => list.reduce((s, x) => s.split(x).join('[redacted]'), String(text));
}
