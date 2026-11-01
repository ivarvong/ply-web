// Authenticated caller of FlagControl. ply's /v1/flags stays read-only.
// This module is the operator Worker's fetch handler and the CLI's command parser.
// It does not read the token file and it does not deploy.
import { headerNumber, parseBearer, readHeader } from '../http/inbound.ts';
import { err, isUnexpected, ok, runRequest, type Result, type UnexpectedFailure } from '../http/machine.ts';
import { roundMs, type Clock } from './clock.ts';
import { parseFlagKey } from './brand.ts';
import { applyBasisPoints, parseTargeting } from './document.ts';
import { endSpan, openSpan, type SpanLike, type TracingLike } from './telemetry.ts';
import {
  OPERATOR_CONFIG_PATH,
  OPERATOR_LOG,
  OPERATOR_ROLLOUT_PATH,
  OPERATOR_SPAN,
  OPERATOR_TARGETING_PATH,
} from './operator-names.ts';
import { ABSENT_REVISION, BASIS_POINTS, MAX_DOCUMENT_BYTES } from './ttl.ts';
import type { ReadResult, Targeting, WriteResult } from './types.ts';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;

const BEARER = /^Bearer\s+(\S+)$/i;
const NO_STORE = 'no-store';

declare const presentRevisionBrand: unique symbol;

/** A non-empty revision string. The absent ruleset is not this type. */
export type PresentRevision = string & { readonly [presentRevisionBrand]: 'PresentRevision' };

export type RevisionExpectation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'revision'; readonly value: PresentRevision };

export type OperatorCommand =
  | { readonly kind: 'getConfig' }
  | { readonly kind: 'setRollout'; readonly flag: string; readonly basisPoints: number; readonly expected: RevisionExpectation }
  | { readonly kind: 'setTargeting'; readonly flag: string; readonly targeting: Targeting; readonly expected: RevisionExpectation };

export type OperatorOpName = 'getConfig' | 'setRollout' | 'setTargeting' | 'reject';

export type OperatorResultKind =
  | 'ok'
  | 'absent'
  | 'conflict'
  | 'invalid'
  | 'unavailable'
  | 'unauthorized'
  | 'bad_request'
  | 'unexpected';

export type OperatorSample = {
  readonly op: OperatorOpName;
  readonly result: OperatorResultKind;
  readonly flag: string | null;
  readonly expected: 'absent' | 'revision' | null;
  readonly revision: string | null;
  readonly invalidated: boolean | null;
  readonly ms: number;
};

export type FlagControlBinding = {
  getConfig(): Promise<ReadResult>;
  setRollout(flag: string, basisPoints: number, expectedRevision: string): Promise<WriteResult>;
  setTargeting(flag: string, targeting: Targeting, expectedRevision: string): Promise<WriteResult>;
};

export type OperatorEnv = {
  FLAG_OPERATOR_TOKEN?: string;
  FLAG_CONTROL?: FlagControlBinding;
};

export type OperatorDeps = {
  readonly tracing: TracingLike | null;
  readonly clock: Clock;
  readonly log: (line: string) => void;
};

export type ParsedFlags =
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly reason: string }
  | { readonly kind: 'command'; readonly url: string | null; readonly command: OperatorCommand };

type Obj = Record<string, unknown>;

type Outcome = {
  readonly status: number;
  readonly body: unknown;
  readonly sample: Omit<OperatorSample, 'ms'>;
};

export function presentRevision(value: string): PresentRevision | null {
  if (value.length === 0) return null;
  return value as PresentRevision;
}

export function rpcRevision(expected: RevisionExpectation): string {
  return expected.kind === 'absent' ? ABSENT_REVISION : expected.value;
}

function isObj(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Obj, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && allowed.every(key => keys.includes(key));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': NO_STORE },
  });
}

type TimingEqual = { timingSafeEqual?(left: ArrayBuffer, right: ArrayBuffer): boolean };

