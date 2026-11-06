// The one RateCounter stub. No platform import, so node tests can pass a fake namespace.
import { COUNTER_NAME } from './config.ts';
import type { ApplyRequest, ApplyResult, BlockedDoc } from './core.ts';

export type CounterStub = { apply(req: ApplyRequest): Promise<ApplyResult>; blockedDoc(): Promise<BlockedDoc> };
export type CounterNamespace = { idFromName(name: string): unknown; get(id: unknown): CounterStub };
export type CounterEnv = { RATE_COUNTER: CounterNamespace | null };

function isNamespace(v: unknown): v is CounterNamespace {
  return v !== null && typeof v === 'object' && typeof (v as CounterNamespace).idFromName === 'function';
}

/**
 * The RateCounter namespace: an env binding when one is given (tests), else `ctx.exports.RateCounter`. Production uses
 * ctx.exports: the platform refuses an env binding to a class its first deploy has not provisioned yet.
 */
export function counterNamespace(env: unknown, ctx: unknown): CounterNamespace | null {
  if (env !== null && typeof env === 'object' && 'RATE_COUNTER' in env && isNamespace((env as CounterEnv).RATE_COUNTER)) return (env as CounterEnv).RATE_COUNTER;
  if (ctx === null || typeof ctx !== 'object' || !('exports' in ctx)) return null;
  const exp = (ctx as { exports: unknown }).exports;
  if (exp === null || typeof exp !== 'object' || !('RateCounter' in exp)) return null;
  const ns = (exp as { RateCounter: unknown }).RateCounter;
  return isNamespace(ns) ? ns : null;
}

export function counterOf(env: unknown, ctx: unknown): CounterStub | null {
  const ns = counterNamespace(env, ctx);
  return ns === null ? null : ns.get(ns.idFromName(COUNTER_NAME));
}
