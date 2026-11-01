import { describe, expect, it } from 'vitest';
import { emitEval, evalLog, resolveLog, type EvalSample, type SpanLike } from '../../src/flags/telemetry.ts';
import { MEASUREMENT, flagLogQuery, renderReport, reportFromEvents } from '../../src/flags/report.ts';
import { measureRounds } from '../../src/flags/propagation.ts';

const sample: EvalSample = {
  cacheStatus: 'MISS',
  revision: '"abc"',
  evalMs: 0,
  resolveMs: 8,
  r2ReadMs: 4,
  unitId: 'unit-DO-NOT-LEAK',
  resolutions: [{ key: 'ply.usage.note', variantKind: 'boolean', variantValue: 'false', reason: 'default', bucket: 2849 }],
};

describe('telemetry', () => {
  it('puts the unit id on the eval span only', () => {
    const spans: { name: string; attrs: Record<string, string | number | boolean> }[] = [];
    const lines: string[] = [];
    const tracing = {
      enterSpan(name: string): SpanLike {
        const attrs: Record<string, string | number | boolean> = {};
        return {
          setAttribute: (key, value) => { attrs[key] = value; },
          end: () => { spans.push({ name, attrs }); },
        };
      },
    };
    emitEval(tracing, sample, line => lines.push(line));
    const parent = spans.find(span => span.name === 'flags.eval');
    const child = spans.find(span => span.name === 'flags.resolve');
    expect(parent?.attrs['flags.unit_id']).toBe('unit-DO-NOT-LEAK');
    expect(parent?.attrs['flags.cache_status']).toBe('MISS');
    expect(parent?.attrs['flags.resolve_ms']).toBe(8);
    expect(parent?.attrs['flags.eval_ms']).toBe(0);
    expect(parent?.attrs['flags.r2_read_ms']).toBe(4);
    expect(child?.attrs['flags.unit_id']).toBeUndefined();
    expect(child?.attrs['flags.reason']).toBe('default');
    for (const line of lines) expect(line).not.toContain('unit-DO-NOT-LEAK');
    expect(JSON.parse(evalLog(sample)).msg).toBe('flags.eval');
    expect(JSON.parse(evalLog(sample)).resolve_ms).toBe(8);
    expect(JSON.parse(evalLog(sample)).eval_ms).toBe(0);
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
      { msg: 'flags.resolve', key: 'ply.usage.note', revision: '"a"', variant_kind: 'boolean', variant_value: 'true', reason: 'bucket', resolve_ms: 999, cache_status: 'HIT' },
    ];
    const report = reportFromEvents(events);
    const hit = report.cache.find(row => row.cacheStatus === 'HIT');
    expect(hit).toMatchObject({ n: 5, p50: 3, p95: 4, p99: 4 });
    expect(report.cache.find(row => row.cacheStatus === 'MISS')?.p50).toBe(10);
    expect(report.variants).toEqual([
      { key: 'ply.usage.note', revision: '"a"', variantKind: 'boolean', variantValue: 'true', reason: 'bucket', count: 3 },
      { key: 'ply.usage.note', revision: '"b"', variantKind: 'boolean', variantValue: 'false', reason: 'default', count: 1 },
    ]);
    expect(renderReport(report)).toContain('ply.usage.note');
    expect(renderReport(report)).not.toContain('unit_id');
    const query = JSON.stringify(flagLogQuery('ply', 'flags.resolve', 0, 1));
    expect(query).not.toContain('unit');
    expect(query).toContain('flags.resolve');
  });

  it('uses resolve_ms, then a positive eval_ms, then wall time, and skips zeros', () => {
    const preferred = reportFromEvents([
      { msg: 'flags.eval', cache_status: 'MISS', resolve_ms: 7, eval_ms: 1, wallTimeMs: 100 },
    ]);
    expect(preferred.cache.find(row => row.cacheStatus === 'MISS')).toMatchObject({ n: 1, p50: 7 });
    const legacy = reportFromEvents([
      { msg: 'flags.eval', cache_status: 'HIT', eval_ms: 4 },
    ]);
    expect(legacy.cache.find(row => row.cacheStatus === 'HIT')?.p50).toBe(4);
    const wall = reportFromEvents([
      { msg: 'flags.eval', cache_status: 'STALE', resolve_ms: 0, eval_ms: 0, $workers: { wallTimeMs: 30 } },
    ]);
    expect(wall.cache.find(row => row.cacheStatus === 'STALE')?.p50).toBe(30);
    const span = reportFromEvents([
      { name: 'flags.eval', cache_status: 'UPDATING', resolve_ms: 0, eval_ms: 0, durationMs: 11 },
    ]);
    expect(span.cache.find(row => row.cacheStatus === 'UPDATING')?.p50).toBe(11);
    const frozen = reportFromEvents([
      { msg: 'flags.eval', cache_status: 'HIT', resolve_ms: 0, eval_ms: 0, durationMs: 0 },
    ]);
    expect(frozen.cache).toEqual([]);
    expect(MEASUREMENT).toContain('resolve_ms');
    expect(MEASUREMENT).toContain('FlagsCache');
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
