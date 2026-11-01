// Mirrors in the public namespace follow their GitHub branch: a Worker cron (cloudflare.config.ts, every minute) compares
// the source ref with the mirror's ref and, when they differ, fetches only the new objects from the source
// (`want <source tip>`, `have <mirror tip>`) and pushes them to the mirror as a CAS update from the mirror's tip.
//
// Credentials: the source is read anonymously. The mirror is read with the binding's read token and written with a
// write token minted through the same namespace-scoped binding for that one repo, with the minimum TTL (60 s), and
// revoked as soon as the push returns. Nothing long-lived, nothing in CI. The token is never logged: the log line
// carries oids, counts and timings only.
//
// Scope: a fixed list (MIRRORS). A source that rewrote history is followed too (Artifacts accepts a non-fast-forward
// update with the right old oid). An update larger than MAX_SYNC_PACK is refused and logged; publish it with
// scripts/publish.mjs, which chunks.
import { chainGet, fromNullable, mapGet } from './absent.ts';
import { PUBLIC_GIT_ORIGIN, publicRemote, type ArtifactsNamespace, type FetchLike, type TokenSource } from './public.ts';
import { checkRemote, createGuardedFetch } from './remote.ts';
import { Tracer, ZERO_OID, arrayExporter, createTransport, fetchPack, lsRefs, push, withLimits } from 'ply';
import type { Transport } from 'ply/transport';

export type Mirror = { repo: string; source: string; branch: string };

export const MIRRORS: readonly Mirror[] = Object.freeze([
  { repo: 'ply', source: 'https://github.com/ivarvong/ply.git', branch: 'main' },
  { repo: 'ply-web', source: 'https://github.com/ivarvong/ply-web.git', branch: 'main' },
]);

const MIB = 1024 * 1024;
export const MAX_SYNC_PACK = 32 * MIB;
const LIMITS = withLimits({ maxPackBytes: MAX_SYNC_PACK, maxObjectSize: 16 * MIB, maxInflatedTotal: 96 * MIB, maxHarvestBytes: 16 * MIB, maxPackObjects: 50_000, requestTimeoutMs: 30_000 });
export const WRITE_TTL_S = 60;

export type SyncResult = {
  repo: string;
  outcome: 'in-sync' | 'updated' | 'error';
  from: string | null;
  to: string | null;
  objects: number | null;
  pushBytes: number | null;
  ms: number;
  code: string | null;
  message: string | null;
};

export type SyncDeps = {
  binding: ArtifactsNamespace;
  tokens: TokenSource;
  fetchImpl: FetchLike | null;
  origin: string | null;
};

function tracer() {
  return new Tracer({ exporter: arrayExporter(), resource: { 'service.name': 'ply-mirror' } });
}

const defaultFetch: FetchLike = (input, init) => {
  const given = fromNullable(init);
  if (given.tag === 'none') return fetch(input);
  return fetch(input, given.value);
};

function releaseStub(handle: unknown): void {
  const dispose = (handle as Partial<Disposable>)[Symbol.dispose];
  const present = fromNullable(dispose);
  if (present.tag === 'none') return;
  const fn = present.value as (this: unknown) => void;
  fn.call(handle);
}

async function tip(t: Transport, branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const { refs } = await lsRefs(t, [ref]);
  const row = mapGet(refs, ref);
  if (row.tag === 'none') return null;
  return row.value.oid;
}

function resolvedOrigin(deps: SyncDeps): string {
  const origin = chainGet(deps, 'origin');
  return origin.tag === 'some' && typeof origin.value === 'string' ? origin.value : PUBLIC_GIT_ORIGIN;
}

function allowOrigin(deps: SyncDeps): string[] {
  const origin = chainGet(deps, 'origin');
  if (origin.tag === 'none' || typeof origin.value !== 'string' || origin.value === '') return [];
  return [origin.value];
}

function resolvedFetch(deps: SyncDeps): FetchLike {
  const fetchImpl = chainGet(deps, 'fetchImpl');
  if (fetchImpl.tag === 'some' && typeof fetchImpl.value === 'function') return fetchImpl.value as FetchLike;
  return defaultFetch;
}

