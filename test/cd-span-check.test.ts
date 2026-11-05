// The CD post-deploy span check (scripts/cd/span-check.ts, issue #67).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { lifecycle } from '../scripts/cd/lifecycle.ts'
import { checkEditSpans, pollEditSpans, TRACED_EDIT_SPANS, TRACED_EDIT_STEP } from '../scripts/cd/span-check.ts'
import { unwrapEvents, type SmokeRequest } from '../scripts/cd/telemetry.ts'

type SpanEvent = { $metadata: { rayId: string; traceId: string; transactionName: string; spanName: string; type: string }; source: { name: string } }

/** Real span events from a prod canary window (2026-11-01): Workers' request and fetch spans, and no ply span. */
const PROD = unwrapEvents(JSON.parse(readFileSync(new URL('./fixtures/cd/canary-spans.json', import.meta.url), 'utf8'))) as SpanEvent[]
const EDIT = PROD.find(event => event.source.name === 'POST' && event.$metadata.transactionName.endsWith('/v1/edit'))
if (!EDIT) throw new Error('fixture has no POST /v1/edit span')
const RAY = `${EDIT.$metadata.rayId}-SJC`
const TRACE = EDIT.$metadata.traceId

function traced(ray: string | null): SmokeRequest {
  return { id: '11111111-1111-4111-8111-111111111111', version: 'v', step: TRACED_EDIT_STEP, status: 200, expected: [200], ray }
}

/** A ply span as Workers Observability would index it: same trace and ray as the request span. */
function plySpan(name: string, i: number) {
  return { $metadata: { id: `ply-${i}`, type: 'span', spanName: name, traceId: TRACE, rayId: EDIT && EDIT.$metadata.rayId, service: 'ply' }, source: { name } }
}

const PLY = TRACED_EDIT_SPANS.map(plySpan)

test('the smoke sends edit-traced as a single-file find/replace on /v1/edit before refs-final', () => {
  const steps = lifecycle()
  const at = steps.findIndex(step => step.name === TRACED_EDIT_STEP)
  const step = steps[at]
  assert.ok(step && at < steps.findIndex(s => s.name === 'refs-final'))
  assert.equal(step.method, 'POST')
  assert.equal(step.path, '/v1/edit')
  const body = step.body ? step.body({}) as Record<string, unknown> : {}
  assert.equal(typeof body.path, 'string')
  assert.equal(typeof body.find, 'string')
  assert.equal('changes' in body, false, 'changes[] is git.commit, not editFile')
})

test('the prod trace of #67 fails: the edit was traced (POST and fetch spans) and no ply span was exported', () => {
  const check = checkEditSpans([traced(RAY)], PROD)
  assert.equal(check.kind, 'worker')
  if (check.kind !== 'worker') return
  assert.deepEqual(check.missing, [...TRACED_EDIT_SPANS])
  assert.deepEqual(check.traceIds, [TRACE])
  assert.ok(check.names.includes('POST') && check.names.includes('fetch'))
  assert.match(check.line, /^spans: edit-traced \S+ trace [0-9a-f]{32} is missing ply spans git\.edit, git\.edit\.tree, git\.edit\.blob, git\.upload-pack fetch, git\.receive-pack; saw /)
})

test('every expected ply span in the edit\'s trace passes; the trace joins on cf-ray, then traceId', () => {
  const check = checkEditSpans([traced(RAY)], [...PROD, ...PLY])
  assert.equal(check.kind, 'pass')
  assert.equal(check.line, `spans: edit-traced 11111111-1111-4111-8111-111111111111 trace ${TRACE} has ${TRACED_EDIT_SPANS.join(', ')} (${PROD.filter(e => e.$metadata.traceId === TRACE).length + PLY.length} span events)`)
  // A ply span that carries only the trace id still counts.
  const traceOnly = PLY.map(event => ({ ...event, $metadata: { ...event.$metadata, rayId: null } }))
  assert.equal(checkEditSpans([traced(RAY)], [...PROD, ...traceOnly]).kind, 'pass')
  // One missing name is named.
  const short = checkEditSpans([traced(RAY)], [...PROD, ...PLY.filter(e => e.source.name !== 'git.edit.blob')])
  assert.equal(short.kind, 'worker')
  assert.match(short.line, /missing ply spans git\.edit\.blob;/)
})

test('a check that cannot be evaluated is a harness fault, never a pass', () => {
  assert.equal(checkEditSpans([traced('0123456789abcdef-IAD')], PROD).kind, 'harness_fault')
  assert.equal(checkEditSpans([traced(null)], PROD).kind, 'harness_fault')
  assert.equal(checkEditSpans([{ ...traced(RAY), step: 'commit' }], PROD).kind, 'harness_fault')
  assert.match(checkEditSpans([traced('0123456789abcdef-IAD')], PROD).line, /no span event joined to edit-traced .* cannot be checked/)
})

test('polling waits for late span events and stops at the deadline with the last verdict', async () => {
  let clock = 0
  const slept: number[] = []
  let pages: unknown[][] = [PROD, PROD, [...PROD, ...PLY]]
  let calls = 0
  const poll = (waitMs: number) => ({
    query: async () => pages[Math.min(calls++, pages.length - 1)] as unknown[],
    sleep: async (ms: number) => { slept.push(ms); clock += ms },
    now: () => clock,
    pollsMs: [5_000, 10_000],
    waitMs,
  })
  assert.equal((await pollEditSpans([traced(RAY)], poll(60_000))).kind, 'pass')
  assert.deepEqual(slept, [5_000, 10_000])
  // The ply spans would arrive on the fourth query; the deadline is at the third.
  calls = 0; clock = 0; slept.length = 0
  pages = [PROD, PROD, PROD, [...PROD, ...PLY]]
  const late = await pollEditSpans([traced(RAY)], poll(12_000))
  assert.equal(late.kind, 'worker')
  assert.deepEqual(slept, [5_000, 7_000])
  assert.equal(calls, 3)
  // Nothing to wait for: no edit-traced request.
  calls = 0; clock = 0; slept.length = 0
  assert.equal((await pollEditSpans([], poll(60_000))).kind, 'harness_fault')
  assert.deepEqual(slept, [])
})
