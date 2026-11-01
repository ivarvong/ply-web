// FlagsCache is the cache-enabled entrypoint (one ruleset, one tag). FlagControl is the RPC write API.
// Invalidate runs inside FlagsCache: Workers Cache scopes tags to the entrypoint that calls invalidate.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { chainGet, dig } from '../absent.ts';
import { getConfig, setRollout, setTargeting } from './api.ts';
import { serveFlags, type FlagCacheEnv } from './cache.ts';
import { r2Store, type InvalidateResult, type R2BucketLike } from './store.ts';
import { FLAGS_CACHE_TAG } from './ttl.ts';
import type { ReadResult, Targeting, WriteResult } from './types.ts';

export type FlagEnv = {
  FLAGS: R2BucketLike | null;
  FLAGS_MAX_AGE_S: string | null;
  FLAGS_SWR_S: string | null;
};

type InvalidateCall = { tags: string[] };

function successFalse(result: unknown): boolean {
  const success = chainGet(result, 'success');
  if (success.tag === 'none') return false;
  return success.value === false;
}

/** `error.message`, including the throw when the entry itself is null. A missing message is empty. */
function readMessage(error: unknown): unknown {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return (error as { message: unknown }).message;
  }
  const message = chainGet(error, 'message');
  if (message.tag === 'none') return '';
  return message.value;
}

function failureReason(result: unknown): string {
  const errors = chainGet(result, 'errors');
  if (errors.tag === 'none') return '';
  const mapped = (errors.value as { map(fn: (error: unknown) => unknown): unknown }).map(error => readMessage(error));
  const filtered = (mapped as { filter(fn: (message: unknown) => boolean): { join(sep: string): string } }).filter(message => !!message);
  return filtered.join('; ');
}

function fromPlatform(result: unknown): InvalidateResult {
  if (!result || successFalse(result)) {
    const reason = failureReason(result);
    return { kind: 'failed', reason: reason.length > 0 ? reason : 'invalidate failed' };
  }
  return { kind: 'ok' };
}

async function callInvalidate(ctx: unknown): Promise<unknown> {
  const cache = chainGet(ctx, 'cache');
  if (cache.tag === 'none') return null;
  const invalidate = chainGet(cache.value, 'invalidate');
  if (invalidate.tag === 'none') return null;
  const fn = invalidate.value as (this: unknown, options: InvalidateCall) => Promise<unknown>;
  return fn.call(cache.value, { tags: [FLAGS_CACHE_TAG] });
}

export class FlagsCache extends WorkerEntrypoint<FlagEnv> {
  override async fetch(request: Request): Promise<Response> {
    // FlagCacheEnv still spells optional bindings. Null is the same miss: envBinding maps both to none.
    return serveFlags(request, this.env as FlagCacheEnv, this.env.FLAGS ? r2Store(this.env.FLAGS) : null);
  }

  async invalidate(): Promise<InvalidateResult> {
    try {
      return fromPlatform(await callInvalidate(this.ctx));
    } catch (error) {
      return { kind: 'failed', reason: error instanceof Error ? error.message : 'invalidate failed' };
    }
  }
}

async function invalidateFrom(ctx: unknown): Promise<InvalidateResult> {
  const invalidate = dig(ctx, ['exports', 'FlagsCache', 'invalidate']);
  if (invalidate.tag === 'none' || !invalidate.value) {
    return { kind: 'failed', reason: 'FlagsCache entrypoint is not configured' };
  }
  try {
    const fn = invalidate.value as () => Promise<InvalidateResult>;
    return await fn();
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : 'invalidate failed' };
  }
}

export class FlagControl extends WorkerEntrypoint<FlagEnv> {
  async getConfig(): Promise<ReadResult> {
    if (!this.env.FLAGS) return { kind: 'unavailable', reason: 'FLAGS binding is not configured' };
    return getConfig(r2Store(this.env.FLAGS));
  }

  async setRollout(flag: string, basisPoints: number, expectedRevision: string): Promise<WriteResult> {
    if (!this.env.FLAGS) return { kind: 'unavailable', reason: 'FLAGS binding is not configured' };
    return setRollout(r2Store(this.env.FLAGS), { invalidate: () => invalidateFrom(this.ctx) }, flag, basisPoints, expectedRevision);
  }

  async setTargeting(flag: string, targeting: Targeting, expectedRevision: string): Promise<WriteResult> {
    if (!this.env.FLAGS) return { kind: 'unavailable', reason: 'FLAGS binding is not configured' };
    return setTargeting(r2Store(this.env.FLAGS), { invalidate: () => invalidateFrom(this.ctx) }, flag, targeting, expectedRevision);
  }
}
