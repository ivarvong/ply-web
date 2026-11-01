import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ABSENT_REVISION, BASIS_POINTS } from '../../src/flags/ttl.ts';
import { EMPTY_DOCUMENT, type ReadResult, type WriteResult } from '../../src/flags/types.ts';
import {
  handleOperator,
  operatorEndpoint,
  parseFlagArgs,
  presentRevision,
  rpcRevision,
  type FlagControlBinding,
  type OperatorDeps,
  type OperatorEnv,
} from '../../src/flags/operator.ts';
import { readOperatorToken, runFlagsCli, writeOperatorTokenFile } from '../../scripts/flags-cli.ts';

const TOKEN = 'operator-test-token-value';
const ROLLED_BACK = 0;
const ADVANCE_MS = 4.25;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function deps(clock: () => number, lines: string[], order: string[]): OperatorDeps {
  return {
    clock,
    log: line => lines.push(line),
    tracing: {
      enterSpan(name: string) {
        order.push(`span:${name}`);
        return { setAttribute() {}, end() { order.push('end'); } };
      },
    },
  };
}

function request(path: string, method: string, token: string | null, body?: string): Request {
  const headers = new Headers();
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`https://operator.test${path}`, { method, headers, body });
}

function control(impl: Partial<FlagControlBinding> = {}): FlagControlBinding {
  return {
    async getConfig(): Promise<ReadResult> {
      throw new Error('getConfig was called');
    },
    async setRollout(): Promise<WriteResult> {
      throw new Error('setRollout was called');
    },
    async setTargeting(): Promise<WriteResult> {
      throw new Error('setTargeting was called');
    },
    ...impl,
  };
}

describe('operator http', () => {
  it('rejects anonymous and wrong bearers before any RPC or body read', async () => {
    let calls = 0;
    const env: OperatorEnv = { FLAG_OPERATOR_TOKEN: TOKEN, FLAG_CONTROL: control({ async setRollout() { calls += 1; return { kind: 'unavailable', reason: 'called' }; } }) };
    const lines: string[] = [];
    const missing = await handleOperator(request('/rollout', 'POST', null, '{'), env, deps(() => 0, lines, []));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ kind: 'unauthorized' });
    const wrong = await handleOperator(request('/config', 'GET', 'other-operator-token'), env, deps(() => 0, lines, []));
    expect(wrong.status).toBe(401);
    expect(calls).toBe(0);
    expect(lines.join('\n')).not.toContain(TOKEN);
    const logged = JSON.parse(lines[0] ?? '{}') as { msg?: string; operator_ms?: number; result?: string };
    expect(logged.msg).toBe('flags.operator');
    expect(logged.result).toBe('unauthorized');
    expect(logged.operator_ms).toBe(0);
  });

  it('fails closed when the secret or the binding is missing', async () => {
    const lines: string[] = [];
    const unconfigured = await handleOperator(request('/config', 'GET', TOKEN), {}, deps(() => 0, lines, []));
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ kind: 'unavailable', reason: 'FLAG_OPERATOR_TOKEN is not configured' });
    const unbound = await handleOperator(
      request('/rollout', 'POST', TOKEN, JSON.stringify({ flag: 'ply.usage.note', basisPoints: ROLLED_BACK, expected: { kind: 'absent' } })),
      { FLAG_OPERATOR_TOKEN: TOKEN },
      deps(() => 0, lines, []),
    );
    expect(unbound.status).toBe(503);
    const body = await unbound.json() as { reason?: string };
    expect(body.reason).toContain('FLAG_CONTROL');
  });

  it('seeds an absent ruleset with optimistic concurrency and times the RPC', async () => {
    let now = 0;
    const order: string[] = [];
    const lines: string[] = [];
    let seen: { flag?: string; basisPoints?: number; expected?: string } = {};
    const env: OperatorEnv = {
      FLAG_OPERATOR_TOKEN: TOKEN,
      FLAG_CONTROL: control({
        async setRollout(flag, basisPoints, expectedRevision) {
          order.push('rpc');
          seen = { flag, basisPoints, expected: expectedRevision };
          now += ADVANCE_MS;
          return { kind: 'ok', revision: '"rev"', config: EMPTY_DOCUMENT, unchanged: false, invalidated: true };
        },
      }),
    };
    const response = await handleOperator(
      request('/rollout', 'POST', TOKEN, JSON.stringify({ flag: 'ply.usage.note', basisPoints: ROLLED_BACK, expected: { kind: 'absent' } })),
      env,
      deps(() => now, lines, order),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(seen).toEqual({ flag: 'ply.usage.note', basisPoints: ROLLED_BACK, expected: ABSENT_REVISION });
    expect(order[0]).toBe('span:flags.operator');
    expect(order).toContain('rpc');
    expect(order.at(-1)).toBe('end');
    const logged = JSON.parse(lines[0] ?? '{}') as { op?: string; result?: string; operator_ms?: number; expected?: string; invalidated?: boolean };
    expect(logged).toMatchObject({ op: 'setRollout', result: 'ok', operator_ms: ADVANCE_MS, expected: 'absent', invalidated: true });
    expect(lines[0]).not.toContain(TOKEN);
  });

  it('returns 409 on a conflict and 503 without the thrown message', async () => {
    const conflictEnv: OperatorEnv = {
      FLAG_OPERATOR_TOKEN: TOKEN,
      FLAG_CONTROL: control({
        async setRollout() {
          return { kind: 'conflict', expected: ABSENT_REVISION, actual: '"other"' };
        },
      }),
    };
    const conflict = await handleOperator(
      request('/rollout', 'POST', TOKEN, JSON.stringify({ flag: 'ply.usage.note', basisPoints: ROLLED_BACK, expected: { kind: 'absent' } })),
      conflictEnv,
      deps(() => 0, [], []),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ kind: 'conflict', expected: ABSENT_REVISION, actual: '"other"' });
    const throwing: OperatorEnv = {
      FLAG_OPERATOR_TOKEN: TOKEN,
      FLAG_CONTROL: control({
        async getConfig() {
          throw new Error(`secret leak ${TOKEN}`);
        },
      }),
    };
    const lines: string[] = [];
    const failed = await handleOperator(request('/config', 'GET', TOKEN), throwing, deps(() => 0, lines, []));
    expect(failed.status).toBe(503);
    const text = await failed.text();
    expect(text).toContain('flag operator failed');
    expect(text).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('rejects a bad expectation before calling FlagControl', async () => {
    let calls = 0;
    const env: OperatorEnv = {
      FLAG_OPERATOR_TOKEN: TOKEN,
      FLAG_CONTROL: control({ async setRollout() { calls += 1; return { kind: 'unavailable', reason: 'called' }; } }),
    };
    const response = await handleOperator(
      request('/rollout', 'POST', TOKEN, JSON.stringify({ flag: 'ply.usage.note', basisPoints: ROLLED_BACK, expected: { kind: 'revision', value: '' } })),
      env,
      deps(() => 0, [], []),
    );
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
    const absent = presentRevision('');
    expect(absent).toBeNull();
    expect(rpcRevision({ kind: 'absent' })).toBe(ABSENT_REVISION);
    const present = presentRevision('"rev"');
    expect(present).toBe('"rev"');
    if (present) expect(rpcRevision({ kind: 'revision', value: present })).toBe('"rev"');
  });
});

