// In-Worker reads. isEnabled is false when the flag is missing, the store is down, or the variant is not boolean true.
import { loadRuleset, type FlagCacheEnv, type FlagsCacheBinding } from './cache.ts';
import { parseUnit } from './document.ts';
import { evaluateDocument } from './eval.ts';
import { emitEval, resolutionSample, type TracingLike } from './telemetry.ts';
import { USAGE_NOTE_FLAG } from './ttl.ts';
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

export async function resolveFlags(runtime: FlagRuntime, unit: Unit, keys: readonly string[] | null): Promise<ResolveResult> {
  const loaded = await loadRuleset(runtime.env, runtime.cache);
  if (loaded.kind === 'unavailable') return { kind: 'unavailable', reason: loaded.reason };
  const document = loaded.kind === 'ready' ? loaded.document : EMPTY_DOCUMENT;
  const started = performance.now();
  const evaluations = evaluateDocument(document, unit, keys);
  const evalMs = performance.now() - started;
  emitEval(runtime.tracing, {
    cacheStatus: loaded.cache,
    revision: loaded.kind === 'ready' ? loaded.revision : null,
    evalMs,
    r2ReadMs: loaded.r2ReadMs,
    unitId: unit.id,
    resolutions: evaluations.map(resolutionSample),
  });
  return { kind: 'ok', evaluations, revision: loaded.kind === 'ready' ? loaded.revision : null, cache: loaded.cache };
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
    return on ? 'ply.usage.note is on for this unit.' : null;
  } catch {
    return null;
  }
}
