// Cache-enabled CAS entrypoints (cloudflare.config.ts). Reached only through ctx.exports after auth.
// Named entrypoints are not internet-routable. Purge for refs MUST run inside RefCache (entrypoint-scoped).
import { WorkerEntrypoint } from 'cloudflare:workers';
import { fromNullable, chainGet } from './absent.ts';
import {
  allowOriginsFromEnv,
  purgeRefTags,
  serveCommit,
  serveObject,
  serveRef,
  serveResolve,
  serveTree,
  viaCas,
  type CasBinding,
  type CasProps,
} from './cas-cache.ts';
import { tokenSourceFor, type ArtifactsNamespace } from './public.ts';

export type CasEnv = { PUBLIC_REPOS: unknown; ALLOW_REMOTE_ORIGINS: unknown };

function tokensOf(env: CasEnv) {
  const repos = fromNullable(env.PUBLIC_REPOS);
  return repos.tag === 'some' ? tokenSourceFor(repos.value as ArtifactsNamespace) : null;
}

function allowOf(env: CasEnv): readonly string[] {
  return allowOriginsFromEnv(env);
}

function propsOf(ctx: object): CasProps {
  const propsField = chainGet(ctx, 'props');
  if (propsField.tag === 'none') return { scope: '' };
  const scopeField = chainGet(propsField.value, 'scope');
  if (scopeField.tag === 'none' || typeof scopeField.value !== 'string') return { scope: '' };
  return { scope: scopeField.value };
}

function bindingOf(exportsBag: object, name: string): CasBinding {
  const field = chainGet(exportsBag, name);
  if (field.tag === 'none') {
    const stub: CasBinding = () => ({
      fetch: async () => new Response('missing binding', { status: 500, headers: { 'cache-control': 'no-store' } }),
    });
    return stub;
  }
  return field.value as CasBinding;
}

export class ObjectCache extends WorkerEntrypoint<CasEnv> {
  override async fetch(req: Request): Promise<Response> {
    return serveObject(req, propsOf(this.ctx as object), tokensOf(this.env), allowOf(this.env));
  }
}

export class TreeCache extends WorkerEntrypoint<CasEnv> {
  override async fetch(req: Request): Promise<Response> {
    return serveTree(req, propsOf(this.ctx as object), tokensOf(this.env), allowOf(this.env));
  }
}

export class CommitCache extends WorkerEntrypoint<CasEnv> {
  override async fetch(req: Request): Promise<Response> {
    return serveCommit(req, propsOf(this.ctx as object), tokensOf(this.env), allowOf(this.env));
  }
}

export class ResolvePathCache extends WorkerEntrypoint<CasEnv> {
  override async fetch(req: Request): Promise<Response> {
    const props = propsOf(this.ctx as object);
    const exportsBag = chainGet(this.ctx as object, 'exports');
    const bag = exportsBag.tag === 'some' ? (exportsBag.value as object) : {};
    const tree = bindingOf(bag, 'TreeCache');
    const commit = bindingOf(bag, 'CommitCache');
    return serveResolve(req, props, tokensOf(this.env), {
      tree: (oid, scope, auth) => viaCas(tree, 'tree', oid, scope, auth),
      commit: (oid, scope, auth) => viaCas(commit, 'commit', oid, scope, auth),
    }, allowOf(this.env));
  }
}

export class RefCache extends WorkerEntrypoint<CasEnv> {
  override async fetch(req: Request): Promise<Response> {
    // Backup invalidate path (POST): same purge as RPC, for when stub RPC is unavailable.
    if (req.method === 'POST' && new URL(req.url).pathname === '/invalidate') {
      const result = await purgeRefTags(this.ctx as object, ['ply-cas-ref']);
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 503,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    return serveRef(req, propsOf(this.ctx as object), tokensOf(this.env), allowOf(this.env));
  }

  /** Write path: purge every tip in this entrypoint so the next read sees the new tip. */
  async invalidateRefs(tags: string[]): Promise<{ ok: boolean; ms: number; error: string }> {
    return purgeRefTags(this.ctx as object, Array.isArray(tags) ? tags : []);
  }
}
