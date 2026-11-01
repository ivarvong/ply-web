// Judges the flag smoke steps. No import of judge.ts or lifecycle.ts: those import this file.
import { parseDocument } from '../../src/flags/document.ts'
import { evaluateDocument } from '../../src/flags/eval.ts'
import { BUCKETS, USAGE_NOTE_FLAG, USAGE_NOTE_LINE } from '../../src/flags/ttl.ts'
import { EMPTY_DOCUMENT, variantKind, variantValue, type FlagDocument, type Variant } from '../../src/flags/types.ts'

/** Unit the eval smoke sends. GET / uses anonymous and is checked separately. */
export const SMOKE_UNIT_ID = 'user:smoke'

/** Flag the eval smoke asks for, and the line GET / must not contain while that flag is off. */
export const SMOKE_FLAG_KEY = USAGE_NOTE_FLAG

/** Saved JSON snapshot from GET /v1/flags, consumed by the eval step. */
export const FLAGS_RULES_SAVE = 'flagsRules'

export const HTTP_OK = 200
export const HTTP_BAD_REQUEST = 400
export const HTTP_UNAUTHORIZED = 401
export const HTTP_NOT_FOUND = 404
export const HTTP_METHOD_NOT_ALLOWED = 405

export const NO_STORE = 'no-store'

/** GET / starts with this mark. The usage note is a separate line and must be absent. */
export const USAGE_MARK = 'ply —'

const SMOKE_CACHES = ['HIT', 'MISS', 'STALE', 'UPDATING'] as const

export type FlagHeaders = {
  readonly cacheControl: string | null
  readonly contentType: string | null
}

export type FlagJudgement =
  | { readonly kind: 'skip' }
  | { readonly kind: 'fail'; readonly detail: string }
  | { readonly kind: 'ok'; readonly detail: string; readonly save: Readonly<Record<string, string>> }

type Obj = Record<string, unknown>

type RulesSnapshot =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly revision: string; readonly document: FlagDocument }

function fail(detail: string): FlagJudgement {
  return { kind: 'fail', detail }
}

function ok(save: Readonly<Record<string, string>> = {}): FlagJudgement {
  return { kind: 'ok', detail: 'ok', save }
}

function isObj(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cacheOk(value: unknown): boolean {
  return typeof value === 'string' && (SMOKE_CACHES as readonly string[]).includes(value)
}

type ParsedJson = { readonly ok: true; readonly value: Obj } | { readonly ok: false; readonly reason: string }

function jsonObject(text: string): ParsedJson {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!isObj(parsed)) return { ok: false, reason: 'response is not a JSON object' }
    return { ok: true, value: parsed }
  } catch {
    return { ok: false, reason: 'response is not JSON' }
  }
}

function judgeUsage(status: number, bodyText: string, headers: FlagHeaders): FlagJudgement {
  if (status !== HTTP_OK) return fail(`status ${status}, wanted ${HTTP_OK}`)
  const type = headers.contentType ?? ''
  if (!type.startsWith('text/plain')) return fail(`content-type ${type || 'missing'}, wanted text/plain`)
  if (!bodyText.includes(USAGE_MARK)) return fail('GET / is not the usage text')
  if (bodyText.includes(USAGE_NOTE_LINE)) return fail('usage note is present while ply.usage.note is off')
  return ok()
}

function judgeRules(status: number, bodyText: string): FlagJudgement {
  const parsedBody = jsonObject(bodyText)
  if (!parsedBody.ok) return fail(parsedBody.reason)
  const parsed = parsedBody.value
  if (status === HTTP_NOT_FOUND) {
    if (parsed.code !== 'not_found') return fail(`code ${String(parsed.code)}, wanted not_found`)
    if (parsed.message !== 'no flag config') return fail(`message ${JSON.stringify(parsed.message)}, wanted "no flag config"`)
    return ok({ [FLAGS_RULES_SAVE]: JSON.stringify({ kind: 'absent' }) })
  }
  if (status !== HTTP_OK) return fail(`status ${status}, wanted ${HTTP_OK} or ${HTTP_NOT_FOUND}`)
  if (typeof parsed.revision !== 'string' || parsed.revision.length === 0) return fail('revision is not a string')
  if (!cacheOk(parsed.cache)) return fail(`cache ${JSON.stringify(parsed.cache)}, wanted HIT, MISS, STALE, or UPDATING`)
  if (typeof parsed.environment !== 'string') return fail('environment is missing')
  if (!Array.isArray(parsed.flags)) return fail('flags is not an array')
  const document = parseDocument({ environment: parsed.environment, flags: parsed.flags })
  if (document.kind === 'invalid') return fail(document.reason)
  return ok({
    [FLAGS_RULES_SAVE]: JSON.stringify({
      kind: 'present',
      revision: parsed.revision,
      environment: parsed.environment,
      flags: parsed.flags,
    }),
  })
}

