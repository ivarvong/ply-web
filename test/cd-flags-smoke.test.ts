import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeCall, type CallHeaders, type Expect, type Saved } from '../scripts/cd/judge.ts'
import { expectedStatuses, lifecycle } from '../scripts/cd/lifecycle.ts'
import { FLAGS_RULES_SAVE, HTTP_NOT_FOUND, HTTP_OK, SMOKE_FLAG_KEY, SMOKE_UNIT_ID, USAGE_MARK } from '../scripts/cd/flags-smoke.ts'
import { setRollout } from '../src/flags/api.ts'
import { rulesetRequest, serveFlags } from '../src/flags/cache.ts'
import { handleFlagHttp } from '../src/flags/http.ts'
import { memoryStore } from '../src/flags/store.ts'
import { evaluateDocument } from '../src/flags/eval.ts'
import { ABSENT_REVISION, USAGE_NOTE_LINE } from '../src/flags/ttl.ts'
import { CACHE_STATUSES, EMPTY_DOCUMENT, variantKind, variantValue, type CacheStatus, type Flag } from '../src/flags/types.ts'

const BUILD = `ply=${'a'.repeat(40)} ply-web=${'b'.repeat(40)}`
const REQUEST_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const note: Flag = {
  key: SMOKE_FLAG_KEY,
  salt: 'v1',
  rollout: { kind: 'rolled-back', reason: 'basis points 0' },
  on: { kind: 'boolean', value: true },
  off: { kind: 'boolean', value: false },
  allow: [],
  deny: [],
  rules: [],
}

function headers(extra: Partial<CallHeaders> = {}): CallHeaders {
  return {
    requestId: REQUEST_ID,
    build: BUILD,
    version: null,
    ray: null,
    cacheControl: 'no-store',
    contentType: 'application/json; charset=utf-8',
    ...extra,
  }
}

function judge(expect: Expect, status: number, body: unknown, saved: Saved = {}, extra: Partial<CallHeaders> = {}) {
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body)
  return judgeCall({
    status,
    bodyText,
    headers: headers(extra),
    ray: 'absent',
    version: null,
    expect,
    secrets: [],
  }, saved)
}

test('flag smoke steps stay off Artifacts and cover the write methods', () => {
  const steps = lifecycle()
  const names = steps.map(step => step.name)
  assert.ok(names.indexOf('flags-unauth') < names.indexOf('ply-unauth'))
  const unauth = steps.find(step => step.name === 'flags-unauth')
  assert.equal(unauth?.ply, false)
  assert.equal(unauth?.git, false)
  assert.equal(unauth?.ray, 'absent')
  assert.deepEqual(expectedStatuses(steps.find(step => step.name === 'flags-rules')!), [HTTP_OK, HTTP_NOT_FOUND])
  assert.deepEqual(expectedStatuses(steps.find(step => step.name === 'flags-eval')!), [HTTP_OK])
  assert.deepEqual(expectedStatuses(steps.find(step => step.name === 'usage-off')!), [HTTP_OK])
  const evalStep = steps.find(step => step.name === 'flags-eval')
  assert.deepEqual(evalStep?.body?.({}), { unit: SMOKE_UNIT_ID, keys: [SMOKE_FLAG_KEY] })
  for (const name of ['flags-put', 'flags-post', 'flags-patch', 'flags-delete', 'flags-eval-get']) {
    const step = steps.find(item => item.name === name)
    assert.equal(step?.git, false)
    assert.equal(step?.expect.kind, 'code')
    if (step?.expect.kind === 'code') assert.equal(step.expect.code, 'unsupported')
    assert.deepEqual([...expectedStatuses(step!)], [405])
  }
  assert.equal(steps.find(step => step.name === 'usage-off')?.ply, false)
})

test('a missing ruleset is 404 and eval matches the empty rollout', () => {
  const rules = judge({ kind: 'flags-rules' }, HTTP_NOT_FOUND, { code: 'not_found', message: 'no flag config', retry: 'no' })
  assert.equal(rules.kind, 'ok')
  if (rules.kind !== 'ok') return
  assert.equal(rules.save[FLAGS_RULES_SAVE], JSON.stringify({ kind: 'absent' }))
  const evaluation = evaluateDocument(EMPTY_DOCUMENT, { id: SMOKE_UNIT_ID, attributes: {} }, [SMOKE_FLAG_KEY])[0]!
  const evald = judge({ kind: 'flags-eval' }, HTTP_OK, {
    revision: null,
    cache: 'MISS',
    flags: [{
      key: SMOKE_FLAG_KEY,
      variant: evaluation.variant,
      variantKind: variantKind(evaluation.variant),
      variantValue: variantValue(evaluation.variant),
      reason: evaluation.reason,
      bucket: evaluation.bucket,
    }],
  }, rules.save)
  assert.equal(evald.kind, 'ok', evald.kind === 'fail' ? evald.detail : '')
  const drifted = judge({ kind: 'flags-eval' }, HTTP_OK, {
    revision: null,
    cache: 'MISS',
    flags: [{
      key: SMOKE_FLAG_KEY,
      variant: { kind: 'boolean', value: true },
      variantKind: 'boolean',
      variantValue: 'true',
      reason: 'bucket',
      bucket: evaluation.bucket,
    }],
  }, rules.save)
  assert.equal(drifted.kind, 'fail')
})

