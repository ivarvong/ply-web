import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeCall, type CallHeaders, type Expect, type Saved } from '../scripts/cd/judge.ts'
import { expectedStatuses, lifecycle } from '../scripts/cd/lifecycle.ts'
import { FLAGS_RULES_SAVE, HTTP_NOT_FOUND, HTTP_OK, SMOKE_FLAG_KEY, SMOKE_UNIT_ID, USAGE_MARK } from '../scripts/cd/flags-smoke.ts'
import { parseUnit } from '../src/flags/document.ts'
import { evaluateDocument } from '../src/flags/eval.ts'
import { DEFAULT_SALT, USAGE_NOTE_FLAG, USAGE_NOTE_LINE } from '../src/flags/ttl.ts'
import { EMPTY_DOCUMENT, variantKind, variantValue, type Flag, type FlagSelection, type Unit } from '../src/flags/types.ts'

const BUILD = `ply=${'a'.repeat(40)} ply-web=${'b'.repeat(40)}`
const REQUEST_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function smokeUnit(): Unit {
  const parsed = parseUnit(SMOKE_UNIT_ID, { kind: 'absent' })
  if (parsed.kind !== 'ok') throw new Error(parsed.reason)
  return { id: parsed.id, attributes: parsed.attributes }
}

function smokeKeys(): FlagSelection {
  return { kind: 'listed', keys: [USAGE_NOTE_FLAG] }
}

const note: Flag = {
  key: SMOKE_FLAG_KEY,
  salt: DEFAULT_SALT,
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
  const evaluation = evaluateDocument(EMPTY_DOCUMENT, smokeUnit(), smokeKeys())[0]!
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
  const evaluation = evaluateDocument({ environment: 'production', flags: [note] }, smokeUnit(), smokeKeys())[0]!
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
  assert.equal(expired.kind, 'fail')
  const stored = judge({ kind: 'flags-eval' }, HTTP_OK, {
    revision: '"rev"',
    flags: [],
  }, listed.save, { cacheControl: 'public, max-age=5' })
  assert.equal(stored.kind, 'fail')
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
