import assert from 'node:assert/strict'
import { test } from 'node:test'
import { entrypoints, namedEntrypoint } from '../cloudflare.config.ts'

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

test('cache.enabled false on a named entrypoint does not compile', () => {
  // @ts-expect-error named entrypoint cache.enabled false is API error 10375
  namedEntrypoint({ cache: { enabled: false } })
  assert.deepEqual(namedEntrypoint({}), {})
  assert.deepEqual(namedEntrypoint({ cache: { enabled: true } }), { cache: { enabled: true } })
})
