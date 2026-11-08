import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CAS_AUTH_HEADER,
  casPath,
  encodeRefPath,
  encodeResolveRest,
  gitAuthorizationValue,
  isBlobEntry,
  layerHeader,
  mergeRayHeaderValues,
  parseCommitPath,
  parseObjectPath,
  parseRefPath,
  parseResolvePath,
  parseTreePath,
  purgeRefTags,
  REF_PATH_PREFIX,
  serveObject,
  serveRef,
  splitFilePath,
  viaCas,
  type CasBinding,
  type CasLayer,
} from '../src/cas-cache.ts'
import { CACHE_VERSION } from '../src/cache-version.ts'
import { chainGet } from '../src/absent.ts'

test('cas paths round-trip per layer', () => {
  const oid = 'a'.repeat(40)
  assert.equal(parseObjectPath(casPath('object', oid)), oid)
  assert.equal(parseTreePath(casPath('tree', oid)), oid)
  assert.equal(parseCommitPath(casPath('commit', oid)), oid)
  assert.deepEqual(parseResolvePath(casPath('resolve', encodeResolveRest(oid, 'src/a.txt'))), { commit: oid, path: 'src/a.txt' })
  assert.equal(parseRefPath(casPath('ref', encodeRefPath('refs/heads/main'))), 'refs/heads/main')
  assert.equal(parseObjectPath(`/v${CACHE_VERSION + 1}/object/${oid}`), null)
})

test('splitFilePath and isBlobEntry', () => {
  assert.deepEqual(splitFilePath('README.md'), { parent: '', name: 'README.md' })
  assert.equal(isBlobEntry({ type: 'blob' }), true)
  assert.equal(isBlobEntry({ type: 'tree' }), false)
})

test('gitAuthorizationValue', () => {
  assert.equal(gitAuthorizationValue({ header: 'Bearer x' }), 'Bearer x')
  assert.equal(gitAuthorizationValue({ bearer: 'tok' }), 'Bearer tok')
})

test('serveObject / serveRef: missing scope is no-store', async () => {
  const oid = 'b'.repeat(40)
  const bad = await serveObject(new Request(`https://cas.internal${casPath('object', oid)}`), { scope: '' }, null)
  assert.equal(bad.status, 400)
  assert.equal(bad.headers.get('cache-control'), 'no-store')
  const refBad = await serveRef(new Request(`https://cas.internal${casPath('ref', encodeRefPath('HEAD'))}`), { scope: '' }, null)
  assert.equal(refBad.status, 400)
  assert.equal(refBad.headers.get('cache-control'), 'no-store')
})

function memoryTier(): { binding: (layer: CasLayer) => CasBinding; fills: Map<string, number> } {
  const store = new Map<string, { status: number; headers: Headers; body: Uint8Array }>()
  const fills = new Map<string, number>()
  function binding(layer: CasLayer): CasBinding {
    return (opts) => ({
      async fetch(input) {
        const req = input instanceof Request ? input : new Request(String(input))
        assert.equal(req.headers.get('authorization'), null)
        const props = opts.props
        const key = `${layer}\0${new URL(req.url).pathname}\0${props.scope}`
        const hit = store.get(key)
        if (hit) {
          const h = new Headers(hit.headers)
          h.set('cf-cache-status', 'HIT')
          return new Response(hit.body.slice(), { status: hit.status, headers: h })
        }
        const prev = fills.get(layer)
        fills.set(layer, (prev === void 0 ? 0 : prev) + 1)
        const body = new TextEncoder().encode(JSON.stringify({ layer, scope: props.scope, path: new URL(req.url).pathname }))
        const headers = new Headers({
          'content-type': 'application/json',
          'cache-control': 'public, max-age=60',
          'x-ply-size': String(body.byteLength),
        })
        store.set(key, { status: 200, headers: new Headers(headers), body })
        headers.set('cf-cache-status', 'MISS')
        return new Response(body.slice(), { status: 200, headers })
      },
    })
  }
  return { binding, fills }
}

test('cross-scope isolation at every layer', async () => {
  const { binding, fills } = memoryTier()
  const oid = 'c'.repeat(40)
  const layers: { layer: CasLayer; rest: string }[] = [
    { layer: 'object', rest: oid },
    { layer: 'tree', rest: oid },
    { layer: 'commit', rest: oid },
    { layer: 'resolve', rest: encodeResolveRest(oid, 'README.md') },
    { layer: 'ref', rest: encodeRefPath('HEAD') },
  ]
  const scopeA = 'https://ex.example/git/ns/a.git'
  const scopeB = 'https://ex.example/git/ns/b.git'
  for (const { layer, rest } of layers) {
    const cold = await viaCas(binding(layer), layer, rest, scopeA, 'Bearer a')
    assert.equal(cold.headers.get(layerHeader(layer)), 'MISS')
    const warm = await viaCas(binding(layer), layer, rest, scopeA, 'Bearer a')
    assert.equal(warm.headers.get(layerHeader(layer)), 'HIT')
    const other = await viaCas(binding(layer), layer, rest, scopeB, 'Bearer b')
    assert.equal(other.headers.get(layerHeader(layer)), 'MISS', `${layer} must not share across scopes`)
    const warmBody = await warm.text()
    const bBody = await other.text()
    assert.notEqual(warmBody, bBody)
    assert.match(warmBody, /\/a\.git/)
    assert.match(bBody, /\/b\.git/)
    const coldBody = cold.body
    if (coldBody !== null) await coldBody.cancel().catch(() => {})
  }
  assert.equal(fills.get('object'), 2)
  assert.equal(fills.get('ref'), 2)
})