/** SHA-256 digests are equal length. Workers exposes timingSafeEqual; Node unit tests do not. */
function timingSafeEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const subtle = crypto.subtle as SubtleCrypto & TimingEqual;
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(left, right);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function tokenEqual(presented: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(secret)),
  ]);
  return timingSafeEqual(left, right);
}

function bearer(request: Request): string | null {
  const parsed = parseBearer(readHeader(request.headers, 'authorization'), BEARER);
  if (parsed.kind !== 'bearer') return null;
  return parsed.token;
}

function sample(
  op: OperatorOpName,
  result: OperatorResultKind,
  flag: string | null,
  expected: 'absent' | 'revision' | null,
  revision: string | null,
  invalidated: boolean | null,
): Omit<OperatorSample, 'ms'> {
  return { op, result, flag, expected, revision, invalidated };
}

function reject(
  status: number,
  result: OperatorResultKind,
  reason: string | null,
  op: OperatorOpName,
  flag: string | null,
  expected: 'absent' | 'revision' | null,
): Outcome {
  const body = result === 'unauthorized'
    ? { kind: 'unauthorized' as const }
    : { kind: result, reason: reason ?? 'rejected' };
  return { status, body, sample: sample(op, result, flag, expected, null, null) };
}

function isInvalidTargeting(value: Targeting | { readonly kind: 'invalid'; readonly reason: string }): value is { readonly kind: 'invalid'; readonly reason: string } {
  return 'kind' in value;
}

function expectedKind(expected: RevisionExpectation): 'absent' | 'revision' {
  return expected.kind;
}

function fromRead(result: ReadResult): Outcome {
  if (result.kind === 'ok') {
    return { status: HTTP_OK, body: result, sample: sample('getConfig', 'ok', null, null, result.revision, null) };
  }
  if (result.kind === 'absent') {
    return { status: HTTP_OK, body: result, sample: sample('getConfig', 'absent', null, null, null, null) };
  }
  if (result.kind === 'invalid') {
    return { status: HTTP_BAD_REQUEST, body: result, sample: sample('getConfig', 'invalid', null, null, result.revision, null) };
  }
  return { status: HTTP_UNAVAILABLE, body: result, sample: sample('getConfig', 'unavailable', null, null, null, null) };
}

function fromWrite(op: 'setRollout' | 'setTargeting', flag: string, expected: RevisionExpectation, result: WriteResult): Outcome {
  const kind = expectedKind(expected);
  if (result.kind === 'ok') {
    return { status: HTTP_OK, body: result, sample: sample(op, 'ok', flag, kind, result.revision, result.invalidated) };
  }
  if (result.kind === 'conflict') {
    return { status: HTTP_CONFLICT, body: result, sample: sample(op, 'conflict', flag, kind, result.actual, null) };
  }
  if (result.kind === 'invalid') {
    return { status: HTTP_BAD_REQUEST, body: result, sample: sample(op, 'invalid', flag, kind, result.revision, null) };
  }
  return { status: HTTP_UNAVAILABLE, body: result, sample: sample(op, 'unavailable', flag, kind, null, null) };
}

export function parseExpectedValue(value: unknown): RevisionExpectation | { readonly kind: 'invalid'; readonly reason: string } {
  if (!isObj(value) || typeof value.kind !== 'string') {
    return { kind: 'invalid', reason: 'expected is {kind:"absent"} or {kind:"revision", value}' };
  }
  if (value.kind === 'absent') {
    if (!exactKeys(value, ['kind'])) return { kind: 'invalid', reason: 'absent expected is {kind:"absent"}' };
    return { kind: 'absent' };
  }
  if (value.kind === 'revision') {
    if (!exactKeys(value, ['kind', 'value']) || typeof value.value !== 'string') {
      return { kind: 'invalid', reason: 'revision expected is {kind:"revision", value}' };
    }
    const revision = presentRevision(value.value);
    if (!revision) return { kind: 'invalid', reason: 'revision expected needs a non-empty value; the first write is kind absent' };
    return { kind: 'revision', value: revision };
  }
  return { kind: 'invalid', reason: 'expected kind must be absent or revision' };
}

