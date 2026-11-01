import { describe, expect, it, vi } from 'vitest';
import { setRollout, setTargeting } from '../../src/flags/api.ts';
import { memoryStore, r2Store, type R2BucketLike } from '../../src/flags/store.ts';
import { ABSENT_REVISION, FLAGS_OBJECT_KEY } from '../../src/flags/ttl.ts';
import type { InvalidateResult } from '../../src/flags/store.ts';

/** One property. A null receiver and a missing key are holes. A stored null stays null. */
function slot(receiver: unknown, key: string): unknown {
  if (receiver === null || receiver === void 0) return void 0;
  if (typeof receiver !== 'object' && typeof receiver !== 'function') return void 0;
  return (receiver as Record<string, unknown>)[key];
}

const okInvalidate = async (): Promise<InvalidateResult> => ({ kind: 'ok' });

describe('compare-and-swap', () => {
  it('creates on the absent revision and conflicts on a stale etag', async () => {
    const store = memoryStore();
    const created = await setRollout(store, { invalidate: okInvalidate }, 'ply.usage.note', 1, ABSENT_REVISION);
    expect(created.kind).toBe('ok');
    if (created.kind !== 'ok') return;
    const lost = await setRollout(store, { invalidate: okInvalidate }, 'ply.usage.note', 5, ABSENT_REVISION);
    expect(lost).toEqual({ kind: 'conflict', expected: ABSENT_REVISION, actual: created.revision });
    const stale = await setRollout(store, { invalidate: okInvalidate }, 'ply.usage.note', 5, '"not-the-etag"');
    expect(stale.kind).toBe('conflict');
    if (stale.kind !== 'conflict') return;
    expect(stale.actual).toBe(created.revision);
    expect(slot(store.snapshot(), 'etag')).toBe(created.revision);
    const next = await setRollout(store, { invalidate: okInvalidate }, 'ply.usage.note', 5, created.revision);
    expect(next.kind).toBe('ok');
    if (next.kind !== 'ok') return;
    expect(next.config.flags[0]!.rollout).toEqual({ kind: 'ramping', basisPoints: 5 });
  });

  it('does not write an invalid edit', async () => {
    const store = memoryStore();
    const created = await setRollout(store, { invalidate: okInvalidate }, 'ply.usage.note', 1, ABSENT_REVISION);
    if (created.kind !== 'ok') throw new Error(created.kind);
    const rejected = await setRollout(store, { invalidate: okInvalidate }, 'ply.usage.note', 10_001, created.revision);
    expect(rejected.kind).toBe('invalid');
    expect(slot(store.snapshot(), 'etag')).toBe(created.revision);
  });

  it('logs the revision pair and the diff, and reports a failed invalidate', async () => {
    const store = memoryStore();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(line => { if (typeof line === 'string') lines.push(line); });
    const created = await setRollout(store, { invalidate: okInvalidate }, 'ply.usage.note', 1, ABSENT_REVISION);
    expect(created.kind).toBe('ok');
    if (created.kind !== 'ok') return;
    const write = lines.map(line => JSON.parse(line) as { msg: string; oldRevision: string | null; newRevision: string; diff: { op: string }[] }).find(entry => entry.msg === 'flags.write');
    expect(write).toMatchObject({ msg: 'flags.write', op: 'setRollout', flag: 'ply.usage.note', oldRevision: null, newRevision: created.revision });
    expect(slot(write == null ? void 0 : write.diff[0], 'op')).toBe('create');
    const targeted = await setTargeting(store, { invalidate: async () => ({ kind: 'failed', reason: 'tag busy' }) }, 'ply.usage.note', { allow: ['user-1'], deny: [], rules: [] }, created.revision);
    expect(targeted).toMatchObject({ kind: 'ok', invalidated: false });
    spy.mockRestore();
  });

  it('passes etagMatches unquoted and If-None-Match * to R2', async () => {
    const puts: { key: string; onlyIf: { etagMatches: string } | Headers }[] = [];
    let body = '';
    let etag = '';
    const bucket: R2BucketLike = {
      async get(key) {
        expect(key).toBe(FLAGS_OBJECT_KEY);
        if (!body) return null;
        return { etag, httpEtag: `"${etag}"`, text: async () => body };
      },
      async put(key, value, options) {
        puts.push({ key, onlyIf: options.onlyIf });
        const onlyIf = options.onlyIf;
        if (onlyIf instanceof Headers) {
          if (onlyIf.get('if-none-match') === '*' && body) return null;
        } else if (!onlyIf || onlyIf.etagMatches !== etag) return null;
        body = value;
        etag = 'abc';
        return { etag, httpEtag: '"abc"' };
      },
    };
    const store = r2Store(bucket);
    const created = await setRollout(store, { invalidate: okInvalidate }, 'ply.usage.note', 1, ABSENT_REVISION);
    expect(created.kind).toBe('ok');
    if (created.kind !== 'ok') return;
    expect(created.revision).toBe('"abc"');
    const createdPut = puts[0];
    const onlyIf = slot(createdPut, 'onlyIf');
    expect(slot(createdPut, 'key')).toBe(FLAGS_OBJECT_KEY);
    expect(onlyIf).toBeInstanceOf(Headers);
    if (!(onlyIf instanceof Headers)) return;
    expect(onlyIf.get('if-none-match')).toBe('*');
    const updated = await setRollout(store, { invalidate: okInvalidate }, 'ply.usage.note', 5, created.revision);
    expect(updated.kind).toBe('ok');
    expect(puts[1]).toMatchObject({ key: FLAGS_OBJECT_KEY, onlyIf: { etagMatches: 'abc' } });
    const lost = await setRollout(store, { invalidate: okInvalidate }, 'ply.usage.note', 10, '"stale"');
    expect(lost.kind).toBe('conflict');
    expect(puts).toHaveLength(2);
  });
});
