// In-Worker reads. isEnabled is false when the flag is missing, the store is down, or the variant is not boolean true.
import { parseFlagKey } from './brand.ts';
import { loadRuleset, type FlagCacheEnv, type FlagsCacheBinding } from './cache.ts';
import { elapsed, type Clock } from './clock.ts';
import { parseUnit, type AttributeInput } from './document.ts';
import { evaluateDocument } from './eval.ts';
import { chainGet, dig, fromNullable } from '../absent.ts';
import { some } from '../option.ts';
import { emitEval, endSpan, openSpan, resolutionSample, type TracingLike } from './telemetry.ts';
import { USAGE_NOTE_FLAG, USAGE_NOTE_LINE } from './ttl.ts';
import { EMPTY_DOCUMENT, isEnabledVariant, type CacheStatus, type FlagEvaluation, type FlagSelection, type Unit } from './types.ts';
import type { HeaderField } from '../http/inbound.ts';

export type FlagRuntime = {
  env: FlagCacheEnv;
  cache: FlagsCacheBinding | null;
  tracing: TracingLike | null;
};

/** A missing context, export, cache, or tracer is null. A present value stays, including a falsy one. */
export function flagRuntime(env: FlagCacheEnv, ctx: unknown): FlagRuntime {
  const host = fromNullable(ctx);
  if (host.tag === 'none') return { env, cache: null, tracing: null };
  const cache = dig(host.value, ['exports', 'FlagsCache']);
  const tracing = chainGet(host.value, 'tracing');
  return {
    env,
    cache: cache.tag === 'some' ? cache.value as FlagsCacheBinding : null,
    tracing: tracing.tag === 'some' ? tracing.value as TracingLike : null,
  };
}

export type ResolveResult =
  | { readonly kind: 'ok'; readonly evaluations: readonly FlagEvaluation[]; readonly revision: string | null; readonly cache: CacheStatus }
  | { readonly kind: 'unavailable'; readonly reason: string };

export async function resolveFlags(runtime: FlagRuntime, unit: Unit, keys: FlagSelection, clock: Clock = () => performance.now()): Promise<ResolveResult> {
  // Open the span before the await so its platform duration includes the cache/R2 yield.
  // The hash itself does not move the Workers clock; resolve_ms is this await, not the hash.
  const span = openSpan(runtime.tracing, 'flags.eval');
  try {
    const timed = await elapsed(clock, () => loadRuleset(runtime.env, runtime.cache));
    const loaded = timed.value;
    if (loaded.kind === 'unavailable') return { kind: 'unavailable', reason: loaded.reason };
    const document = loaded.kind === 'ready' ? loaded.document : EMPTY_DOCUMENT;
    const evalStarted = clock();
    const evaluations = evaluateDocument(document, unit, keys);
    const evalMs = clock() - evalStarted;
    emitEval(runtime.tracing, {
      cacheStatus: loaded.cache,
      revision: loaded.kind === 'ready' ? loaded.revision : null,
      evalMs,
      resolveMs: timed.ms,
      r2ReadMs: loaded.r2ReadMs,
      unitId: unit.id,
      resolutions: evaluations.map(resolutionSample),
    }, line => console.log(line), some(span));
    return { kind: 'ok', evaluations, revision: loaded.kind === 'ready' ? loaded.revision : null, cache: loaded.cache };
  } finally {
    endSpan(span);
  }
}

export async function isEnabled(env: FlagCacheEnv, ctx: unknown, key: string, unit: { readonly id: string; readonly attributes: AttributeInput }): Promise<boolean> {
  if (!env.FLAGS) return false;
  const parsedKey = parseFlagKey(key);
  if (parsedKey.kind !== 'key') return false;
  const parsed = parseUnit(unit.id, unit.attributes);
  if (parsed.kind === 'invalid') return false;
  const resolved = await resolveFlags(flagRuntime(env, ctx), { id: parsed.id, attributes: parsed.attributes }, { kind: 'listed', keys: [parsedKey.value] });
  if (resolved.kind === 'unavailable') return false;
  const evaluation = resolved.evaluations[0];
  return evaluation ? isEnabledVariant(evaluation.variant) : false;
}

export async function usageNote(env: FlagCacheEnv, ctx: unknown, unitHeader: HeaderField): Promise<string | null> {
  const id = unitHeader.kind === 'present' && unitHeader.value.length > 0 ? unitHeader.value : 'anonymous';
  const on = await isEnabled(env, ctx, USAGE_NOTE_FLAG, { id, attributes: { kind: 'absent' } });
  return on ? USAGE_NOTE_LINE : null;
}