function bindingMissing(op: 'getConfig' | 'setRollout' | 'setTargeting', flag: string | null, expected: 'absent' | 'revision' | null): Outcome {
  return reject(HTTP_UNAVAILABLE, 'unavailable', 'FLAG_CONTROL binding is not configured', op, flag, expected);
}

async function readJson(request: Request): Promise<{ readonly kind: 'ok'; readonly value: Obj } | { readonly kind: 'invalid'; readonly reason: string }> {
  const length = headerNumber(readHeader(request.headers, 'content-length'));
  if (Number.isFinite(length) && length > MAX_DOCUMENT_BYTES) {
    return { kind: 'invalid', reason: `operator body is over ${MAX_DOCUMENT_BYTES} bytes` };
  }
  const text = await request.text();
  if (text.length > MAX_DOCUMENT_BYTES) return { kind: 'invalid', reason: `operator body is over ${MAX_DOCUMENT_BYTES} bytes` };
  if (!text.trim()) return { kind: 'invalid', reason: 'operator body is required' };
  try {
    const value = JSON.parse(text) as unknown;
    if (!isObj(value)) return { kind: 'invalid', reason: 'operator body must be an object' };
    return { kind: 'ok', value };
  } catch {
    return { kind: 'invalid', reason: 'operator body must be JSON' };
  }
}

type OperatorRoute =
  | { readonly kind: 'config' }
  | { readonly kind: 'rollout' }
  | { readonly kind: 'targeting' }
  | { readonly kind: 'method' }
  | { readonly kind: 'missing' };

function parseOperatorRoute(request: Request): Result<OperatorRoute, Outcome> {
  const url = new URL(request.url);
  const path = url.pathname;
  const known = path === OPERATOR_CONFIG_PATH || path === OPERATOR_ROLLOUT_PATH || path === OPERATOR_TARGETING_PATH;
  if (!known) return ok({ kind: 'missing' });
  if (path === OPERATOR_CONFIG_PATH && request.method === 'GET') return ok({ kind: 'config' });
  if (path === OPERATOR_ROLLOUT_PATH && request.method === 'POST') return ok({ kind: 'rollout' });
  if (path === OPERATOR_TARGETING_PATH && request.method === 'POST') return ok({ kind: 'targeting' });
  return ok({ kind: 'method' });
}

async function authorizeOperator(request: Request, env: OperatorEnv, route: OperatorRoute): Promise<Result<OperatorRoute, Outcome>> {
  const secret = env.FLAG_OPERATOR_TOKEN;
  if (!secret) return err(reject(HTTP_UNAVAILABLE, 'unavailable', 'FLAG_OPERATOR_TOKEN is not configured', 'reject', null, null));
  const presented = bearer(request);
  if (presented === null || !(await tokenEqual(presented, secret))) {
    return err(reject(HTTP_UNAUTHORIZED, 'unauthorized', null, 'reject', null, null));
  }
  return ok(route);
}

async function executeOperator(request: Request, env: OperatorEnv, route: OperatorRoute): Promise<Result<Outcome, Outcome>> {
  const control = env.FLAG_CONTROL;
  switch (route.kind) {
    case 'config':
      if (!control) return err(bindingMissing('getConfig', null, null));
      return ok(fromRead(await control.getConfig()));
    case 'rollout':
      return ok(await postRollout(request, control));
    case 'targeting':
      return ok(await postTargeting(request, control));
    case 'method':
      return err(reject(HTTP_METHOD_NOT_ALLOWED, 'bad_request', 'method not allowed', 'reject', null, null));
    case 'missing':
      return err(reject(HTTP_NOT_FOUND, 'bad_request', 'no operator route', 'reject', null, null));
    default:
      return assertOperatorRoute(route);
  }
}

