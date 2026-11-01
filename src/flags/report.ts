// p50/p95/p99 of flags.eval by cache status, and the count of resolved variants by flag and revision.
// Unit id is not a dimension. The same percentile index as scripts/cd/telemetry.ts: floor((n - 1) * p).

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

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function fieldsOf(event: Obj): Obj {
  const source = record(event.source) ?? {};
  const attributes = record(event.attributes) ?? record(source.attributes) ?? {};
  return { ...attributes, ...source, ...event };
}

export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor((sorted.length - 1) * p)] ?? null;
}

function quantiles(values: readonly number[]): Quantiles {
  return { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) };
}

type EvalPoint = { readonly cacheStatus: string; readonly evalMs: number };
type ResolvePoint = { readonly key: string; readonly revision: string; readonly variantKind: string; readonly variantValue: string; readonly reason: string };

function evalPoint(event: Obj): EvalPoint | null {
  const fields = fieldsOf(event);
  const name = stringField(fields.name) ?? stringField(fields.spanName);
  const msg = stringField(fields.msg);
  if (msg !== 'flags.eval' && name !== 'flags.eval') return null;
  const evalMs = numberField(fields.eval_ms) ?? numberField(fields['flags.eval_ms']);
  const cacheStatus = stringField(fields.cache_status) ?? stringField(fields['flags.cache_status']);
  if (evalMs === null || !cacheStatus) return null;
  return { cacheStatus, evalMs };
}

function resolvePoint(event: Obj): ResolvePoint | null {
  const fields = fieldsOf(event);
  const name = stringField(fields.name) ?? stringField(fields.spanName);
  const msg = stringField(fields.msg);
  if (msg !== 'flags.resolve' && name !== 'flags.resolve') return null;
  const key = stringField(fields.key) ?? stringField(fields['flags.key']);
  const revision = stringField(fields.revision) ?? stringField(fields['flags.revision']) ?? '';
  const variantKind = stringField(fields.variant_kind) ?? stringField(fields['flags.variant_kind']);
  const variantValue = stringField(fields.variant_value) ?? stringField(fields['flags.variant_value']);
  const reason = stringField(fields.reason) ?? stringField(fields['flags.reason']);
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
      const list = durations.get(sample.cacheStatus) ?? [];
      list.push(sample.evalMs);
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

export function renderReport(report: FlagReport): string {
  const lines = ['cache_status n p50_ms p95_ms p99_ms'];
  for (const row of report.cache) lines.push([row.cacheStatus, row.n, row.p50 ?? '-', row.p95 ?? '-', row.p99 ?? '-'].join(' '));
  lines.push('', 'flag revision variant_kind variant_value reason count');
  for (const row of report.variants) {
    lines.push([row.key, row.revision || '-', row.variantKind, row.variantValue, row.reason, row.count].join(' '));
  }
  return lines.join('\n');
}

export type TelemetryFilter = { readonly key: string; readonly operation: string; readonly type: string; readonly value: string };

/** Workers observability query for one low-cardinality log. The filter set has no unit id. */
export function flagLogQuery(worker: string, msg: 'flags.eval' | 'flags.resolve', from: number, to: number, offset?: string) {
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
