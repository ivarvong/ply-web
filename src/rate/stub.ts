// The one RateCounter stub. No platform import, so node tests can pass a fake namespace.
import { COUNTER_NAME } from './config.ts';
import type { ApplyRequest, ApplyResult, BlockedDoc } from './core.ts';

export type CounterStub = { apply(req: ApplyRequest): Promise<ApplyResult>; blockedDoc(): Promise<BlockedDoc> };
export type CounterNamespace = { idFromName(name: string): unknown; get(id: unknown): CounterStub };
export type CounterEnv = { RATE_COUNTER: CounterNamespace | null };

export function counterOf(env: unknown): CounterStub | null {
  if (env === null || typeof env !== 'object' || !('RATE_COUNTER' in env)) return null;
  const ns = (env as CounterEnv).RATE_COUNTER;
  if (ns === null || typeof ns !== 'object') return null;
  return ns.get(ns.idFromName(COUNTER_NAME));
}