function assertOperatorRoute(route: never): never {
  throw new Error(`unhandled operator route ${JSON.stringify(route)}`);
}

function unexpectedOutcome(): Outcome {
  return {
    status: HTTP_UNAVAILABLE,
    body: { kind: 'unavailable', reason: 'flag operator failed' },
    sample: sample('reject', 'unexpected', null, null, null, null),
  };
}

async function postRollout(request: Request, control: FlagControlBinding | undefined): Promise<Outcome> {
  const body = await readJson(request);
  if (body.kind === 'invalid') return reject(HTTP_BAD_REQUEST, 'bad_request', body.reason, 'setRollout', null, null);
  if (!exactKeys(body.value, ['flag', 'basisPoints', 'expected'])) {
    return reject(HTTP_BAD_REQUEST, 'bad_request', 'rollout body is {flag, basisPoints, expected}', 'setRollout', null, null);
  }
  const flag = body.value.flag;
  const basisPoints = body.value.basisPoints;
  if (typeof flag !== 'string' || typeof basisPoints !== 'number') {
    return reject(HTTP_BAD_REQUEST, 'bad_request', 'flag is a string and basisPoints is a number', 'setRollout', null, null);
  }
  const key = parseFlagKey(flag);
  if (key.kind !== 'key') return reject(HTTP_BAD_REQUEST, 'bad_request', key.reason, 'setRollout', flag, null);
  const points = applyBasisPoints(basisPoints);
  if (points.kind === 'invalid') return reject(HTTP_BAD_REQUEST, 'bad_request', points.reason, 'setRollout', flag, null);
  const expected = parseExpectedValue(body.value.expected);
  if (expected.kind === 'invalid') return reject(HTTP_BAD_REQUEST, 'bad_request', expected.reason, 'setRollout', flag, null);
  if (!control) return bindingMissing('setRollout', flag, expectedKind(expected));
  return fromWrite('setRollout', flag, expected, await control.setRollout(flag, basisPoints, rpcRevision(expected)));
}

async function postTargeting(request: Request, control: FlagControlBinding | undefined): Promise<Outcome> {
  const body = await readJson(request);
  if (body.kind === 'invalid') return reject(HTTP_BAD_REQUEST, 'bad_request', body.reason, 'setTargeting', null, null);
  if (!exactKeys(body.value, ['flag', 'targeting', 'expected'])) {
    return reject(HTTP_BAD_REQUEST, 'bad_request', 'targeting body is {flag, targeting, expected}', 'setTargeting', null, null);
  }
  const flag = body.value.flag;
  if (typeof flag !== 'string') return reject(HTTP_BAD_REQUEST, 'bad_request', 'flag is a string', 'setTargeting', null, null);
  const key = parseFlagKey(flag);
  if (key.kind !== 'key') return reject(HTTP_BAD_REQUEST, 'bad_request', key.reason, 'setTargeting', flag, null);
  const targeting = parseTargeting(body.value.targeting);
  if (isInvalidTargeting(targeting)) return reject(HTTP_BAD_REQUEST, 'bad_request', targeting.reason, 'setTargeting', flag, null);
  const expected = parseExpectedValue(body.value.expected);
  if (expected.kind === 'invalid') return reject(HTTP_BAD_REQUEST, 'bad_request', expected.reason, 'setTargeting', flag, null);
  if (!control) return bindingMissing('setTargeting', flag, expectedKind(expected));
  return fromWrite('setTargeting', flag, expected, await control.setTargeting(flag, targeting, rpcRevision(expected)));
}

function operatorLog(entry: OperatorSample): string {
  return JSON.stringify({
    msg: OPERATOR_LOG,
    op: entry.op,
    result: entry.result,
    flag: entry.flag,
    expected: entry.expected,
    revision: entry.revision,
    invalidated: entry.invalidated,
    operator_ms: entry.ms,
  });
}

