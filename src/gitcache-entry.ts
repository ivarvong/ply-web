// The cache-enabled entrypoint (cloudflare.config.ts: exports.GitCache cache on). Reached only through ctx.exports from
// createLoopbackFetch (src/gitcache.ts); a named entrypoint is not routable from the internet.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { serveGitCache, type GitCacheEnv, type PurgeCtx } from './gitcache.ts';
import { tokenSourceFor, type ArtifactsNamespace } from './public.ts';

export class GitCache extends WorkerEntrypoint<GitCacheEnv> {
  override async fetch(req: Request): Promise<Response> {
    return serveGitCache(req, tokenSourceFor(this.env.PUBLIC_REPOS as ArtifactsNamespace | undefined), this.ctx as unknown as PurgeCtx);
  }
}
