// p50/p95/p99 of flags.eval by cache status, and the count of resolved variants by flag and revision.
// Unit id is not a dimension. The same percentile index as scripts/cd/telemetry.ts: floor((n - 1) * p).
import { atIndex, chainGet, mapGet } from '../absent.ts';
import { unwrapOr } from '../option.ts';

export type Quantiles = { readonly n: number; readonly p50: number | null; readonly p95: number | null; readonly p99: number | null };

export type CacheRow = { readonly cacheStatus: string } & Quantiles;

export type VariantRow = {
  readonly key: string;
  readonly revision: string;
  readonly variantKind: string;
  readonly variantValue: string;
  readonly reason: string;
  readonly count: number;
};

export type FlagReport = {
  readonly cache: readonly CacheRow[];
  readonly variants: readonly VariantRow[];
};

type Obj = Record<string, unknown>;

function record(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function field(value: unknown, key: string): unknown {
  return unwrapOr(chainGet(value, key), null);
}

function recordOrEmpty(first: Obj | null, second: Obj | null): Obj {
  if (first !== null) return first;
  if (second !== null) return second;
  return {};
}

function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const text = stringField(value);
    if (text !== null) return text;
  }
  return null;
}

function firstPositive(...values: readonly unknown[]): number | null {
  for (const value of values) {
    const ms = positiveMs(value);
    if (ms !== null) return ms;
  }
  return null;
}

function fieldsOf(event: Obj): Obj {
  const source = recordOrEmpty(record(event.source), null);
  const attributes = recordOrEmpty(record(event.attributes), record(field(source, 'attributes')));
  return { ...attributes, ...source, ...event };
}

export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return unwrapOr(atIndex(sorted, Math.floor((sorted.length - 1) * p)), null);
}

function quantiles(values: readonly number[]): Quantiles {
  return { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) };
}

type EvalPoint = { readonly cacheStatus: string; readonly resolveMs: number };

/** A positive duration. Zero is not a measurement: the Workers clock did not move. */
function positiveMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function wallMs(fields: Obj): number | null {
  const workers = record(fields.$workers);
  return firstPositive(field(workers, 'wallTimeMs'), fields.wallTimeMs, fields['$workers.wallTimeMs']);
}

function spanMs(fields: Obj): number | null {
  return firstPositive(fields.durationMs, fields.durationMS, fields.duration_ms);
}

/**
 * Prefer the awaited cache/R2 wall time. A legacy positive eval_ms is the next choice.
 * Zero is skipped so a frozen Workers clock does not become the percentile: the invocation
 * wallTimeMs, then the span duration, fill that gap.
 */
function measuredMs(fields: Obj): number | null {
  return firstPositive(
    fields.resolve_ms,
    fields['flags.resolve_ms'],
    fields.eval_ms,
    fields['flags.eval_ms'],
    wallMs(fields),
    spanMs(fields),
  );
}
type ResolvePoint = { readonly key: string; readonly revision: string; readonly variantKind: string; readonly variantValue: string; readonly reason: string };

function evalPoint(event: Obj): EvalPoint | null {
  const fields = fieldsOf(event);
  const name = firstString(fields.name, fields.spanName);
  const msg = stringField(fields.msg);
  if (msg !== 'flags.eval' && name !== 'flags.eval') return null;
  const resolveMs = measuredMs(fields);
  const cacheStatus = firstString(fields.cache_status, fields['flags.cache_status']);
  if (resolveMs === null || !cacheStatus) return null;
  return { cacheStatus, resolveMs };
}

function resolvePoint(event: Obj): ResolvePoint | null {
  const fields = fieldsOf(event);
  const name = firstString(fields.name, fields.spanName);
  const msg = stringField(fields.msg);
  if (msg !== 'flags.resolve' && name !== 'flags.resolve') return null;
  const key = firstString(fields.key, fields['flags.key']);
  const revisionText = firstString(fields.revision, fields['flags.revision']);
  const revision = revisionText === null ? '' : revisionText;
  const variantKind = firstString(fields.variant_kind, fields['flags.variant_kind']);
  const variantValue = firstString(fields.variant_value, fields['flags.variant_value']);
  const reason = firstString(fields.reason, fields['flags.reason']);
  if (!key || !variantKind || variantValue === null || !reason) return null;
  return { key, revision, variantKind, variantValue, reason };
}

export function reportFromEvents(events: readonly unknown[]): FlagReport {
  const durations = new Map<string, number[]>();
  const variants = new Map<string, VariantRow>();
  for (const event of events) {
    const rec = record(event);
    if (!rec) continue;
    const sample = evalPoint(rec);
    if (sample) {
      const list = unwrapOr(mapGet(durations, sample.cacheStatus), []);
      list.push(sample.resolveMs);
      durations.set(sample.cacheStatus, list);
    }
    const resolved = resolvePoint(rec);
    if (!resolved) continue;
    const id = [resolved.key, resolved.revision, resolved.variantKind, resolved.variantValue, resolved.reason].join('\0');
    const row = variants.get(id);
    if (row) variants.set(id, { ...row, count: row.count + 1 });
    else variants.set(id, { ...resolved, count: 1 });
  }
  const cache = [...durations.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cacheStatus, values]) => ({ cacheStatus, ...quantiles(values) }));
  const rows = [...variants.values()].sort((a, b) => a.key.localeCompare(b.key) || a.revision.localeCompare(b.revision) || b.count - a.count || a.reason.localeCompare(b.reason));
  return { cache, variants: rows };
}

/**
 * What the percentile columns measure. stdout of scripts/flags-o11y.ts stays the table;
 * the script prints this on stderr.
 */
export const MEASUREMENT =
  'p50/p95/p99 are resolve_ms on flags.eval: the awaited FlagsCache read (a hit is the cache lookup; a miss, stale, or revalidation includes the R2 read inside that await). Grouped by cache_status. Zero is not a sample. Fallback is a positive eval_ms, then invocation wallTimeMs, then span duration. flags.resolve events are variant counts only and are not timed again.';

export function renderReport(report: FlagReport): string {
  const lines = ['cache_status n p50_ms p95_ms p99_ms'];
  for (const row of report.cache) lines.push([row.cacheStatus, row.n, quantileCell(row.p50), quantileCell(row.p95), quantileCell(row.p99)].join(' '));
  lines.push('', 'flag revision variant_kind variant_value reason count');
  for (const row of report.variants) {
    lines.push([row.key, row.revision || '-', row.variantKind, row.variantValue, row.reason, row.count].join(' '));
  }
  return lines.join('\n');
}

export type TelemetryFilter = { readonly key: string; readonly operation: string; readonly type: string; readonly value: string };

/** Workers observability query for one low-cardinality log. The filter set has no unit id. */
function quantileCell(value: number | null): number | string {
  return value === null ? '-' : value;
}

export function flagLogQuery(worker: string, msg: 'flags.eval' | 'flags.resolve', from: number, to: number, offset: string | null) {
  const filters: TelemetryFilter[] = [
    { key: '$metadata.service', operation: 'eq', type: 'string', value: worker },
    { key: 'msg', operation: 'eq', type: 'string', value: msg },
  ];
  return {
    queryId: 'ply-flags',
    timeframe: { from, to },
    view: 'events' as const,
    limit: 1000,
    ...(offset ? { offset } : {}),
    parameters: { filters },
  };
}
