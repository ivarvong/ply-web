// Cache-enabled CAS entrypoints (cloudflare.config.ts). Reached only through ctx.exports after auth.
// Named entrypoints are not internet-routable. Purge for refs MUST run inside RefCache (entrypoint-scoped).
import { WorkerEntrypoint } from 'cloudflare:workers';
import { fromNullable } from './absent.ts';
import {
  encodeRefPath,
  purgeRefTags,
  serveCommit,
  serveObject,
  serveRef,
  serveResolve,
  serveTree,
  viaCas,
  type CasProps,
} from './cas-cache.ts';
import { tokenSourceFor, type ArtifactsNamespace } from './public.ts';

export type CasEnv = { PUBLIC_REPOS: unknown };

function tokensOf(env: CasEnv) {
  const repos = fromNullable(env.PUBLIC_REPOS);
  return repos.tag === 'some' ? tokenSourceFor(repos.value as ArtifactsNamespace) : null;
}

function propsOf(ctx: { props?: CasProps }): CasProps {
  const p = ctx.props;
  return p && typeof p.scope === 'string' ? p : { scope: '' };
}

export class ObjectCache extends WorkerEntrypoint<CasEnv> {
  override async fetch(req: Request): Promise<Response> {
    return serveObject(req, propsOf(this.ctx as { props?: CasProps }), tokensOf(this.env));
  }
}

export class TreeCache extends WorkerEntrypoint<CasEnv> {
  override async fetch(req: Request): Promise<Response> {
    return serveTree(req, propsOf(this.ctx as { props?: CasProps }), tokensOf(this.env));
  }
}

export class CommitCache extends WorkerEntrypoint<CasEnv> {
  override async fetch(req: Request): Promise<Response> {
    return serveCommit(req, propsOf(this.ctx as { props?: CasProps }), tokensOf(this.env));
  }
}

export class ResolvePathCache extends WorkerEntrypoint<CasEnv> {
  override async fetch(req: Request): Promise<Response> {
    const props = propsOf(this.ctx as { props?: CasProps });
    const bag = (this.ctx as unknown as {
      exports: {
        TreeCache: { fetch(input: RequestInfo | URL, init?: { props?: CasProps }): Promise<Response> };
        CommitCache: { fetch(input: RequestInfo | URL, init?: { props?: CasProps }): Promise<Response> };
      };
    }).exports;
    return serveResolve(req, props, tokensOf(this.env), {
      tree: (oid, scope, auth) => viaCas(bag.TreeCache, 'tree', oid, scope, auth),
      commit: (oid, scope, auth) => viaCas(bag.CommitCache, 'commit', oid, scope, auth),
    });
  }
}

export class RefCache extends WorkerEntrypoint<CasEnv> {
  override async fetch(req: Request): Promise<Response> {
    return serveRef(req, propsOf(this.ctx as { props?: CasProps }), tokensOf(this.env));
  }

  /** Write path: purge ref tags so the next read sees the new tip. Purge is scoped to this entrypoint. */
  async invalidateRefs(tags: string[]): Promise<{ ok: boolean; ms: number; error: string }> {
    return purgeRefTags(this.ctx as { cache?: { purge?: (opts: { tags: string[] }) => Promise<unknown> } }, Array.isArray(tags) ? tags : []);
  }
}

export { encodeRefPath };
