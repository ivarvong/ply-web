// One flags.eval span per resolution batch, plus a flags.resolve child per flag.
// The unit id is a parent-span attribute only. The log lines are the low-cardinality projection the
// observability script aggregates: cache status, revision, durations, and the resolved variant.
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
  readonly evalMs: number;
  readonly r2ReadMs: number | null;
  readonly unitId: string | null;
  readonly resolutions: readonly ResolutionSample[];
};

export type SpanLike = {
  setAttribute?(key: string, value: string | number | boolean): void;
  end?(): void;
};

export type TracingLike = {
  enterSpan?<T>(name: string, callback: (span: SpanLike) => T): T;
};

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
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

/** Log lines only. No unit id, so a query grouped by these fields stays low-cardinality. */
export function evalLog(sample: EvalSample): string {
  return JSON.stringify({
    msg: 'flags.eval',
    cache_status: sample.cacheStatus,
    revision: sample.revision,
    eval_ms: num(sample.evalMs),
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
  });
}

export function emitEval(tracing: TracingLike | null | undefined, sample: EvalSample, log: (line: string) => void = line => console.log(line)): void {
  const write = (span: SpanLike | null): void => {
    span?.setAttribute?.('flags.cache_status', sample.cacheStatus);
    span?.setAttribute?.('flags.revision', sample.revision ?? '');
    span?.setAttribute?.('flags.eval_ms', num(sample.evalMs));
    span?.setAttribute?.('flags.count', sample.resolutions.length);
    if (sample.r2ReadMs !== null) span?.setAttribute?.('flags.r2_read_ms', sample.r2ReadMs);
    if (sample.unitId !== null) span?.setAttribute?.('flags.unit_id', sample.unitId);
    log(evalLog(sample));
    for (const resolution of sample.resolutions) {
      const child = (inner: SpanLike | null): void => {
        inner?.setAttribute?.('flags.key', resolution.key);
        inner?.setAttribute?.('flags.variant_kind', resolution.variantKind);
        inner?.setAttribute?.('flags.variant_value', resolution.variantValue);
        inner?.setAttribute?.('flags.reason', resolution.reason);
        inner?.setAttribute?.('flags.bucket', resolution.bucket);
        inner?.setAttribute?.('flags.revision', sample.revision ?? '');
        inner?.setAttribute?.('flags.cache_status', sample.cacheStatus);
        log(resolveLog(sample, resolution));
      };
      if (tracing?.enterSpan) tracing.enterSpan('flags.resolve', child);
      else child(null);
    }
  };
  try {
    if (tracing?.enterSpan) tracing.enterSpan('flags.eval', write);
    else write(null);
  } catch {
    // Telemetry must not change the flag decision.
  }
}
