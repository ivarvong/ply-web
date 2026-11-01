import { describe, expect, it, vi } from 'vitest';
import { serveFlags, loadRuleset, normalizeCacheStatus, rulesetCacheProblems, rulesetRequest, rulesetRequestProblems } from '../../src/flags/cache.ts';
import { CACHE_STATUSES, parseCacheStatus } from '../../src/flags/types.ts';
import { memoryStore } from '../../src/flags/store.ts';
import { setRollout } from '../../src/flags/api.ts';
import { ABSENT_REVISION, FLAGS_CACHE_URL, FLAGS_MAX_AGE_S, FLAGS_SWR_S, cacheControl } from '../../src/flags/ttl.ts';
import { handleFlagHttp } from '../../src/flags/http.ts';
import { isEnabled, resolveFlags, usageNote } from '../../src/flags/client.ts';

const env = { FLAGS: { present: true }, FLAGS_MAX_AGE_S: String(FLAGS_MAX_AGE_S), FLAGS_SWR_S: String(FLAGS_SWR_S) };

async function seeded() {
  const store = memoryStore();
  const written = await setRollout(store, { invalidate: async () => ({ kind: 'ok' }) }, 'ply.usage.note', 0, ABSENT_REVISION);
  if (written.kind !== 'ok') throw new Error(written.kind);
  return { store, revision: written.revision };
}

describe('cache status', () => {
  it('keeps every documented token and does not alias an unknown one to NONE', () => {
    for (const status of CACHE_STATUSES) {
      expect(parseCacheStatus(status)).toEqual({ kind: 'known', status });
      expect(normalizeCacheStatus(status)).toBe(status);
    }
    expect(parseCacheStatus(null)).toEqual({ kind: 'absent' });
    expect(normalizeCacheStatus(null)).toBe('NONE');
    expect(normalizeCacheStatus('')).toBe('NONE');
    expect(parseCacheStatus('IGNORED')).toEqual({ kind: 'unrecognized', value: 'IGNORED' });
    expect(normalizeCacheStatus('IGNORED')).toBe('UNKNOWN');
  });
});

describe('ruleset cache', () => {
  it('sets a short max-age, a long stale-while-revalidate, the revision etag, and one tag', async () => {
    const { store, revision } = await seeded();
    const response = await serveFlags(new Request('https://flags.internal/config'), env, store);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(cacheControl(FLAGS_MAX_AGE_S, FLAGS_SWR_S));
    expect(rulesetCacheProblems(response.headers)).toEqual([]);
    expect(response.headers.get('etag')).toBe(revision);
    const again = await serveFlags(new Request('https://flags.internal/config', { headers: { 'if-none-match': revision } }), env, store);
    expect(again.status).toBe(304);
    expect(rulesetCacheProblems(again.headers)).toEqual([]);
    expect(again.headers.get('etag')).toBe(revision);
    expect(await again.text()).toBe('');
  });

  it('caches a missing ruleset under the same contract as a present one', async () => {
    const response = await serveFlags(rulesetRequest(), env, memoryStore());
    expect(response.status).toBe(404);
    expect(rulesetCacheProblems(response.headers)).toEqual([]);
    expect(response.headers.get('cache-control')).toBe(cacheControl(FLAGS_MAX_AGE_S, FLAGS_SWR_S));
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.get('vary')).toBeNull();
  });

  it('calls FlagsCache with one stable key, and records hit, miss, and stale', async () => {
    const seen: string[] = [];
    const { store } = await seeded();
    for (const status of ['HIT', 'MISS', 'STALE'] as const) {
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)); });
      try {
        const cache = {
          async fetch(request: Request) {
            seen.push(`${request.method} ${request.url}`);
            expect(rulesetRequestProblems(request)).toEqual([]);
            expect(request.headers.has('authorization')).toBe(false);
            expect(request.headers.has('cookie')).toBe(false);
            const response = await serveFlags(request, env, status === 'MISS' ? memoryStore() : store);
            expect(rulesetCacheProblems(response.headers)).toEqual([]);
            response.headers.set('cf-cache-status', status);
            return response;
          },
        };
        const unit = status === 'HIT' ? 'user-a' : 'user-b';
        await usageNote(env, { exports: { FlagsCache: cache }, tracing: null }, unit);
        const resolved = await resolveFlags(
          { env, cache, tracing: null },
          { id: unit, attributes: {} },
          ['ply.usage.note'],
        );
        expect(resolved.kind).toBe('ok');
        if (resolved.kind === 'ok') expect(resolved.cache).toBe(status);
      } finally {
        spy.mockRestore();
      }
      const parsed = lines.map(line => JSON.parse(line) as { msg?: string; cache_status?: string });
      expect(parsed.filter(row => row.msg === 'flags.resolve').every(row => row.cache_status === status)).toBe(true);
      expect(parsed.some(row => row.msg === 'flags.resolve' && row.cache_status === status)).toBe(true);
    }
    expect(new Set(seen)).toEqual(new Set([`GET ${FLAGS_CACHE_URL}`]));
  });

  it('serves eval as no-store and refuses an HTTP write', async () => {
    const { store } = await seeded();
    const cache = {
      async fetch(request: Request) {
        const response = await serveFlags(request, env, store);
        response.headers.set('cf-cache-status', 'MISS');
        return response;
      },
    };
    const ctx = { exports: { FlagsCache: cache }, tracing: null };
    const listed = await handleFlagHttp(new Request('https://ply.ivar.workers.dev/v1/flags'), env, ctx);
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    const put = await handleFlagHttp(new Request('https://ply.ivar.workers.dev/v1/flags', { method: 'PUT' }), env, ctx);
    expect(put.status).toBe(405);
    const body = await put.json() as { message: string };
    expect(body.message).toContain('FlagControl');
    expect(body.message).toContain('ply-flag-operator');
    const evalResponse = await handleFlagHttp(new Request('https://ply.ivar.workers.dev/v1/flags/eval', {
      method: 'POST',
      body: JSON.stringify({ unit: 'anonymous' }),
    }), env, ctx);
    expect(evalResponse.headers.get('cache-control')).toBe('no-store');
    const payload = await evalResponse.json() as { flags: { key: string; reason: string; variant: { value: boolean } }[] };
    expect(payload.flags[0]).toMatchObject({ key: 'ply.usage.note', reason: 'default', variant: { kind: 'boolean', value: false } });
  });
});