function writeTelemetry(span: SpanLike | null, entry: OperatorSample, log: (line: string) => void): void {
  span?.setAttribute?.('flags.op', entry.op);
  span?.setAttribute?.('flags.result', entry.result);
  span?.setAttribute?.('flags.operator_ms', entry.ms);
  if (entry.flag !== null) span?.setAttribute?.('flags.key', entry.flag);
  if (entry.expected !== null) span?.setAttribute?.('flags.expected', entry.expected);
  if (entry.revision !== null) span?.setAttribute?.('flags.revision', entry.revision);
  if (entry.invalidated !== null) span?.setAttribute?.('flags.invalidated', entry.invalidated);
  log(operatorLog(entry));
}

export async function handleOperator(request: Request, env: OperatorEnv, deps: OperatorDeps): Promise<Response> {
  const started = deps.clock();
  let span: SpanLike | null = null;
  let spanClosed = false;
  const closeSpan = (): void => {
    if (spanClosed) return;
    spanClosed = true;
    endSpan(span);
  };
  return runRequest(
    {
      parse: () => {
        span = openSpan(deps.tracing, OPERATOR_SPAN);
        return parseOperatorRoute(request);
      },
      authorize: (route: OperatorRoute) => authorizeOperator(request, env, route),
      execute: (route: OperatorRoute) => executeOperator(request, env, route),
    },
    (result: Result<Outcome, Outcome | UnexpectedFailure>) => {
        const outcome = result.ok ? result.value : isUnexpected(result.error) ? unexpectedOutcome() : result.error;
      const ms = roundMs(deps.clock() - started);
      writeTelemetry(span, { ...outcome.sample, ms }, deps.log);
      closeSpan();
      return json(outcome.status, outcome.body);
    },
  );
}

const CLI_OPTIONS = ['--expected', '--url', '--allow', '--deny', '--rules'] as const;

function isOption(arg: string): arg is typeof CLI_OPTIONS[number] {
  return (CLI_OPTIONS as readonly string[]).includes(arg);
}

function option(argv: readonly string[], name: string): { readonly kind: 'missing' } | { readonly kind: 'ok'; readonly value: string } | { readonly kind: 'invalid' } {
  const index = argv.indexOf(name);
  if (index < 0) return { kind: 'missing' };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) return { kind: 'invalid' };
  return { kind: 'ok', value };
}

function flagKey(value: string): string | null {
  const parsed = parseFlagKey(value);
  return parsed.kind === 'key' ? parsed.value : null;
}

function basisArg(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  const applied = applyBasisPoints(parsed);
  return applied.kind === 'ok' ? parsed : null;
}

function splitList(value: string): readonly string[] {
  if (value.length === 0) return [];
  return value.split(',');
}

function unknownOption(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith('--') && !isOption(arg)) return arg;
  }
  return null;
}

function positionals(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (isOption(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith('--')) out.push(arg);
  }
  return out;
}

function expectedArg(argv: readonly string[]): RevisionExpectation | { readonly kind: 'invalid'; readonly reason: string } | { readonly kind: 'missing' } {
  const found = option(argv, '--expected');
  if (found.kind === 'missing') return { kind: 'missing' };
  if (found.kind === 'invalid') return { kind: 'invalid', reason: '--expected needs absent or a revision' };
  if (found.value === 'absent') return { kind: 'absent' };
  const revision = presentRevision(found.value);
  if (!revision) return { kind: 'invalid', reason: '--expected needs absent or a revision' };
  return { kind: 'revision', value: revision };
}

function urlArg(argv: readonly string[]): string | null | { readonly kind: 'invalid' } {
  const found = option(argv, '--url');
  if (found.kind === 'missing') return null;
  if (found.kind === 'invalid') return { kind: 'invalid' };
  return found.value;
}

