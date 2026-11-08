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
  parseCommitPath,
  parseObjectPath,
  parseRefPath,
  parseResolvePath,
  parseTreePath,
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
