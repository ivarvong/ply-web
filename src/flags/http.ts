// Read and eval over HTTP. Writes are FlagControl RPC, so PUT/POST of a ruleset is 405.
import { loadRuleset, type FlagCacheEnv, type FlagsCacheBinding } from './cache.ts';
import { resolveFlags } from './client.ts';
import { parseUnit } from './document.ts';
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

export async function handleFlagHttp(request: Request, env: FlagCacheEnv, ctx: FlagCtx): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/v1/flags' && request.method === 'GET') return getRules(env, ctx);
  if (url.pathname === '/v1/flags/eval' && request.method === 'POST') return postEval(request, env, ctx);
  if (url.pathname === '/v1/flags' || url.pathname === '/v1/flags/eval') {
    return json(405, { code: 'unsupported', message: 'flag writes are FlagControl RPC (setRollout, setTargeting) via ply-flag-operator (scripts/flags), not HTTP', retry: 'no' });
  }
  return json(404, { code: 'not_found', message: 'no flag route', retry: 'no' });
}

async function getRules(env: FlagCacheEnv, ctx: FlagCtx): Promise<Response> {
  const loaded = await loadRuleset(env, ctx.exports?.FlagsCache ?? null);
  if (loaded.kind === 'unavailable') return json(503, { code: 'unavailable', message: loaded.reason, retry: 'yes' });
  if (loaded.kind === 'absent') return json(404, { code: 'not_found', message: 'no flag config', retry: 'no' });
  return json(200, { revision: loaded.revision, cache: loaded.cache, environment: loaded.document.environment, flags: loaded.document.flags });
}

async function postEval(request: Request, env: FlagCacheEnv, ctx: FlagCtx): Promise<Response> {
  const body = await readBody(request);
  if (body.kind === 'invalid') return json(400, { code: 'bad_request', message: body.reason, retry: 'no' });
  const unit = body.value.unit;
  if (typeof unit !== 'string') return json(400, { code: 'bad_request', message: 'unit is required', retry: 'no' });
  const attributes = body.value.attributes;
  if (attributes !== undefined && (!attributes || typeof attributes !== 'object' || Array.isArray(attributes))) {
    return json(400, { code: 'bad_request', message: 'attributes must be an object', retry: 'no' });
  }
  const parsed = parseUnit(unit, attributes as Readonly<Record<string, string>> | undefined);
  if (parsed.kind === 'invalid') return json(400, { code: 'bad_request', message: parsed.reason, retry: 'no' });
  let keys: string[] | null = null;
  if (body.value.keys !== undefined) {
    if (!Array.isArray(body.value.keys) || body.value.keys.some(key => typeof key !== 'string')) {
      return json(400, { code: 'bad_request', message: 'keys must be an array of flag names', retry: 'no' });
    }
    keys = body.value.keys;
  }
  if (keys) {
    for (const key of keys) {
      if (!/^[a-z][a-z0-9._-]{0,63}$/.test(key)) return json(400, { code: 'bad_request', message: 'flag key is not valid', retry: 'no' });
    }
  }
  if (!env.FLAGS) return json(503, { code: 'unavailable', message: 'FLAGS binding is not configured', retry: 'yes' });
  const resolved = await resolveFlags(
    { env, cache: ctx.exports?.FlagsCache ?? null, tracing: ctx.tracing ?? null },
    { id: parsed.id, attributes: parsed.attributes },
    keys,
  );
  if (resolved.kind === 'unavailable') return json(503, { code: 'unavailable', message: resolved.reason, retry: 'yes' });
  return json(200, { revision: resolved.revision, cache: resolved.cache, flags: resolved.evaluations.map(view) });
}
