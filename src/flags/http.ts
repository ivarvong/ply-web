// Read and eval over HTTP. Writes are FlagControl RPC, so PUT/POST of a ruleset is 405.
// parse, then authorize, then execute each return a Result. json() is the only status mapping.
import { loadRuleset, type FlagCacheEnv, type FlagsCacheBinding } from './cache.ts';
import { resolveFlags } from './client.ts';
import { parseUnit, type AttributeInput } from './document.ts';
import { parseFlagKey, type AttributeName, type AttributeValue, type FlagKey, type UnitId } from './brand.ts';
import { headerNumber, jsonField, jsonRecord, readHeader } from '../http/inbound.ts';
import { err, isUnexpected, ok, runRequest, type Result, type UnexpectedFailure } from '../http/machine.ts';
import type { TracingLike } from './telemetry.ts';
import { variantKind, variantValue, type FlagEvaluation, type FlagSelection } from './types.ts';

const NO_STORE = 'no-store';
const MAX_BODY = 64 * 1024;

type FlagCtx = { exports?: { FlagsCache?: FlagsCacheBinding }; tracing?: TracingLike | null };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': NO_STORE } });
}

function view(evaluation: FlagEvaluation) {
  return {
    key: evaluation.key,
    variant: evaluation.variant,
    variantKind: variantKind(evaluation.variant),
    variantValue: variantValue(evaluation.variant),
    reason: evaluation.reason,
    bucket: evaluation.bucket,
  };
}

async function readBody(request: Request): Promise<{ readonly kind: 'ok'; readonly value: Record<string, unknown> } | { readonly kind: 'invalid'; readonly reason: string }> {
  const length = headerNumber(readHeader(request.headers, 'content-length'));
  if (Number.isFinite(length) && length > MAX_BODY) return { kind: 'invalid', reason: 'flag eval body is over 64 KiB' };
  const text = await request.text();
  if (text.length > MAX_BODY) return { kind: 'invalid', reason: 'flag eval body is over 64 KiB' };
  if (!text.trim()) return { kind: 'invalid', reason: 'flag eval body is required' };
  try {
    const value = JSON.parse(text) as unknown;
    const record = jsonRecord(value);
    if (record.kind !== 'record') return { kind: 'invalid', reason: 'flag eval body must be an object' };
    return { kind: 'ok', value: record.value };
  } catch {
    return { kind: 'invalid', reason: 'flag eval body must be JSON' };
  }
}

type FlagRoute =
  | { readonly kind: 'rules' }
  | { readonly kind: 'eval'; readonly id: UnitId; readonly attributes: Readonly<Record<AttributeName, AttributeValue>>; readonly keys: FlagSelection };

type FlagBody = { readonly status: number; readonly body: unknown };

type FlagFailure = { readonly kind: 'bad_request' | 'unsupported' | 'not_found' | 'unavailable'; readonly status: number; readonly body: unknown };

function flagFailure(kind: FlagFailure['kind'], status: number, message: string, retry: 'yes' | 'no'): Result<never, FlagFailure> {
  return err({ kind, status, body: { code: kind, message, retry } });
}

async function parseFlagRoute(request: Request): Promise<Result<FlagRoute, FlagFailure>> {
  const url = new URL(request.url);
  if (url.pathname === '/v1/flags' && request.method === 'GET') return ok({ kind: 'rules' });
  if (url.pathname === '/v1/flags' || url.pathname === '/v1/flags/eval') {
    if (request.method !== 'POST' || url.pathname !== '/v1/flags/eval') {
      return flagFailure('unsupported', 405, 'flag writes are FlagControl RPC (setRollout, setTargeting) via ply-flag-operator (scripts/flags), not HTTP', 'no');
    }
  } else {
    return flagFailure('not_found', 404, 'no flag route', 'no');
  }
  const body = await readBody(request);
  if (body.kind === 'invalid') return flagFailure('bad_request', 400, body.reason, 'no');
  const unitField = jsonField(body.value, 'unit');
  if (unitField.kind !== 'present' || typeof unitField.value !== 'string') return flagFailure('bad_request', 400, 'unit is required', 'no');
  const attributesField = jsonField(body.value, 'attributes');
  let attributes: AttributeInput = { kind: 'absent' };
  if (attributesField.kind === 'present') {
    const record = jsonRecord(attributesField.value);
    if (record.kind !== 'record') return flagFailure('bad_request', 400, 'attributes must be an object', 'no');
    attributes = { kind: 'present', value: record.value };
  }
  const parsed = parseUnit(unitField.value, attributes);
  if (parsed.kind === 'invalid') return flagFailure('bad_request', 400, parsed.reason, 'no');
  const keysField = jsonField(body.value, 'keys');
  let keys: FlagSelection = { kind: 'all' };
  if (keysField.kind === 'present') {
    const listed = keysField.value;
    if (!Array.isArray(listed) || listed.some(item => typeof item !== 'string')) {
      return flagFailure('bad_request', 400, 'keys must be an array of flag names', 'no');
    }
    const values: FlagKey[] = [];
    for (const item of listed) {
      if (typeof item !== 'string') return flagFailure('bad_request', 400, 'keys must be an array of flag names', 'no');
      const key = parseFlagKey(item);
      if (key.kind !== 'key') return flagFailure('bad_request', 400, 'flag key is not valid', 'no');
      values.push(key.value);
    }
    keys = { kind: 'listed', keys: values };
  }
  return ok({ kind: 'eval', id: parsed.id, attributes: parsed.attributes, keys });
}

export async function handleFlagHttp(request: Request, env: FlagCacheEnv, ctx: FlagCtx): Promise<Response> {
  return runRequest(
    {
      parse: () => parseFlagRoute(request),
      authorize: (route: FlagRoute) => {
        if (!env.FLAGS) return flagFailure('unavailable', 503, 'FLAGS binding is not configured', 'yes');
        return ok(route);
      },
      execute: (route: FlagRoute) => executeFlag(route, env, ctx),
    },
    result => flagResponse(result),
  );
}

async function executeFlag(route: FlagRoute, env: FlagCacheEnv, ctx: FlagCtx): Promise<Result<FlagBody, FlagFailure>> {
  if (route.kind === 'rules') {
    const loaded = await loadRuleset(env, ctx.exports?.FlagsCache ?? null);
    if (loaded.kind === 'unavailable') return flagFailure('unavailable', 503, loaded.reason, 'yes');
    if (loaded.kind === 'absent') return flagFailure('not_found', 404, 'no flag config', 'no');
    return ok({ status: 200, body: { revision: loaded.revision, cache: loaded.cache, environment: loaded.document.environment, flags: loaded.document.flags } });
  }
  const resolved = await resolveFlags(
    { env, cache: ctx.exports?.FlagsCache ?? null, tracing: ctx.tracing ?? null },
    { id: route.id, attributes: route.attributes },
    route.keys,
  );
  if (resolved.kind === 'unavailable') return flagFailure('unavailable', 503, resolved.reason, 'yes');
  return ok({ status: 200, body: { revision: resolved.revision, cache: resolved.cache, flags: resolved.evaluations.map(view) } });
}

function flagResponse(result: Result<FlagBody, FlagFailure | UnexpectedFailure>): Response {
  if (!result.ok) {
    if (isUnexpected(result.error)) {
      console.log(JSON.stringify({ msg: 'ply.flags', error_kind: result.error.kind, stage: result.error.stage, error_name: result.error.name }));
      return json(500, { code: 'internal', message: 'The request hit an unexpected error.', retry: 'no' });
    }
    return json(result.error.status, result.error.body);
  }
  return json(result.value.status, result.value.body);
}