function loadSnapshot(saved: Readonly<Record<string, string>>): RulesSnapshot | { readonly kind: 'invalid'; readonly reason: string } {
  const raw = saved[FLAGS_RULES_SAVE]
  if (!raw) return { kind: 'invalid', reason: 'saved flagsRules is missing' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { kind: 'invalid', reason: 'saved flagsRules is not JSON' }
  }
  if (!isObj(parsed)) return { kind: 'invalid', reason: 'saved flagsRules is not an object' }
  if (parsed.kind === 'absent') return { kind: 'absent' }
  if (parsed.kind !== 'present') return { kind: 'invalid', reason: 'saved flagsRules kind is not present or absent' }
  if (typeof parsed.revision !== 'string' || parsed.revision.length === 0) return { kind: 'invalid', reason: 'saved revision is missing' }
  const document = parseDocument({ environment: parsed.environment, flags: parsed.flags })
  if (document.kind === 'invalid') return document
  return { kind: 'present', revision: parsed.revision, document: document.document }
}

function sameVariant(got: unknown, want: Variant): boolean {
  return isObj(got) && got.kind === want.kind && got.value === want.value
}

function judgeEval(status: number, bodyText: string, headers: FlagHeaders, saved: Readonly<Record<string, string>>): FlagJudgement {
  if (status !== HTTP_OK) return fail(`status ${status}, wanted ${HTTP_OK}`)
  if (headers.cacheControl !== NO_STORE) return fail(`cache-control ${headers.cacheControl ?? 'missing'}, wanted ${NO_STORE}`)
  const snapshot = loadSnapshot(saved)
  if (snapshot.kind === 'invalid') return fail(snapshot.reason)
  const parsedBody = jsonObject(bodyText)
  if (!parsedBody.ok) return fail(parsedBody.reason)
  const parsed = parsedBody.value
  const expectedRevision = snapshot.kind === 'present' ? snapshot.revision : null
  if (parsed.revision !== expectedRevision) return fail(`revision ${JSON.stringify(parsed.revision)}, wanted ${JSON.stringify(expectedRevision)}`)
  if (!Array.isArray(parsed.flags)) return fail('flags is not an array')
  const row = parsed.flags.find(item => isObj(item) && item.key === SMOKE_FLAG_KEY)
  if (!isObj(row)) return fail(`eval is missing ${SMOKE_FLAG_KEY}`)
  const document = snapshot.kind === 'present' ? snapshot.document : EMPTY_DOCUMENT
  const expected = evaluateDocument(document, { id: SMOKE_UNIT_ID, attributes: {} }, [SMOKE_FLAG_KEY])[0]
  if (!expected) return fail(`no evaluation for ${SMOKE_FLAG_KEY}`)
  if (expected.variant.kind !== 'boolean') return fail('rollout variant is not boolean')
  if (!sameVariant(row.variant, expected.variant)) return fail(`variant ${JSON.stringify(row.variant)} does not match the rollout`)
  if (row.variantKind !== variantKind(expected.variant)) return fail(`variantKind ${JSON.stringify(row.variantKind)}, wanted boolean`)
  if (row.variantValue !== variantValue(expected.variant)) return fail(`variantValue ${JSON.stringify(row.variantValue)} does not match the rollout`)
  if (row.reason !== expected.reason) return fail(`reason ${JSON.stringify(row.reason)}, wanted ${expected.reason}`)
  if (typeof row.bucket !== 'number' || !Number.isInteger(row.bucket) || row.bucket < 0 || row.bucket >= BUCKETS) {
    return fail(`bucket ${JSON.stringify(row.bucket)} is outside 0..${BUCKETS - 1}`)
  }
  if (row.bucket !== expected.bucket) return fail(`bucket ${JSON.stringify(row.bucket)}, wanted ${expected.bucket}`)
  return ok()
}

/** skip when the step is not a flag expect. Otherwise the body judgement and any ruleset snapshot to save. */
export function judgeFlagStep(
  kind: string,
  status: number,
  bodyText: string,
  headers: FlagHeaders,
  saved: Readonly<Record<string, string>>,
): FlagJudgement {
  if (kind === 'usage-off') return judgeUsage(status, bodyText, headers)
  if (kind === 'flags-rules') return judgeRules(status, bodyText)
  if (kind === 'flags-eval') return judgeEval(status, bodyText, headers, saved)
  return { kind: 'skip' }
}
