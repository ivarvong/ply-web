// The cache-enabled entrypoint (cloudflare.config.ts: exports.GitCache cache on). Reached only through ctx.exports from
// createLoopbackFetch (src/gitcache.ts); a named entrypoint is not routable from the internet.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { fromNullable } from './absent.ts';
import { purgeRefsTags, serveGitCache, type GitCacheEnv, type PurgeCtx } from './gitcache.ts';
import { tokenSourceFor, type ArtifactsNamespace } from './public.ts';

export class GitCache extends WorkerEntrypoint<GitCacheEnv> {
  override async fetch(req: Request): Promise<Response> {
    const repos = fromNullable(this.env.PUBLIC_REPOS);
    const tokens = repos.tag === 'some' ? tokenSourceFor(repos.value as ArtifactsNamespace) : null;
    return serveGitCache(req, tokens, this.ctx as unknown as PurgeCtx);
  }

  /** RefsWatch's purge (src/refs-watch-entry.ts): the refs tag of each repo, from the entrypoint that stored it. */
  async purgeRefs(repos: string[]): Promise<{ ok: boolean; ms: number; error: string }> {
    return purgeRefsTags(this.ctx as unknown as PurgeCtx, Array.isArray(repos) ? repos : []);
  }
}
