import { describe, expect, it } from 'vitest';
import { emitEval, evalLog, resolveLog, type EvalSample, type SpanLike } from '../../src/flags/telemetry.ts';
import { flagLogQuery, renderReport, reportFromEvents } from '../../src/flags/report.ts';
import { measureRounds } from '../../src/flags/propagation.ts';

const sample: EvalSample = {
  cacheStatus: 'MISS',
  revision: '"abc"',
  evalMs: 1.25,
  r2ReadMs: 4,
  unitId: 'unit-DO-NOT-LEAK',
  resolutions: [{ key: 'ply.usage.note', variantKind: 'boolean', variantValue: 'false', reason: 'default', bucket: 2849 }],
};

describe('telemetry', () => {
  it('puts the unit id on the eval span only', () => {
    const spans: { name: string; attrs: Record<string, string | number | boolean> }[] = [];
    const lines: string[] = [];
    const tracing = {
      enterSpan<T>(name: string, callback: (span: SpanLike) => T): T {
        const attrs: Record<string, string | number | boolean> = {};
        const span: SpanLike = { setAttribute: (key, value) => { attrs[key] = value; } };
        const result = callback(span);
        spans.push({ name, attrs });
        return result;
      },
    };
    emitEval(tracing, sample, line => lines.push(line));
    const parent = spans.find(span => span.name === 'flags.eval');
    const child = spans.find(span => span.name === 'flags.resolve');
    expect(parent?.attrs['flags.unit_id']).toBe('unit-DO-NOT-LEAK');
    expect(parent?.attrs['flags.cache_status']).toBe('MISS');
    expect(parent?.attrs['flags.r2_read_ms']).toBe(4);
    expect(child?.attrs['flags.unit_id']).toBeUndefined();
    expect(child?.attrs['flags.reason']).toBe('default');
    for (const line of lines) expect(line).not.toContain('unit-DO-NOT-LEAK');
    expect(JSON.parse(evalLog(sample)).msg).toBe('flags.eval');
    expect(JSON.parse(resolveLog(sample, sample.resolutions[0]!)).bucket).toBe(2849);
  });

  it('reports p50/p95/p99 per cache status and variants per flag and revision', () => {
    const events = [
      { msg: 'flags.eval', cache_status: 'HIT', eval_ms: 1, revision: '"a"' },
      { msg: 'flags.eval', cache_status: 'HIT', eval_ms: 2, revision: '"a"' },
      { msg: 'flags.eval', cache_status: 'HIT', eval_ms: 3, revision: '"a"' },
      { msg: 'flags.eval', cache_status: 'HIT', eval_ms: 4, revision: '"a"' },
      { msg: 'flags.eval', cache_status: 'HIT', eval_ms: 10, revision: '"a"' },
      { msg: 'flags.eval', cache_status: 'MISS', eval_ms: 10, revision: '"a"', r2_read_ms: 8 },
      { source: { msg: 'flags.resolve', key: 'ply.usage.note', revision: '"a"', variant_kind: 'boolean', variant_value: 'true', reason: 'bucket', unit_id: 'one' } },
      { source: { msg: 'flags.resolve', key: 'ply.usage.note', revision: '"a"', variant_kind: 'boolean', variant_value: 'true', reason: 'bucket', unit_id: 'two' } },
      { source: { msg: 'flags.resolve', key: 'ply.usage.note', revision: '"b"', variant_kind: 'boolean', variant_value: 'false', reason: 'default' } },
    ];
    const report = reportFromEvents(events);
    const hit = report.cache.find(row => row.cacheStatus === 'HIT');
    expect(hit).toMatchObject({ n: 5, p50: 3, p95: 4, p99: 4 });
    expect(report.cache.find(row => row.cacheStatus === 'MISS')?.p50).toBe(10);
    expect(report.variants).toEqual([
      { key: 'ply.usage.note', revision: '"a"', variantKind: 'boolean', variantValue: 'true', reason: 'bucket', count: 2 },
      { key: 'ply.usage.note', revision: '"b"', variantKind: 'boolean', variantValue: 'false', reason: 'default', count: 1 },
    ]);
    expect(renderReport(report)).toContain('ply.usage.note');
    expect(renderReport(report)).not.toContain('unit_id');
    const query = JSON.stringify(flagLogQuery('ply', 'flags.resolve', 0, 1));
    expect(query).not.toContain('unit');
    expect(query).toContain('flags.resolve');
  });
});

describe('propagation', () => {
  it('sees the new revision after invalidate and keeps the old one without it', async () => {
    let clock = 0;
    const measured = await measureRounds(3, () => clock++);
    expect(measured.staleWithoutInvalidate).toBe(true);
    expect(measured.rounds).toHaveLength(3);
    for (const round of measured.rounds) expect(round.to).not.toBe(round.from);
    expect(measured.p50).not.toBeNull();
  });
});
