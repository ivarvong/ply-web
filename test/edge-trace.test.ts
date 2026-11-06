// src/edge-trace.ts and openSpan (src/flags/telemetry.ts) against a fake `ctx.tracing`. The runtime itself is exercised
// by test/worker-spans.test.js (the cf bundle under workerd, through a streaming tail).
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { test } from 'node:test'
import { arrayExporter, Tracer } from 'ply'
import { EDGE_ATTR, REQUEST_ATTR, edgeTracingOf, plyTracer, requestStamp, routeStamp, stampRequestSpan } from '../src/edge-trace.ts'
import { openSpan, type TracingLike } from '../src/flags/telemetry.ts'

type Recorded = { name: string; parent: string | null; attrs: Record<string, unknown>; status: string | null; ended: boolean }

/**
 * A fake of workerd's ctx.tracing: the active span lives in the async context, and startActiveSpan makes the new span
 * active for its callback (and what that callback captures), not after it returns.
 */
function fakeTracing() {
  const spans: Recorded[] = []
  const active = new AsyncLocalStorage<string>()
  const tracing = {
    startActiveSpan<T>(name: string, fn: (span: unknown) => T): T {
      const parent = active.getStore()
      const rec: Recorded = { name, parent: typeof parent === 'string' ? parent : null, attrs: {}, status: null, ended: false }
      spans.push(rec)
      return active.run(name, () => fn({
        setAttribute(key: string, value: unknown) { rec.attrs[key] = value },
        setStatus(status: { code: string }) { rec.status = status.code },
        end() { rec.ended = true },
      }))
    },
  }
  return { tracing, spans }
}

test('without ctx.tracing the request gets ply\'s plain Tracer', () => {
  for (const ctx of [null, {}, { tracing: null }, { tracing: { enterSpan() {} } }]) {
    assert.equal(edgeTracingOf(ctx), null)
    assert.equal(Object.getPrototypeOf(plyTracer(ctx, {})), Tracer.prototype)
  }
})

test('each ply span is a platform span, closed with ply\'s attributes, ids and error status; the exporter still gets it', async () => {
  const { tracing, spans } = fakeTracing()
  const exporter = arrayExporter()
  const tracer = plyTracer({ tracing }, { exporter })
  const root = tracer.start('git.edit', { attrs: { 'git.edit.path': 'a.txt' } })
  await tracer.span('git.edit.blob', { parent: root }, async span => {
    span.set({ 'git.edit.blob.delta.bytes': 9, 'git.edit.blob.ops': ['copy', 'insert'] })
  })
  root.error(Object.assign(new Error('stale'), { code: 'cas_conflict' }))
  root.end()
  assert.equal(exporter.lines.length, 2)
  assert.deepEqual(spans.map(s => s.name), ['git.edit', 'git.edit.blob'])
  const [edit, blob] = spans
  assert.ok(edit && blob)
  assert.equal(edit.parent, null)
  assert.equal(blob.parent, 'git.edit', 'nested as ply nests it, though git.edit was never the active span')
  assert.ok(edit.ended && blob.ended)
  assert.equal(edit.attrs['git.edit.path'], 'a.txt')
  assert.equal(edit.status, 'error')
  assert.equal(blob.attrs['git.edit.blob.delta.bytes'], 9)
  assert.equal(blob.attrs['git.edit.blob.ops'], '["copy","insert"]')
  assert.equal(blob.attrs[EDGE_ATTR.parentSpanId], edit.attrs[EDGE_ATTR.spanId])
  assert.equal(typeof blob.attrs[EDGE_ATTR.durationMs], 'number')
  assert.equal(blob.status, null)
})

test('a runtime that throws on span calls does not fail the request', async () => {
  const tracer = plyTracer({ tracing: { startActiveSpan() { throw new Error('no tracing here') } } }, { exporter: arrayExporter() })
  assert.equal(await tracer.span('git.head', {}, async () => 7), 7)
})