describe('flags cli', () => {
  it('parses the seed command and refuses a token argument', () => {
    const parsed = parseFlagArgs(['rollout', 'ply.usage.note', '0', '--expected', 'absent', '--url', 'https://example.test']);
    expect(parsed).toEqual({
      kind: 'command',
      url: 'https://example.test',
      command: { kind: 'setRollout', flag: 'ply.usage.note', basisPoints: ROLLED_BACK, expected: { kind: 'absent' } },
    });
    expect(parseFlagArgs(['rollout', 'ply.usage.note', '0', '--token', TOKEN]).kind).toBe('error');
    expect(parseFlagArgs(['rollout', 'ply.usage.note', String(BASIS_POINTS + 1), '--expected', 'absent']).kind).toBe('error');
    expect(operatorEndpoint('https://user:secret@example.test', '/rollout')).toBeNull();
    expect(operatorEndpoint('https://example.test/ignored', '/config')).toBe('https://example.test/config');
  });

  it('requires mode 0600 and does not echo the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ply-flag-token-'));
    dirs.push(dir);
    const path = join(dir, 'token');
    await writeOperatorTokenFile(path, `${TOKEN}\n`, 0o644);
    await expect(readOperatorToken(path)).rejects.toThrow(/FLAG_OPERATOR_TOKEN_FILE/);
    await expect(readOperatorToken(path)).rejects.toThrow(/0600/);
    try {
      await readOperatorToken(path);
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
    await chmod(path, 0o600);
    expect((await readOperatorToken(path)).reveal()).toBe(TOKEN);
  });

  it('sends the bearer and prints a redacted body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ply-flag-cli-'));
    dirs.push(dir);
    const path = join(dir, 'token');
    await writeOperatorTokenFile(path, TOKEN, 0o600);
    const stdout: string[] = [];
    const stderr: string[] = [];
    let authorization = '';
    let body = '';
    const code = await runFlagsCli(
      ['rollout', 'ply.usage.note', '0', '--expected', 'absent', '--url', 'http://127.0.0.1:9'],
      { FLAG_OPERATOR_TOKEN_FILE: path },
      {
        async fetch(_url, init) {
          authorization = new Headers(init?.headers).get('authorization') ?? '';
          body = String(init?.body ?? '');
          return new Response(JSON.stringify({ kind: 'ok', revision: '"rev"', note: TOKEN }), { status: 200 });
        },
        stdout: line => stdout.push(line),
        stderr: line => stderr.push(line),
        readToken: readOperatorToken,
      },
    );
    expect(code).toBe(0);
    expect(authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(body)).toMatchObject({ flag: 'ply.usage.note', basisPoints: ROLLED_BACK, expected: { kind: 'absent' } });
    expect(stdout.join('')).toContain('[redacted]');
    expect(stdout.join('')).not.toContain(TOKEN);
    expect(stderr.join('')).not.toContain(TOKEN);
    const help: string[] = [];
    expect(await runFlagsCli([], {}, { fetch: async () => { throw new Error('fetch'); }, stdout: line => help.push(line), stderr: () => {}, readToken: readOperatorToken })).toBe(0);
    expect(help.join('')).toContain('rollout');
    let fetched = false;
    const missing = await runFlagsCli(['get'], {}, {
      fetch: async () => { fetched = true; return new Response('{}'); },
      stdout: () => {},
      stderr: () => {},
      readToken: readOperatorToken,
    });
    expect(missing).toBe(2);
    expect(fetched).toBe(false);
  });
});
