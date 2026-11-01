// Read and eval over HTTP. Writes are FlagControl RPC, so PUT/POST of a ruleset is 405.
// parse, then authorize, then execute each return a Result. json() is the only status mapping.
import { loadRuleset, type FlagCacheEnv, type FlagsCacheBinding } from './cache.ts';
import { resolveFlags } from './client.ts';
import { parseUnit } from './document.ts';
import { err, isUnexpected, ok, runRequest, type Result, type UnexpectedFailure } from '../http/machine.ts';
import type { TracingLike } from './telemetry.ts';
import { variantKind, variantValue, type FlagEvaluation } from './types.ts';

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
  const length = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY) return { kind: 'invalid', reason: 'flag eval body is over 64 KiB' };
  const text = await request.text();
  if (text.length > MAX_BODY) return { kind: 'invalid', reason: 'flag eval body is over 64 KiB' };
  if (!text.trim()) return { kind: 'invalid', reason: 'flag eval body is required' };
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid', reason: 'flag eval body must be an object' };
    return { kind: 'ok', value: value as Record<string, unknown> };
  } catch {
    return { kind: 'invalid', reason: 'flag eval body must be JSON' };
  }
}

type FlagRoute =
  | { readonly kind: 'rules' }
  | { readonly kind: 'eval'; readonly id: string; readonly attributes: Readonly<Record<string, string>>; readonly keys: readonly string[] | null };

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
  const unit = body.value.unit;
  if (typeof unit !== 'string') return flagFailure('bad_request', 400, 'unit is required', 'no');
  const attributes = body.value.attributes;
  if (attributes !== undefined && (!attributes || typeof attributes !== 'object' || Array.isArray(attributes))) {
    return flagFailure('bad_request', 400, 'attributes must be an object', 'no');
  }
  const parsed = parseUnit(unit, attributes as Readonly<Record<string, string>> | undefined);
  if (parsed.kind === 'invalid') return flagFailure('bad_request', 400, parsed.reason, 'no');
  let keys: string[] | null = null;
  if (body.value.keys !== undefined) {
    if (!Array.isArray(body.value.keys) || body.value.keys.some(key => typeof key !== 'string')) {
      return flagFailure('bad_request', 400, 'keys must be an array of flag names', 'no');
    }
    keys = body.value.keys;
  }
  if (keys) {
    for (const key of keys) {
      if (!/^[a-z][a-z0-9._-]{0,63}$/.test(key)) return flagFailure('bad_request', 400, 'flag key is not valid', 'no');
    }
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
