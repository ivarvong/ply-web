// In-Worker reads. isEnabled is false when the flag is missing, the store is down, or the variant is not boolean true.
import { loadRuleset, type FlagCacheEnv, type FlagsCacheBinding } from './cache.ts';
import { elapsed, type Clock } from './clock.ts';
import { parseUnit } from './document.ts';
import { evaluateDocument } from './eval.ts';
import { emitEval, endSpan, openSpan, resolutionSample, type TracingLike } from './telemetry.ts';
import { USAGE_NOTE_FLAG, USAGE_NOTE_LINE } from './ttl.ts';
import { EMPTY_DOCUMENT, isEnabledVariant, type FlagEvaluation, type Unit } from './types.ts';

export type FlagRuntime = {
  env: FlagCacheEnv;
  cache: FlagsCacheBinding | null;
  tracing: TracingLike | null;
};

function runtimeOf(env: FlagCacheEnv, ctx: { exports?: { FlagsCache?: FlagsCacheBinding }; tracing?: TracingLike | null } | undefined): FlagRuntime {
  return { env, cache: ctx?.exports?.FlagsCache ?? null, tracing: ctx?.tracing ?? null };
}

export type ResolveResult =
  | { readonly kind: 'ok'; readonly evaluations: readonly FlagEvaluation[]; readonly revision: string | null; readonly cache: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

export async function resolveFlags(runtime: FlagRuntime, unit: Unit, keys: readonly string[] | null, clock: Clock = () => performance.now()): Promise<ResolveResult> {
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
    }, undefined, span);
    return { kind: 'ok', evaluations, revision: loaded.kind === 'ready' ? loaded.revision : null, cache: loaded.cache };
  } finally {
    endSpan(span);
  }
}

export async function isEnabled(env: FlagCacheEnv, ctx: { exports?: { FlagsCache?: FlagsCacheBinding }; tracing?: TracingLike | null } | undefined, key: string, unit: { readonly id: string; readonly attributes?: Readonly<Record<string, string>> }): Promise<boolean> {
  if (!env.FLAGS) return false;
  const parsed = parseUnit(unit.id, unit.attributes);
  if (parsed.kind === 'invalid') return false;
  const resolved = await resolveFlags(runtimeOf(env, ctx), { id: parsed.id, attributes: parsed.attributes }, [key]);
  if (resolved.kind === 'unavailable') return false;
  const evaluation = resolved.evaluations[0];
  return evaluation ? isEnabledVariant(evaluation.variant) : false;
}

export async function usageNote(env: FlagCacheEnv, ctx: { exports?: { FlagsCache?: FlagsCacheBinding }; tracing?: TracingLike | null } | undefined, unitHeader: string | null): Promise<string | null> {
  try {
    const id = unitHeader && unitHeader.length > 0 ? unitHeader : 'anonymous';
    const on = await isEnabled(env, ctx, USAGE_NOTE_FLAG, { id });
    return on ? USAGE_NOTE_LINE : null;
  } catch {
    return null;
  }
}
