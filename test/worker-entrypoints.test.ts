import assert from 'node:assert/strict'
import { test } from 'node:test'
import config, { entrypoints, namedEntrypoint } from '../cloudflare.config.ts'
import { FLAG_OPERATOR_MODE, FLAG_OPERATOR_WORKER, OPERATOR_CONTROL_BINDING, OPERATOR_TOKEN_BINDING } from '../src/flags/operator-names.ts'

/** Null and a missing value take the fallback. An empty string and 0 stay. */
function fill<T>(value: unknown, fallback: T): T {
  return value === null || value === void 0 ? fallback : value as T
}

/** One property. A null receiver and a missing key are holes. A stored null stays null. */
function slot(receiver: unknown, key: string): unknown {
  if (receiver === null || receiver === void 0) return void 0
  if (typeof receiver !== 'object' && typeof receiver !== 'function') return void 0
  return (receiver as Record<string, unknown>)[key]
}

test('a named entrypoint does not set cache.enabled false', () => {
  for (const [name, entry] of Object.entries(entrypoints)) {
    if (name === 'default') continue
    assert.notEqual(slot(entry.cache, 'enabled'), false, `${name} sets cache.enabled false, which the versions API rejects with 10375`)
  }
  assert.equal(slot(entrypoints.default.cache, 'enabled'), false)
  assert.equal('cache' in entrypoints.FlagControl, false)
  assert.equal(slot(entrypoints.GitCache.cache, 'enabled'), true)
  assert.equal(slot(entrypoints.Pinned.cache, 'enabled'), true)
  assert.equal(slot(entrypoints.FlagsCache.cache, 'enabled'), true)
})

type BindingShape = Partial<{ type: string; worker: string; exportName: string }>

type ResolvedWorker = Partial<{
  name: string
  entrypoint: string
  cache: Partial<{ enabled: boolean }>
  observability: Partial<{ traces: Partial<{ enabled: boolean }> }>
  env: Readonly<Record<string, BindingShape>>
}>

function resolvedWorker(mode: string | void, isPreview: boolean): ResolvedWorker {
  const selected = config({ isPreview, mode: mode as string })
  return fill(selected.worker, {})
}

test('only flag-operator mode selects the operator Worker', () => {
  for (const mode of [void 0, 'production', 'development', '']) {
    const ply = resolvedWorker(mode, false)
    assert.equal(ply.name, 'ply', fill(mode, 'un' + 'defined'))
    assert.equal(ply.entrypoint, 'src/index.js')
    assert.equal(slot(ply.env, OPERATOR_TOKEN_BINDING), void 0)
    assert.equal(slot(slot(ply.env, 'FLAGS'), 'type'), 'r2')
  }
  const operator = resolvedWorker(FLAG_OPERATOR_MODE, true)
  assert.equal(operator.name, FLAG_OPERATOR_WORKER)
  assert.equal(operator.entrypoint, 'src/flags/operator-entry.ts')
  assert.equal(slot(operator.cache, 'enabled'), false)
  assert.equal(slot(slot(operator.observability, 'traces'), 'enabled'), true)
  assert.equal(slot(slot(operator.env, OPERATOR_TOKEN_BINDING), 'type'), 'secret')
  const control = slot(operator.env, OPERATOR_CONTROL_BINDING)
  assert.equal(slot(control, 'type'), 'worker')
  assert.equal(slot(control, 'worker'), 'ply')
  assert.equal(slot(control, 'exportName'), 'FlagControl')
  assert.equal(slot(operator.env, 'FLAGS'), void 0)
})

test('cache.enabled false on a named entrypoint does not compile', () => {
  // @ts-expect-error named entrypoint cache.enabled false is API error 10375
  namedEntrypoint({ cache: { enabled: false } })
  assert.deepEqual(namedEntrypoint({}), {})
  assert.deepEqual(namedEntrypoint({ cache: { enabled: true } }), { cache: { enabled: true } })
})