test('openSpan uses the runtime\'s startSpan, with its receiver', () => {
  const opened: string[] = []
  const tracing = {
    marker: 'ctx.tracing',
    startSpan(this: { marker: string }, name: string) { opened.push(`${this.marker}:${name}`); return { end() {} } },
    // workerd's enterSpan takes a callback; it must not be called with one argument.
    enterSpan(name: string, fn: () => unknown) { opened.push(`enter:${name}`); return fn() },
  }
  assert.ok(openSpan(tracing as unknown as TracingLike, 'ply.viewer'))
  assert.deepEqual(opened, ['ctx.tracing:ply.viewer'])
})

test('the route and version stamp is on every platform span, and not in ply\'s own export', async () => {
  const { tracing, spans } = fakeTracing()
  const exporter = arrayExporter()
  const tracer = plyTracer({ tracing }, { exporter }, routeStamp('GET /v1/tree', 'v-123'))
  await tracer.span('git.ls_tree', {}, async span => {
    span.set({ 'git.ls_tree.entries': 12 })
    await tracer.span('git.upload-pack fetch', { parent: span }, async () => {})
  })
  assert.deepEqual(spans.map(s => [s.name, s.attrs[EDGE_ATTR.route], s.attrs[EDGE_ATTR.version]]), [
    ['git.ls_tree', 'GET /v1/tree', 'v-123'],
    ['git.upload-pack fetch', 'GET /v1/tree', 'v-123'],
  ])
  assert.equal(spans[0].attrs['git.ls_tree.entries'], 12)
  assert.equal(JSON.stringify(exporter.lines).includes(EDGE_ATTR.route), false)
  // No version id (local dev): the key is left out, not filled with a placeholder.
  assert.deepEqual(routeStamp('viewer', null), { [EDGE_ATTR.route]: 'viewer' })
  assert.deepEqual(routeStamp('viewer', ''), { [EDGE_ATTR.route]: 'viewer' })
})

test('stampRequestSpan sets attributes on the runtime\'s active span, and never throws', () => {
  const attrs: Record<string, unknown> = {}
  const active = { setAttribute(key: string, value: unknown) { attrs[key] = value } }
  assert.equal(stampRequestSpan({ tracing: { startActiveSpan() {}, getActiveSpan: () => active } }, { 'ply.route': 'GET /v1/refs' }), true)
  assert.deepEqual(attrs, { 'ply.route': 'GET /v1/refs' })
  for (const ctx of [null, {}, { tracing: {} }, { tracing: { getActiveSpan: () => null } }, { tracing: { getActiveSpan: () => ({}) } }, { tracing: { getActiveSpan() { throw new Error('no') } } }]) {
    assert.equal(stampRequestSpan(ctx, { a: 1 }), false)
  }
  const refusing = { setAttribute() { throw new Error('closed') } }
  assert.equal(stampRequestSpan({ tracing: { getActiveSpan: () => refusing } }, { a: 1 }), false)
})

test('requestStamp copies the route, version, status, error and ply\'s counts from the request log', () => {
  assert.deepEqual(requestStamp({ route: 'POST /v1/edit', version: 'v1', surface: 'api', status: 409, log: { code: 'cas_conflict', spans: 7, rtt: 3, wide: 0, cache_hits: 1 } }), {
    [REQUEST_ATTR.route]: 'POST /v1/edit',
    [REQUEST_ATTR.version]: 'v1',
    [REQUEST_ATTR.surface]: 'api',
    [REQUEST_ATTR.status]: 409,
    [REQUEST_ATTR.errorCode]: 'cas_conflict',
    [REQUEST_ATTR.spans]: 7,
    [REQUEST_ATTR.roundTrips]: 3,
    [REQUEST_ATTR.wide]: 0,
    [REQUEST_ATTR.cacheHits]: 1,
  })
  const unexpected = requestStamp({ route: 'unmatched', version: null, surface: 'api', status: 500, log: { code: 'internal', error_kind: 'unexpected', spans: Number.NaN, viewer: 1 } })
  assert.deepEqual(unexpected, { 'ply.route': 'unmatched', 'ply.surface': 'api', 'http.response.status_code': 500, 'ply.error.code': 'internal', 'ply.error.kind': 'unexpected' })
})
