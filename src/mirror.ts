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
import { Tracer, ZERO_OID, arrayExporter, createTransport, fetchPack, lsRefs, push, withLimits } from 'ply';
import { checkRemote, createGuardedFetch } from './remote.ts';
import { PUBLIC_GIT_ORIGIN, publicRemote, type ArtifactsNamespace, type TokenSource } from './public.ts';

export type Mirror = { repo: string; source: string; branch: string };

export const MIRRORS: readonly Mirror[] = Object.freeze([
  { repo: 'ply', source: 'https://github.com/ivarvong/ply.git', branch: 'main' },
  { repo: 'ply-web', source: 'https://github.com/ivarvong/ply-web.git', branch: 'main' },
]);

const MIB = 1024 * 1024;
export const MAX_SYNC_PACK = 32 * MIB;
const LIMITS = withLimits({ maxPackBytes: MAX_SYNC_PACK, maxObjectSize: 16 * MIB, maxInflatedTotal: 96 * MIB, maxHarvestBytes: 16 * MIB, maxPackObjects: 50_000, requestTimeoutMs: 30_000 });
export const WRITE_TTL_S = 60;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type SyncResult = {
  repo: string; outcome: 'in-sync' | 'updated' | 'error'; from?: string | null; to?: string | null; objects?: number;
  pushBytes?: number; ms: number; code?: string; message?: string;
};

function tracer() {
  return new Tracer({ exporter: arrayExporter(), resource: { 'service.name': 'ply-mirror' } });
}

async function tip(t: unknown, branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const { refs } = await lsRefs(t, [ref]);
  return refs.get(ref)?.oid ?? null;
}

export async function syncMirror(m: Mirror, deps: { binding: ArtifactsNamespace; tokens: TokenSource; fetchImpl?: FetchLike; origin?: string }): Promise<SyncResult> {
  const t0 = Date.now();
  const raw = deps.fetchImpl ?? ((i: RequestInfo | URL, n?: RequestInit) => fetch(i, n));
  const origin = deps.origin ?? PUBLIC_GIT_ORIGIN;
  const mirrorUrl = publicRemote(m.repo, origin);
  try {
    const src = checkRemote(m.source);
    const srcT = createTransport(src.href, { tracer: tracer(), limits: LIMITS, quirks: {}, fetchImpl: createGuardedFetch(raw, src) });
    const dst = checkRemote(mirrorUrl, deps.origin ? [deps.origin] : []);
    const read = await deps.tokens.readToken(m.repo);
    const dstT = createTransport(dst.href, { tracer: tracer(), limits: LIMITS, quirks: {}, auth: { bearer: read }, fetchImpl: createGuardedFetch(raw, dst, deps.origin ? [deps.origin] : []) });
    const [want, have] = await Promise.all([tip(srcT, m.branch), tip(dstT, m.branch)]);
    if (!want) return { repo: m.repo, outcome: 'error', code: 'not_found', message: `source has no ${m.branch}`, ms: Date.now() - t0 };
    if (want === have) return { repo: m.repo, outcome: 'in-sync', from: have, to: want, ms: Date.now() - t0 };
    const r = await fetchPack(srcT, { wants: [want], haves: have ? [have] : [], ofsDelta: true, thinPack: false, done: true }, { resolve: true });
    const objects = r.objects ? [...r.objects.values()] : [];
    const handle = await deps.binding.get(m.repo);
    let writeToken = '';
    try {
      const minted = await (handle as unknown as { createToken(scope: 'write', ttl: number): Promise<{ plaintext: string }> }).createToken('write', WRITE_TTL_S);
      writeToken = String(minted?.plaintext ?? '');
      if (!writeToken) throw Object.assign(new Error('no write token'), { code: 'upstream_5xx' });
      const dstW = createTransport(dst.href, { tracer: tracer(), limits: LIMITS, quirks: {}, auth: { bearer: writeToken }, fetchImpl: createGuardedFetch(raw, dst, deps.origin ? [deps.origin] : []) });
      const pushed = await push(dstW, { ref: `refs/heads/${m.branch}`, oldOid: have ?? ZERO_OID, newOid: want, objects });
      return { repo: m.repo, outcome: 'updated', from: have, to: want, objects: objects.length, pushBytes: pushed?.packBytes ?? 0, ms: Date.now() - t0 };
    } finally {
      const revoke = (handle as unknown as { revokeToken?: (t: string) => Promise<unknown> }).revokeToken;
      if (writeToken && revoke) { try { await revoke.call(handle, writeToken); } catch { /* it expires in WRITE_TTL_S */ } }
      try { (handle as Partial<Disposable>)[Symbol.dispose]?.(); } catch { /* best effort */ }
    }
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { repo: m.repo, outcome: 'error', code: err?.code ?? 'internal', message: String(err?.message ?? e).replace(/art_v1_[0-9a-f]+(\?expires=\d+)?/g, '[redacted]').slice(0, 300), ms: Date.now() - t0 };
  }
}

export async function syncAll(deps: { binding: ArtifactsNamespace; tokens: TokenSource; fetchImpl?: FetchLike; origin?: string }, mirrors: readonly Mirror[] = MIRRORS): Promise<SyncResult[]> {
  return Promise.all(mirrors.map(m => syncMirror(m, deps)));
}