export async function syncMirror(m: Mirror, deps: SyncDeps): Promise<SyncResult> {
  const t0 = Date.now();
  const raw = resolvedFetch(deps);
  const origin = resolvedOrigin(deps);
  const allow = allowOrigin(deps);
  const mirrorUrl = publicRemote(m.repo, origin);
  const blank = { from: null, to: null, objects: null, pushBytes: null, code: null, message: null };
  try {
    const src = checkRemote(m.source);
    const srcT = createTransport(src.href, { tracer: tracer(), limits: LIMITS, quirks: {}, fetchImpl: createGuardedFetch(raw, src) });
    const dst = checkRemote(mirrorUrl, allow);
    const read = await deps.tokens.readToken(m.repo);
    const dstT = createTransport(dst.href, { tracer: tracer(), limits: LIMITS, quirks: {}, auth: { bearer: read }, fetchImpl: createGuardedFetch(raw, dst, allow) });
    const [want, have] = await Promise.all([tip(srcT, m.branch), tip(dstT, m.branch)]);
    if (!want) return { repo: m.repo, outcome: 'error', ...blank, code: 'not_found', message: `source has no ${m.branch}`, ms: Date.now() - t0 };
    if (want === have) return { repo: m.repo, outcome: 'in-sync', ...blank, from: have, to: want, ms: Date.now() - t0 };
    const r = await fetchPack(srcT, { wants: [want], haves: have ? [have] : [], ofsDelta: true, thinPack: false, done: true }, { resolve: true });
    const objects = r.objects ? [...r.objects.values()] : [];
    const handle = await deps.binding.get(m.repo);
    let writeToken = '';
    try {
      const minted = await (handle as unknown as { createToken(scope: 'write', ttl: number): Promise<{ plaintext: string }> }).createToken('write', WRITE_TTL_S);
      const plain = chainGet(minted, 'plaintext');
      writeToken = plain.tag === 'some' ? String(plain.value) : '';
      if (!writeToken) throw Object.assign(new Error('no write token'), { code: 'upstream_5xx' });
      const dstW = createTransport(dst.href, { tracer: tracer(), limits: LIMITS, quirks: {}, auth: { bearer: writeToken }, fetchImpl: createGuardedFetch(raw, dst, allow) });
      const pushed = await push(dstW, { ref: `refs/heads/${m.branch}`, oldOid: have === null ? ZERO_OID : have, newOid: want, objects });
      const bytes = chainGet(pushed, 'packBytes');
      const pushBytes = bytes.tag === 'some' && typeof bytes.value === 'number' ? bytes.value : 0;
      return { repo: m.repo, outcome: 'updated', ...blank, from: have, to: want, objects: objects.length, pushBytes, ms: Date.now() - t0 };
    } finally {
      const revoke = chainGet(handle, 'revokeToken');
      if (writeToken && revoke.tag === 'some' && typeof revoke.value === 'function') {
        try { await (revoke.value as (token: string) => Promise<unknown>).call(handle, writeToken); } catch { /* it expires in WRITE_TTL_S */ }
      }
      try { releaseStub(handle); } catch { /* best effort */ }
    }
  } catch (e) {
    const codeField = chainGet(e, 'code');
    const messageField = chainGet(e, 'message');
    const code = codeField.tag === 'some' && typeof codeField.value === 'string' ? codeField.value : 'internal';
    const message = String(messageField.tag === 'some' ? messageField.value : e).replace(/art_v1_[0-9a-f]+(\?expires=\d+)?/g, '[redacted]').slice(0, 300);
    return { repo: m.repo, outcome: 'error', ...blank, code, message, ms: Date.now() - t0 };
  }
}

export async function syncAll(deps: SyncDeps, mirrors: readonly Mirror[] = MIRRORS): Promise<SyncResult[]> {
  return Promise.all(mirrors.map(m => syncMirror(m, deps)));
}
