// src/edge-trace.ts and openSpan (src/flags/telemetry.ts) against a fake `ctx.tracing`. The runtime itself is exercised
// by test/worker-spans.test.js (the cf bundle under workerd, through a streaming tail).
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { test } from 'node:test'
import { arrayExporter, Tracer } from 'ply'
import { EDGE_ATTR, edgeTracingOf, plyTracer } from '../src/edge-trace.ts'
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