describe('in-worker gate', () => {
  it('stays off when the binding is missing, and on for an allow-listed unit', async () => {
    expect(await isEnabled({}, undefined, 'ply.usage.note', { id: 'anonymous' })).toBe(false);
    expect(await usageNote({}, undefined, null)).toBeNull();
    const store = memoryStore();
    const created = await setRollout(store, { invalidate: async () => ({ kind: 'ok' }) }, 'ply.usage.note', 0, ABSENT_REVISION);
    if (created.kind !== 'ok') throw new Error(created.kind);
    const { setTargeting } = await import('../../src/flags/api.ts');
    const targeted = await setTargeting(store, { invalidate: async () => ({ kind: 'ok' }) }, 'ply.usage.note', { allow: ['anonymous'], deny: [], rules: [] }, created.revision);
    expect(targeted.kind).toBe('ok');
    const cache = {
      async fetch(request: Request) {
        const response = await serveFlags(request, env, store);
        response.headers.set('cf-cache-status', 'HIT');
        return response;
      },
    };
    const on = await isEnabled(env, { exports: { FlagsCache: cache } }, 'ply.usage.note', { id: 'anonymous' });
    expect(on).toBe(true);
    const note = await usageNote(env, { exports: { FlagsCache: cache } }, null);
    expect(note).toBe('ply.usage.note is on for this unit.');
    const loaded = await loadRuleset(env, cache);
    expect(loaded.kind).toBe('ready');
  });
});

describe('resolve timing', () => {
  it('measures the cache await and leaves the pure eval at 0 when the clock only moves on I/O', async () => {
    const { store } = await seeded();
    let now = 0;
    const clock = () => now;
    const spans: string[] = [];
    let spanOpenDuringFetch = false;
    const cache = {
      async fetch(request: Request) {
        expect(request.method).toBe('GET');
        spanOpenDuringFetch = spans.includes('flags.eval') && !spans.includes('flags.eval:end');
        now += 12.5;
        const response = await serveFlags(request, env, store);
        response.headers.set('cf-cache-status', 'MISS');
        return response;
      },
    };
    const tracing = {
      enterSpan(name: string) {
        spans.push(name);
        return { setAttribute() {}, end() { spans.push(`${name}:end`); } };
      },
    };
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)); });
    try {
      const resolved = await resolveFlags(
        { env, cache, tracing },
        { id: 'user:smoke', attributes: {} },
        ['ply.usage.note'],
        clock,
      );
      expect(resolved.kind).toBe('ok');
    } finally {
      spy.mockRestore();
    }
    expect(spanOpenDuringFetch).toBe(true);
    expect(spans[0]).toBe('flags.eval');
    const evalLine = lines.map(line => JSON.parse(line) as { msg?: string; resolve_ms?: number; eval_ms?: number }).find(row => row.msg === 'flags.eval');
    expect(evalLine?.resolve_ms).toBe(12.5);
    expect(evalLine?.eval_ms).toBe(0);
    expect(spans.indexOf('flags.resolve')).toBeGreaterThan(spans.indexOf('flags.eval'));
    expect(spans.indexOf('flags.resolve:end')).toBeLessThan(spans.indexOf('flags.eval:end'));
  });
});
