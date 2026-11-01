// FlagsCache is the cache-enabled entrypoint (one ruleset, one tag). FlagsControl is the RPC write API.
// Invalidate runs inside FlagsCache: Workers Cache scopes tags to the entrypoint that calls invalidate.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { getConfig, setRollout, setTargeting } from './api.ts';
import { serveFlags } from './cache.ts';
import { r2Store, type InvalidateResult, type R2BucketLike } from './store.ts';
import { FLAGS_CACHE_TAG } from './ttl.ts';
import type { ReadResult, Targeting, WriteResult } from './types.ts';

export type FlagEnv = {
  FLAGS?: R2BucketLike;
  FLAGS_MAX_AGE_S?: string;
  FLAGS_SWR_S?: string;
};

type InvalidateCall = { tags: string[] };
type CacheResult = { success?: boolean; errors?: { message?: string }[] };
type FlagCtx = {
  cache?: { invalidate?: (options: InvalidateCall) => Promise<CacheResult> };
  exports?: { FlagsCache?: { invalidate?: () => Promise<InvalidateResult> } };
};

function fromPlatform(result: CacheResult | undefined): InvalidateResult {
  if (!result || result.success === false) {
    const reason = result?.errors?.map(error => error.message).filter(message => !!message).join('; ') || 'invalidate failed';
    return { kind: 'failed', reason };
  }
  return { kind: 'ok' };
}

export class FlagsCache extends WorkerEntrypoint<FlagEnv> {
  override async fetch(request: Request): Promise<Response> {
    return serveFlags(request, this.env, this.env.FLAGS ? r2Store(this.env.FLAGS) : null);
  }

  async invalidate(): Promise<InvalidateResult> {
    const ctx = this.ctx as FlagCtx;
    try {
      return fromPlatform(await ctx.cache?.invalidate?.({ tags: [FLAGS_CACHE_TAG] }));
    } catch (error) {
      return { kind: 'failed', reason: error instanceof Error ? error.message : 'invalidate failed' };
    }
  }
}

async function invalidateFrom(ctx: FlagCtx): Promise<InvalidateResult> {
  const invalidate = ctx.exports?.FlagsCache?.invalidate;
  if (!invalidate) return { kind: 'failed', reason: 'FlagsCache entrypoint is not configured' };
  try {
    return await invalidate();
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : 'invalidate failed' };
  }
}

export class FlagsControl extends WorkerEntrypoint<FlagEnv> {
  async getConfig(): Promise<ReadResult> {
    if (!this.env.FLAGS) return { kind: 'unavailable', reason: 'FLAGS binding is not configured' };
    return getConfig(r2Store(this.env.FLAGS));
  }

  async setRollout(flag: string, percent: number, expectedRevision: string): Promise<WriteResult> {
    if (!this.env.FLAGS) return { kind: 'unavailable', reason: 'FLAGS binding is not configured' };
    return setRollout(r2Store(this.env.FLAGS), { invalidate: () => invalidateFrom(this.ctx as FlagCtx) }, flag, percent, expectedRevision);
  }

  async setTargeting(flag: string, targeting: Targeting, expectedRevision: string): Promise<WriteResult> {
    if (!this.env.FLAGS) return { kind: 'unavailable', reason: 'FLAGS binding is not configured' };
    return setTargeting(r2Store(this.env.FLAGS), { invalidate: () => invalidateFrom(this.ctx as FlagCtx) }, flag, targeting, expectedRevision);
  }
}
