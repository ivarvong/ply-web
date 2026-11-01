import assert from 'node:assert/strict'
import { test } from 'node:test'
import config, { entrypoints, namedEntrypoint } from '../cloudflare.config.ts'
import { FLAG_OPERATOR_MODE, FLAG_OPERATOR_WORKER, OPERATOR_CONTROL_BINDING, OPERATOR_TOKEN_BINDING } from '../src/flags/operator-names.ts'

test('a named entrypoint does not set cache.enabled false', () => {
  for (const [name, entry] of Object.entries(entrypoints)) {
    if (name === 'default') continue
    assert.notEqual(entry.cache?.enabled, false, `${name} sets cache.enabled false, which the versions API rejects with 10375`)
  }
  assert.equal(entrypoints.default.cache?.enabled, false)
  assert.equal('cache' in entrypoints.FlagControl, false)
  assert.equal(entrypoints.GitCache.cache?.enabled, true)
  assert.equal(entrypoints.Pinned.cache?.enabled, true)
  assert.equal(entrypoints.FlagsCache.cache?.enabled, true)
})

type ResolvedWorker = {
  readonly name?: string
  readonly entrypoint?: string
  readonly cache?: { readonly enabled?: boolean }
  readonly observability?: { readonly traces?: { readonly enabled?: boolean } }
  readonly env?: Readonly<Record<string, { readonly type?: string; readonly worker?: string; readonly exportName?: string } | undefined>>
}

function resolvedWorker(mode: string | undefined, isPreview: boolean): ResolvedWorker {
  const selected = config({ isPreview, mode })
  return selected.worker ?? {}
}

test('only flag-operator mode selects the operator Worker', () => {
  for (const mode of [undefined, 'production', 'development', '']) {
    const ply = resolvedWorker(mode, false)
    assert.equal(ply.name, 'ply', mode ?? 'undefined')
    assert.equal(ply.entrypoint, 'src/index.js')
    assert.equal(ply.env?.[OPERATOR_TOKEN_BINDING], undefined)
    assert.equal(ply.env?.FLAGS?.type, 'r2')
  }
  const operator = resolvedWorker(FLAG_OPERATOR_MODE, true)
  assert.equal(operator.name, FLAG_OPERATOR_WORKER)
  assert.equal(operator.entrypoint, 'src/flags/operator-entry.ts')
  assert.equal(operator.cache?.enabled, false)
  assert.equal(operator.observability?.traces?.enabled, true)
  assert.equal(operator.env?.[OPERATOR_TOKEN_BINDING]?.type, 'secret')
  const control = operator.env?.[OPERATOR_CONTROL_BINDING]
  assert.equal(control?.type, 'worker')
  assert.equal(control?.worker, 'ply')
  assert.equal(control?.exportName, 'FlagControl')
  assert.equal(operator.env?.FLAGS, undefined)
})

test('cache.enabled false on a named entrypoint does not compile', () => {
  // @ts-expect-error named entrypoint cache.enabled false is API error 10375
  namedEntrypoint({ cache: { enabled: false } })
  assert.deepEqual(namedEntrypoint({}), {})
  assert.deepEqual(namedEntrypoint({ cache: { enabled: true } }), { cache: { enabled: true } })
})
