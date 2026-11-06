// The one RateCounter stub. No platform import, so node tests can pass a fake namespace.
import { COUNTER_NAME } from './config.ts';
import type { ApplyRequest, ApplyResult, BlockedDoc } from './core.ts';

export type CounterStub = { apply(req: ApplyRequest): Promise<ApplyResult>; blockedDoc(): Promise<BlockedDoc> };
export type CounterNamespace = { idFromName(name: string): unknown; get(id: unknown): CounterStub };
export type CounterEnv = { RATE_COUNTER: CounterNamespace | null };

function isNamespace(v: unknown): v is CounterNamespace {
  // typeof 'function' too: on the platform ctx.exports.RateCounter is a callable namespace (e61a5742: rate.counter =
  // "function:idFromName=function"), and requiring 'object' sent every batched request to legacy.
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return false;
  return typeof (v as CounterNamespace).idFromName === 'function';
}

/**
 * The RateCounter namespace: an env binding when one is given (tests), else `ctx.exports.RateCounter`. Production uses
 * ctx.exports: the platform refuses an env binding to a class its first deploy has not provisioned yet.
 */
export function counterNamespace(env: unknown, ctx: unknown): CounterNamespace | null {
  if (env !== null && typeof env === 'object' && 'RATE_COUNTER' in env && isNamespace((env as CounterEnv).RATE_COUNTER)) return (env as CounterEnv).RATE_COUNTER;
  const ns = exportedCounter(ctx);
  return isNamespace(ns) ? ns : null;
}

export function counterOf(env: unknown, ctx: unknown): CounterStub | null {
  const ns = counterNamespace(env, ctx);
  return ns === null ? null : ns.get(ns.idFromName(COUNTER_NAME));
}

/** `ctx.exports.RateCounter` by plain property access (no `in`: a proxy may not report its keys). */
export function exportedCounter(ctx: unknown): unknown {
  if (ctx === null || typeof ctx !== 'object') return null;
  try {
    const exp = (ctx as Record<string, unknown>)['exports'];
    if (exp === null || (typeof exp !== 'object' && typeof exp !== 'function')) return null;
    return (exp as Record<string, unknown>)['RateCounter'];
  } catch {
    return null;
  }
}

/** What ctx.exports.RateCounter looks like, for the ply.rate.check span (diagnosis of a fallback to legacy). */
export function describeCounter(ctx: unknown): string {
  const v = exportedCounter(ctx);
  if (v === null) return 'null';
  const t = typeof v;
  if (t !== 'object' && t !== 'function') return t;
  let idFromName = 'missing';
  try { idFromName = typeof (v as Record<string, unknown>)['idFromName']; } catch { idFromName = 'throws'; }
  return `${t}:idFromName=${idFromName}`;
}