test('a present ruleset keeps revision, cache status, and the rollout value', () => {
  const listed = judge({ kind: 'flags-rules' }, HTTP_OK, {
    revision: '"rev"',
    cache: 'HIT',
    environment: 'production',
    flags: [note],
  })
  assert.equal(listed.kind, 'ok')
  if (listed.kind !== 'ok') return
  const evaluation = evaluateDocument({ environment: 'production', flags: [note] }, { id: SMOKE_UNIT_ID, attributes: {} }, [SMOKE_FLAG_KEY])[0]!
  assert.equal(evaluation.variant.kind === 'boolean' && evaluation.variant.value, false)
  const evald = judge({ kind: 'flags-eval' }, HTTP_OK, {
    revision: '"rev"',
    cache: 'HIT',
    flags: [{
      key: SMOKE_FLAG_KEY,
      variant: evaluation.variant,
      variantKind: 'boolean',
      variantValue: 'false',
      reason: evaluation.reason,
      bucket: evaluation.bucket,
    }],
  }, listed.save, { cacheControl: 'no-store' })
  assert.equal(evald.kind, 'ok', evald.kind === 'fail' ? evald.detail : '')
  const stale = judge({ kind: 'flags-eval' }, HTTP_OK, {
    revision: '"other"',
    cache: 'HIT',
    flags: [{
      key: SMOKE_FLAG_KEY,
      variant: evaluation.variant,
      variantKind: 'boolean',
      variantValue: 'false',
      reason: evaluation.reason,
      bucket: evaluation.bucket,
    }],
  }, listed.save)
  assert.equal(stale.kind, 'fail')
  const expired = judge({ kind: 'flags-rules' }, HTTP_OK, {
    revision: '"rev"',
    cache: 'EXPIRED',
    environment: 'production',
    flags: [note],
  })
  assert.equal(expired.kind, 'ok', expired.kind === 'fail' ? expired.detail : '')
  const stored = judge({ kind: 'flags-eval' }, HTTP_OK, {
    revision: '"rev"',
    flags: [],
  }, listed.save, { cacheControl: 'public, max-age=5' })
  assert.equal(stored.kind, 'fail')
})

test('ruleset smoke names every Cache API status', () => {
  const accepted = new Set<CacheStatus>(['HIT', 'MISS', 'STALE', 'UPDATING', 'EXPIRED', 'REVALIDATED'])
  for (const status of CACHE_STATUSES) {
    const judged = judge({ kind: 'flags-rules' }, HTTP_OK, {
      revision: '"rev"',
      cache: status,
      environment: 'production',
      flags: [note],
    })
    assert.equal(judged.kind, accepted.has(status) ? 'ok' : 'fail', `${status} ${judged.kind === 'fail' ? judged.detail : ''}`)
  }
  const ignored = judge({ kind: 'flags-rules' }, HTTP_OK, {
    revision: '"rev"',
    cache: 'IGNORED',
    environment: 'production',
    flags: [note],
  })
  assert.equal(ignored.kind, 'fail')
  if (ignored.kind === 'fail') assert.match(ignored.detail, /not a Cache API status/)
})

test('a flag write then an immediate read is EXPIRED and the smoke rule accepts it', async () => {
  const store = memoryStore()
  // The empty ruleset is cached before the first seed. Invalidate marks that entry stale.
  // The next read runs the entrypoint, which answers 200 with the new body, so Workers Cache
  // reports EXPIRED (a 304 would be REVALIDATED).
  let phase: 'empty' | 'fresh' | 'invalidated' = 'empty'
  const cache = {
    invalidate() {
      if (phase === 'fresh') phase = 'invalidated'
      return { kind: 'ok' as const }
    },
    async fetch(request: Request) {
      const response = await serveFlags(request, { FLAGS: { present: true } }, store)
      const status: CacheStatus = phase === 'invalidated'
        ? (response.status === 304 ? 'REVALIDATED' : 'EXPIRED')
        : phase === 'empty' ? 'MISS' : 'HIT'
      if (phase === 'empty' || phase === 'invalidated') phase = 'fresh'
      response.headers.set('cf-cache-status', status)
      return response
    },
  }
  const warm = await cache.fetch(rulesetRequest())
  assert.equal(warm.status, 404)
  await warm.body?.cancel()
  const written = await setRollout(
    store,
    { invalidate: async () => cache.invalidate() },
    SMOKE_FLAG_KEY,
    0,
    ABSENT_REVISION,
  )
  assert.equal(written.kind, 'ok')
  if (written.kind !== 'ok') return
  assert.equal(written.invalidated, true)
  const response = await handleFlagHttp(
    new Request('https://ply.example/v1/flags'),
    { FLAGS: { present: true } },
    { exports: { FlagsCache: cache } },
  )
  assert.equal(response.status, HTTP_OK)
  const body: unknown = await response.json()
  assert.ok(body && typeof body === 'object')
  const listed = body as { cache?: unknown; revision?: unknown }
  assert.equal(listed.cache, 'EXPIRED')
  assert.equal(listed.revision, written.revision)
  const judged = judge({ kind: 'flags-rules' }, response.status, body)
  assert.equal(judged.kind, 'ok', judged.kind === 'fail' ? judged.detail : '')
})

test('GET / passes without the usage note and fails when the note is on', () => {
  const off = judge(
    { kind: 'usage-off' },
    HTTP_OK,
    `${USAGE_MARK} a git client\n`,
    {},
    { contentType: 'text/plain; charset=utf-8', cacheControl: 'no-store' },
  )
  assert.equal(off.kind, 'ok')
  const on = judge(
    { kind: 'usage-off' },
    HTTP_OK,
    `${USAGE_MARK} a git client\n${USAGE_NOTE_LINE}\n`,
    {},
    { contentType: 'text/plain; charset=utf-8' },
  )
  assert.equal(on.kind, 'fail')
})