export function commandRequest(command: OperatorCommand): { readonly method: 'GET' | 'POST'; readonly path: string; readonly body: Obj | null } {
  if (command.kind === 'getConfig') return { method: 'GET', path: OPERATOR_CONFIG_PATH, body: null };
  if (command.kind === 'setRollout') {
    return {
      method: 'POST',
      path: OPERATOR_ROLLOUT_PATH,
      body: { flag: command.flag, basisPoints: command.basisPoints, expected: command.expected },
    };
  }
  return {
    method: 'POST',
    path: OPERATOR_TARGETING_PATH,
    body: { flag: command.flag, targeting: command.targeting, expected: command.expected },
  };
}

export function operatorEndpoint(base: string, path: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** argv is process.argv without node and the script. The token is never an argument. */
export function parseFlagArgs(argv: readonly string[]): ParsedFlags {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  const unknown = unknownOption(argv);
  if (unknown) return { kind: 'error', reason: `${unknown} is not a flag argument; the token is read from a mode 0600 file` };
  const url = urlArg(argv);
  if (url !== null && typeof url !== 'string') return { kind: 'error', reason: '--url needs an origin' };
  const [name, ...rest] = positionals(argv);
  if (name === 'get') {
    if (rest.length !== 0) return { kind: 'error', reason: 'get takes no positional arguments' };
    return { kind: 'command', url, command: { kind: 'getConfig' } };
  }
  if (name === 'rollout') {
    const flag = rest[0];
    const points = rest[1];
    if (rest.length !== 2 || flag === undefined || points === undefined) {
      return { kind: 'error', reason: 'rollout needs <flag> <basisPoints>' };
    }
    if (!flagKey(flag)) return { kind: 'error', reason: 'flag key must match ^[a-z][a-z0-9._-]{0,63}$' };
    const basisPoints = basisArg(points);
    if (basisPoints === null) return { kind: 'error', reason: `basisPoints is an integer from 0 to ${BASIS_POINTS}` };
    const expected = expectedArg(argv);
    if (expected.kind === 'missing') return { kind: 'error', reason: '--expected is required (absent, or the revision from get)' };
    if (expected.kind === 'invalid') return { kind: 'error', reason: expected.reason };
    return { kind: 'command', url, command: { kind: 'setRollout', flag, basisPoints, expected } };
  }
  if (name === 'targeting') {
    const flag = rest[0];
    if (rest.length !== 1 || flag === undefined) return { kind: 'error', reason: 'targeting needs <flag>' };
    if (!flagKey(flag)) return { kind: 'error', reason: 'flag key must match ^[a-z][a-z0-9._-]{0,63}$' };
    const expected = expectedArg(argv);
    if (expected.kind === 'missing') return { kind: 'error', reason: '--expected is required (absent, or the revision from get)' };
    if (expected.kind === 'invalid') return { kind: 'error', reason: expected.reason };
    const allowOpt = option(argv, '--allow');
    const denyOpt = option(argv, '--deny');
    const rulesOpt = option(argv, '--rules');
    if (allowOpt.kind === 'invalid' || denyOpt.kind === 'invalid' || rulesOpt.kind === 'invalid') {
      return { kind: 'error', reason: '--allow, --deny, and --rules need a value' };
    }
    let rules: unknown = [];
    if (rulesOpt.kind === 'ok') {
      try {
        rules = JSON.parse(rulesOpt.value) as unknown;
      } catch {
        return { kind: 'error', reason: '--rules must be a JSON array' };
      }
    }
    const targeting = parseTargeting({
      allow: allowOpt.kind === 'ok' ? splitList(allowOpt.value) : [],
      deny: denyOpt.kind === 'ok' ? splitList(denyOpt.value) : [],
      rules,
    });
    if (isInvalidTargeting(targeting)) return { kind: 'error', reason: targeting.reason };
    return { kind: 'command', url, command: { kind: 'setTargeting', flag, targeting, expected } };
  }
  return { kind: 'error', reason: 'usage: flags get | rollout <flag> <basisPoints> --expected absent|<revision> | targeting <flag> --expected absent|<revision>' };
}
