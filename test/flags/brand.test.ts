import { describe, expect, it } from 'vitest';
import { parseFlagKey, parseUnitId } from '../../src/flags/brand.ts';
import { parseUnit } from '../../src/flags/document.ts';
import { setRollout } from '../../src/flags/api.ts';
import { memoryStore } from '../../src/flags/store.ts';
import { serveFlags } from '../../src/flags/cache.ts';
import { handleFlagHttp } from '../../src/flags/http.ts';
import { ABSENT_REVISION, FLAGS_MAX_AGE_S, FLAGS_SWR_S } from '../../src/flags/ttl.ts';
import { parseBearer, parseIfNoneMatch, readHeader } from '../../src/http/inbound.ts';

const OPERATOR_BEARER = /^Bearer\s+(\S+)$/i;
const WORKER_BEARER = /^Bearer\s+(.+)$/i;

describe('branded flag boundary', () => {
  it('parses a flag key and a unit once', () => {
    expect(parseFlagKey('ply.usage.note')).toMatchObject({ kind: 'key', value: 'ply.usage.note' });
    expect(parseFlagKey('Nope').kind).toBe('invalid');
    expect(parseUnitId('user:smoke')).toMatchObject({ kind: 'id', value: 'user:smoke' });
    const absent = parseUnit('anonymous', { kind: 'absent' });
    expect(absent).toMatchObject({ kind: 'ok', id: 'anonymous', attributes: {} });
    const present = parseUnit('anonymous', { kind: 'present', value: { plan: 'pro' } });
    expect(present).toMatchObject({ kind: 'ok', attributes: { plan: 'pro' } });
    expect(parseUnit('anonymous', { kind: 'present', value: { plan: 'has space' } }).kind).toBe('invalid');
  });

  it('rejects a bad flag key before writing the ruleset', async () => {
    const store = memoryStore();
    const result = await setRollout(store, { invalidate: async () => ({ kind: 'ok' }) }, 'Nope', 0, ABSENT_REVISION);
    expect(result).toMatchObject({ kind: 'invalid', revision: null });
    expect(store.snapshot()).toBeNull();
  });

  it('rejects an eval key in the request body', async () => {
    const response = await handleFlagHttp(new Request('https://ply.example/v1/flags/eval', {
      method: 'POST',
      body: JSON.stringify({ unit: 'anonymous', keys: ['Nope'] }),
    }), {}, {});
    expect(response.status).toBe(400);
    const body = await response.json() as { message: string };
    expect(body.message).toBe('flag key is not valid');
  });
});

describe('inbound headers', () => {
  it('parses a bearer and treats a missing header as absent', () => {
    const headers = new Headers({ authorization: 'Bearer secret' });
    expect(parseBearer(readHeader(headers, 'authorization'), OPERATOR_BEARER)).toMatchObject({ kind: 'bearer', token: 'secret' });
    expect(parseBearer(readHeader(new Headers(), 'authorization'), WORKER_BEARER).kind).toBe('absent');
    expect(parseBearer(readHeader(new Headers({ authorization: 'Bearer token extra' }), 'authorization'), OPERATOR_BEARER).kind).toBe('absent');
    expect(parseBearer(readHeader(new Headers({ authorization: 'Bearer token extra' }), 'authorization'), WORKER_BEARER)).toMatchObject({ kind: 'bearer', token: 'token extra' });
  });

  it('parses If-None-Match into any or tag, and a star still answers 304', async () => {
    expect(parseIfNoneMatch({ kind: 'absent' })).toEqual({ kind: 'absent' });
    expect(parseIfNoneMatch({ kind: 'present', value: ' *, "abc"' })).toEqual({
      kind: 'present',
      tokens: [{ kind: 'any' }, { kind: 'tag', value: '"abc"' }],
    });
    const store = memoryStore();
    const written = await setRollout(store, { invalidate: async () => ({ kind: 'ok' }) }, 'ply.usage.note', 0, ABSENT_REVISION);
    if (written.kind !== 'ok') throw new Error(written.kind);
    const env = { FLAGS: { present: true }, FLAGS_MAX_AGE_S: String(FLAGS_MAX_AGE_S), FLAGS_SWR_S: String(FLAGS_SWR_S) };
    const again = await serveFlags(new Request('https://flags.internal/config', { headers: { 'if-none-match': '*' } }), env, store);
    expect(again.status).toBe(304);
  });
});