test('viaCas strips Authorization and surfaces cf-cache-status', async () => {
  const seen: string[] = []
  const binding: CasBinding = (opts) => ({
    async fetch(input) {
      const req = input instanceof Request ? input : new Request(String(input))
      const auth = req.headers.get(CAS_AUTH_HEADER)
      seen.push(auth === null ? '' : auth)
      assert.equal(req.headers.get('authorization'), null)
      assert.deepEqual(opts.props, { scope: 'https://ex.example/r.git' })
      return new Response('x', { status: 200, headers: { 'cf-cache-status': 'HIT', 'x-ply-size': '1' } })
    },
  })
  const res = await viaCas(binding, 'object', 'd'.repeat(40), 'https://ex.example/r.git', 'Bearer secret')
  assert.equal(res.headers.get(layerHeader('object')), 'HIT')
  assert.equal(res.headers.get('cf-cache-status'), null)
  assert.equal(seen[0], 'Bearer secret')
  const body = chainGet(res, 'body')
  if (body.tag === 'some' && body.value !== null) await (body.value as ReadableStream).cancel()
})

import { RAY_HEADER } from '../src/rays.ts'

test('mergeRayHeaderValues concatenates fill rays in order', () => {
  assert.equal(mergeRayHeaderValues(null, ''), '')
  assert.equal(
    mergeRayHeaderValues('ls-refs=aaaaaaaaaaaaaaaa-IAD;dur=1', 'fetch=bbbbbbbbbbbbbbbb-IAD;dur=2'),
    'ls-refs=aaaaaaaaaaaaaaaa-IAD;dur=1, fetch=bbbbbbbbbbbbbbbb-IAD;dur=2',
  )
  assert.equal(
    mergeRayHeaderValues('ls-refs=-;dur=1, fetch=-;dur=2', 'ls-refs=-;dur=3'),
    'ls-refs=-;dur=1, fetch=-;dur=2, ls-refs=-;dur=3',
  )
})

test('purgeRefTags uses purgeEverything on RefCache (entrypoint-scoped)', async () => {
  const calls: unknown[] = []
  const cache = {
    purge: async function (this: unknown, opts: unknown) {
      // Workers Cache throws Illegal invocation when purge is unbound (CD 2026-11-08).
      if (this !== cache) throw new TypeError('Illegal invocation')
      calls.push(opts)
      return { success: true }
    },
  }
  const out = await purgeRefTags({ cache }, ['ply-cas-ref'])
  assert.equal(out.ok, true)
  assert.deepEqual(calls, [{ purgeEverything: true }])
  assert.equal(REF_PATH_PREFIX, `/v${CACHE_VERSION}/ref/`)
})

test('purgeRefTags fails when purge is extracted unbound (Illegal invocation)', async () => {
  const cache = {
    purge: async function (this: unknown, _opts: unknown) {
      if (this !== cache) throw new TypeError('Illegal invocation')
      return { success: true }
    },
  }
  // Simulate the old bug: extract then call unbound.
  const run = cache.purge
  await assert.rejects(async () => run({ purgeEverything: true }), /Illegal invocation/)
})

test('purgeRefTags reports missing ctx.cache (RefCache live / uncached)', async () => {
  const out = await purgeRefTags({}, ['ply-cas-ref'])
  assert.equal(out.ok, false)
  assert.equal(out.error, 'no ctx.cache')
})

test('purgeRefTags surfaces success:false from Workers Cache', async () => {
  const ctx = {
    cache: {
      purge: async () => ({ success: false, errors: [{ code: 1, message: 'rate limited' }] }),
    },
  }
  const out = await purgeRefTags(ctx, ['ply-cas-ref'])
  assert.equal(out.ok, false)
  assert.match(out.error, /rate limited/)
})

test('HIT preserves stored fill x-artifacts-ray (memory tier)', async () => {
  const store = new Map<string, { status: number; headers: Headers; body: Uint8Array }>()
  const binding: CasBinding = () => ({
    async fetch(input) {
      const req = input instanceof Request ? input : new Request(String(input))
      const key = new URL(req.url).pathname
      const hit = store.get(key)
      if (hit) {
        const h = new Headers(hit.headers)
        h.set('cf-cache-status', 'HIT')
        return new Response(hit.body.slice(), { status: hit.status, headers: h })
      }
      const body = new TextEncoder().encode(JSON.stringify({ commit: 'c'.repeat(40) }))
      const headers = new Headers({
        'content-type': 'application/json',
        'cache-control': 'public, max-age=60',
        [RAY_HEADER]: 'ls-refs=cccccccccccccccc-IAD;dur=9, fetch=dddddddddddddddd-IAD;dur=11',
      })
      store.set(key, { status: 200, headers: new Headers(headers), body })
      headers.set('cf-cache-status', 'MISS')
      return new Response(body.slice(), { status: 200, headers })
    },
  })
  const miss = await viaCas(binding, 'commit', 'c'.repeat(40), 'https://ex.example/a.git', null)
  assert.equal(miss.headers.get('x-ply-cache-commit'), 'MISS')
  assert.equal(miss.headers.get(RAY_HEADER), 'ls-refs=cccccccccccccccc-IAD;dur=9, fetch=dddddddddddddddd-IAD;dur=11')
  await miss.arrayBuffer()
  const hit = await viaCas(binding, 'commit', 'c'.repeat(40), 'https://ex.example/a.git', null)
  assert.equal(hit.headers.get('x-ply-cache-commit'), 'HIT')
  assert.equal(hit.headers.get(RAY_HEADER), 'ls-refs=cccccccccccccccc-IAD;dur=9, fetch=dddddddddddddddd-IAD;dur=11')
  await hit.arrayBuffer()
})
