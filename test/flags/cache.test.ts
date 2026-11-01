import { describe, expect, it } from 'vitest';
import { serveFlags, loadRuleset } from '../../src/flags/cache.ts';
import { memoryStore } from '../../src/flags/store.ts';
import { setRollout } from '../../src/flags/api.ts';
import { ABSENT_REVISION, FLAGS_CACHE_TAG, FLAGS_MAX_AGE_S, FLAGS_SWR_S, cacheControl } from '../../src/flags/ttl.ts';
import { handleFlagHttp } from '../../src/flags/http.ts';
import { isEnabled, usageNote } from '../../src/flags/client.ts';

const env = { FLAGS: { present: true }, FLAGS_MAX_AGE_S: String(FLAGS_MAX_AGE_S), FLAGS_SWR_S: String(FLAGS_SWR_S) };

async function seeded() {
  const store = memoryStore();
  const written = await setRollout(store, { invalidate: async () => ({ kind: 'ok' }) }, 'ply.usage.note', 0, ABSENT_REVISION);
  if (written.kind !== 'ok') throw new Error(written.kind);
  return { store, revision: written.revision };
}

describe('ruleset cache', () => {
  it('sets a short max-age, a long stale-while-revalidate, the revision etag, and one tag', async () => {
    const { store, revision } = await seeded();
    const response = await serveFlags(new Request('https://flags.internal/config'), env, store);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(cacheControl(FLAGS_MAX_AGE_S, FLAGS_SWR_S));
    expect(response.headers.get('cache-control')).not.toContain('s-maxage');
    expect(response.headers.get('cache-control')).not.toContain('must-revalidate');
    expect(response.headers.get('etag')).toBe(revision);
    expect(response.headers.get('cache-tag')).toBe(FLAGS_CACHE_TAG);
    const again = await serveFlags(new Request('https://flags.internal/config', { headers: { 'if-none-match': revision } }), env, store);
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(revision);
    expect(await again.text()).toBe('');
  });

  it('does not cache a missing ruleset', async () => {
    const response = await serveFlags(new Request('https://flags.internal/config'), env, memoryStore());
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
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
    expect(body.message).toContain('FlagsControl');
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
