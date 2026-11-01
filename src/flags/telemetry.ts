// One flags.eval span per resolution batch, plus a flags.resolve child per flag.
// The unit id is a parent-span attribute only. The log lines are the low-cardinality projection the
// observability script aggregates: cache status, revision, durations, and the resolved variant.
import { roundMs } from './clock.ts';
import { variantKind, variantValue, type CacheStatus, type FlagEvaluation } from './types.ts';

export const CACHE_STATUSES = ['HIT', 'MISS', 'UPDATING', 'REVALIDATED', 'EXPIRED', 'STALE', 'BYPASS', 'NONE'] as const;

export type ResolutionSample = {
  readonly key: string;
  readonly variantKind: string;
  readonly variantValue: string;
  readonly reason: FlagEvaluation['reason'];
  readonly bucket: number;
};

export type EvalSample = {
  readonly cacheStatus: CacheStatus;
  readonly revision: string | null;
  /** Pure evaluation. On Workers this stays 0: the clock does not move until the isolate yields. */
  readonly evalMs: number;
  /**
   * Wall time of the awaited FlagsCache read that preceded evaluation.
   * A hit is the cache lookup. A miss, stale, or revalidation includes the R2 read inside that await.
   * This is the duration flags-o11y percentiles. It is not the pure hash.
   */
  readonly resolveMs: number;
  readonly r2ReadMs: number | null;
  readonly unitId: string | null;
  readonly resolutions: readonly ResolutionSample[];
};

export type SpanLike = {
  setAttribute?(key: string, value: string | number | boolean): void;
  end?(): void;
};

export type TracingLike = {
  /**
   * One-argument form, same as the viewer: the span stays open until `end()`.
   * A callback form would close before an await, and the Workers clock would record 0.
   */
  enterSpan?(name: string): SpanLike;
};

export function openSpan(tracing: TracingLike | null | undefined, name: string): SpanLike | null {
  try {
    return tracing?.enterSpan?.(name) ?? null;
  } catch {
    return null;
  }
}

export function endSpan(span: SpanLike | null): void {
  try {
    span?.end?.();
  } catch {
    // Telemetry must not change the flag decision.
  }
}

export function resolutionSample(evaluation: FlagEvaluation): ResolutionSample {
  return {
    key: evaluation.key,
    variantKind: variantKind(evaluation.variant),
    variantValue: variantValue(evaluation.variant),
    reason: evaluation.reason,
    bucket: evaluation.bucket,
  };
}

function num(value: number): number {
  return roundMs(value);
}

/** Log lines only. No unit id, so a query grouped by these fields stays low-cardinality. */
export function evalLog(sample: EvalSample): string {
  return JSON.stringify({
    msg: 'flags.eval',
    cache_status: sample.cacheStatus,
    revision: sample.revision,
    eval_ms: num(sample.evalMs),
    resolve_ms: num(sample.resolveMs),
    r2_read_ms: sample.r2ReadMs,
    flag_count: sample.resolutions.length,
  });
}

export function resolveLog(sample: EvalSample, resolution: ResolutionSample): string {
  return JSON.stringify({
    msg: 'flags.resolve',
    key: resolution.key,
    variant_kind: resolution.variantKind,
    variant_value: resolution.variantValue,
    reason: resolution.reason,
    bucket: resolution.bucket,
    revision: sample.revision,
    cache_status: sample.cacheStatus,
    resolve_ms: num(sample.resolveMs),
  });
}

export function emitEval(
  tracing: TracingLike | null | undefined,
  sample: EvalSample,
  log: (line: string) => void = line => console.log(line),
  parent?: SpanLike | null,
): void {
  const write = (span: SpanLike | null): void => {
    span?.setAttribute?.('flags.cache_status', sample.cacheStatus);
    span?.setAttribute?.('flags.revision', sample.revision ?? '');
    span?.setAttribute?.('flags.eval_ms', num(sample.evalMs));
    span?.setAttribute?.('flags.resolve_ms', num(sample.resolveMs));
    span?.setAttribute?.('flags.count', sample.resolutions.length);
    if (sample.r2ReadMs !== null) span?.setAttribute?.('flags.r2_read_ms', sample.r2ReadMs);
    if (sample.unitId !== null) span?.setAttribute?.('flags.unit_id', sample.unitId);
    log(evalLog(sample));
    for (const resolution of sample.resolutions) {
      const child = openSpan(tracing, 'flags.resolve');
      try {
        child?.setAttribute?.('flags.key', resolution.key);
        child?.setAttribute?.('flags.variant_kind', resolution.variantKind);
        child?.setAttribute?.('flags.variant_value', resolution.variantValue);
        child?.setAttribute?.('flags.reason', resolution.reason);
        child?.setAttribute?.('flags.bucket', resolution.bucket);
        child?.setAttribute?.('flags.revision', sample.revision ?? '');
        child?.setAttribute?.('flags.cache_status', sample.cacheStatus);
        child?.setAttribute?.('flags.resolve_ms', num(sample.resolveMs));
        log(resolveLog(sample, resolution));
      } finally {
        endSpan(child);
      }
    }
  };
  try {
    if (parent !== undefined) {
      write(parent);
      return;
    }
    const span = openSpan(tracing, 'flags.eval');
    try {
      write(span);
    } finally {
      endSpan(span);
    }
  } catch {
    // Telemetry must not change the flag decision.
  }
}
