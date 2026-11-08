// Row identity and paging of Workers Observability event queries (scripts/cd/o11y.ts, scripts/cd/telemetry.ts).
// `$metadata.id` is a millisecond plus a per-invocation row position, so distinct rows share it (2026-11-08 ramp runs).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TELEMETRY_PAGE } from '../scripts/cd/baseline.ts'
import { useCfRunner, type CfResult } from '../scripts/cd/cf.ts'
import { queryCaptured, queryCapturedSliced, type QueryRetry } from '../scripts/cd/o11y.ts'
import { dedupeRows, pageCursor, rowKey } from '../scripts/cd/telemetry.ts'

type Meta = Record<string, string | null>
const row = (meta: Meta, extra: object = {}) => ({ $metadata: meta, ...extra })
const metaOf = (value: unknown) => (value as { $metadata: Meta }).$metadata

const RETRY: QueryRetry = { bound: { attempts: 1, backoffMs: 0 }, sleep: async () => {}, note: async () => {} }

/** The real index: newest id first, `offset` returns only ids strictly below it, `limit` per page. */
function serve(rows: readonly unknown[]): void {
  const sorted = [...rows].sort((a, b) => {
    const x = String(metaOf(a).id)
    const y = String(metaOf(b).id)
    return x < y ? 1 : x > y ? -1 : 0
  })
  useCfRunner(async (args): Promise<CfResult> => {
    const body = JSON.parse(String(args[4])) as Record<string, unknown>
    const offset = 'offset' in body ? String(body.offset) : null
    const page = sorted.filter(item => offset === null || String(metaOf(item).id) < offset).slice(0, Number(body.limit))
    return { code: 0, stdout: JSON.stringify({ events: { events: page } }), stderr: '' }
  })
}

function serveSlices(slices: readonly (readonly unknown[])[]): void {
  let call = 0
  useCfRunner(async (): Promise<CfResult> => {
    const page = call < slices.length ? slices[call] : []
    call += 1
    return { code: 0, stdout: JSON.stringify({ events: { events: page } }), stderr: '' }
  })
}

test('two invocations in the same ms and row position are two rows', async () => {
  const a = row({ id: 'X', requestId: 'r1', traceId: 't1' })
  const b = row({ id: 'X', requestId: 'r2', traceId: 't2' })
  try {
    serveSlices([[a, b]])
    const got = await queryCapturedSliced('events', 0, 1000, [], RETRY)
    assert.equal(got.events.length, 2)
  } finally {
    useCfRunner(null)
  }
})

test('the same row in two overlapping slices is one row', async () => {
  const a = row({ id: 'X', requestId: 'r1', traceId: 't1' })
  try {
    serveSlices([[a], [a]])
    const got = await queryCapturedSliced('events', 0, 20_000, [], RETRY)
    assert.equal(got.events.length, 1)
  } finally {
    useCfRunner(null)
  }
})

test('span rows have a null requestId: same id, different spans stay; the same span twice is one', () => {
  const first = row({ id: 'S', requestId: null, traceId: 't1', spanId: 'a' })
  const other = row({ id: 'S', requestId: null, traceId: 't2', spanId: 'b' })
  const sameTraceOtherSpan = row({ id: 'S', requestId: null, traceId: 't1', spanId: 'c' })
  assert.equal(dedupeRows([first, other, sameTraceOtherSpan]).length, 3)
  assert.equal(dedupeRows([first, first]).length, 1)
})

test('a row with no id is never compared', () => {
  assert.equal(rowKey(row({})), null)
  assert.equal(rowKey({ traceId: 't' }), null)
  const noId = row({})
  assert.equal(dedupeRows([noId, noId]).length, 2)
})

test('pageCursor steps back past the final id so a split same-id group is re-read', () => {
  assert.equal(pageCursor([row({ id: 'C' }), row({ id: 'B' }), row({ id: 'A' })]), 'B')
  assert.equal(pageCursor([row({ id: 'C' }), row({ id: 'A', requestId: '1' }), row({ id: 'A', requestId: '2' })]), 'C')
  assert.equal(pageCursor([row({ id: 'A', requestId: '1' }), row({ id: 'A', requestId: '2' })]), null, 'all one id: no way to advance')
  assert.equal(pageCursor([row({})]), null)
  assert.equal(pageCursor([]), null)
})

test('a page boundary inside a same-id group neither skips nor repeats a row', async () => {
  // Newest first: page 1 ends on the first of the pair `P`; the second of it sorts onto page 2.
  const fill = (n: number, from: number) => Array.from({ length: n }, (_, i) => row({ id: `Z${String(from + i).padStart(5, '0')}`, requestId: `f${from + i}` }))
  const newer = fill(TELEMETRY_PAGE - 1, 0)
  const pair = [row({ id: 'M', requestId: 'p1', traceId: 't1' }), row({ id: 'M', requestId: 'p2', traceId: 't2' })]
  const older = [row({ id: 'A', requestId: 'o1' }), row({ id: 'A', requestId: 'o2' })]
  try {
    serve([...newer, ...pair, ...older])
    const got = await queryCaptured('events', 0, 1000, [], RETRY)
    const ids = got.events.map(event => `${String(metaOf(event).id)}/${String(metaOf(event).requestId)}`)
    assert.equal(new Set(ids).size, ids.length, 'no repeats')
    assert.equal(ids.length, newer.length + pair.length + older.length, 'no skips')
    assert.ok(ids.includes('M/p1') && ids.includes('M/p2'))
  } finally {
    useCfRunner(null)
  }
})

test('a full page of one id cannot page further and fails loudly rather than looping', async () => {
  const all = Array.from({ length: TELEMETRY_PAGE }, (_, i) => row({ id: 'X', requestId: `r${i}` }))
  try {
    serve(all)
    await assert.rejects(queryCaptured('events', 0, 1000, [], RETRY), /no usable \$metadata\.id cursor/)
  } finally {
    useCfRunner(null)
  }
})
