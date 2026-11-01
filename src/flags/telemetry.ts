// One flags.eval span per resolution batch, plus a flags.resolve child per flag.
// The unit id is a parent-span attribute only. The log lines are the low-cardinality projection the
// observability script aggregates: cache status, revision, durations, and the resolved variant.
import { chainGet, fromNullable } from '../absent.ts';
import { type Option } from '../option.ts';
import { roundMs } from './clock.ts';
import { variantKind, variantValue, type CacheStatus, type FlagEvaluation } from './types.ts';

export { CACHE_STATUSES } from './types.ts';

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

/** Optional method call. A null receiver or a null method does not run. A present method keeps its receiver. */
function callMethod(receiver: unknown, key: string, args: readonly unknown[]): void {
  const host = fromNullable(receiver);
  if (host.tag === 'none') return;
  const method = chainGet(host.value, key);
  if (method.tag === 'none') return;
  const fn = method.value as (...params: unknown[]) => unknown;
  fn.apply(host.value, [...args]);
}

function setAttribute(span: SpanLike | null, key: string, value: string | number | boolean): void {
  callMethod(span, 'setAttribute', [key, value]);
}

function revisionText(revision: string | null): string {
  return revision === null ? '' : revision;
}

export function openSpan(tracing: TracingLike | null, name: string): SpanLike | null {
  // The one-argument form stays open until end(). A platform enterSpan that requires a callback
  // (workerd: parameter 2 must be a Function) is not this form; skip it instead of failing the request.
  if (tracing === null) return null;
  const enter = chainGet(tracing, 'enterSpan');
  if (enter.tag === 'none' || typeof enter.value !== 'function' || enter.value.length !== 1) return null;
  const enterFn = enter.value as (spanName: string) => unknown;
  const span = enterFn(name);
  return span ? span as SpanLike : null;
}

export function endSpan(span: SpanLike | null): void {
  callMethod(span, 'end', []);
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
  tracing: TracingLike | null,
  sample: EvalSample,
  log: (line: string) => void,
  parent: Option<SpanLike | null>,
): void {
  const write = (span: SpanLike | null): void => {
    setAttribute(span, 'flags.cache_status', sample.cacheStatus);
    setAttribute(span, 'flags.revision', revisionText(sample.revision));
    setAttribute(span, 'flags.eval_ms', num(sample.evalMs));
    setAttribute(span, 'flags.resolve_ms', num(sample.resolveMs));
    setAttribute(span, 'flags.count', sample.resolutions.length);
    if (sample.r2ReadMs !== null) setAttribute(span, 'flags.r2_read_ms', sample.r2ReadMs);
    if (sample.unitId !== null) setAttribute(span, 'flags.unit_id', sample.unitId);
    log(evalLog(sample));
    for (const resolution of sample.resolutions) {
      const child = openSpan(tracing, 'flags.resolve');
      try {
        setAttribute(child, 'flags.key', resolution.key);
        setAttribute(child, 'flags.variant_kind', resolution.variantKind);
        setAttribute(child, 'flags.variant_value', resolution.variantValue);
        setAttribute(child, 'flags.reason', resolution.reason);
        setAttribute(child, 'flags.bucket', resolution.bucket);
        setAttribute(child, 'flags.revision', revisionText(sample.revision));
        setAttribute(child, 'flags.cache_status', sample.cacheStatus);
        setAttribute(child, 'flags.resolve_ms', num(sample.resolveMs));
        log(resolveLog(sample, resolution));
      } finally {
        endSpan(child);
      }
    }
  };
  // none: this call owns the eval span. some: the caller already opened it, including a null span.
  if (parent.tag === 'some') {
    write(parent.value);
    return;
  }
  const span = openSpan(tracing, 'flags.eval');
  try {
    write(span);
  } finally {
    endSpan(span);
  }
}
