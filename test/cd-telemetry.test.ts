import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JOIN_MIN_LOGGED, SMOKE_LATENCY } from '../scripts/cd/baseline.ts'
import { artifactsProbeUrl, revokeConfirmed } from '../scripts/cd/classify.ts'
import { raysByRequestId } from '../scripts/cd/csv.ts'
import { asRecord } from '../scripts/cd/json.ts'
import { readSmokeRequests } from '../scripts/cd/stage-telemetry.ts'
import {
  fetchSample,
  isTraceSummary,
  judgeSmokeTelemetry,
  implausibleJoin,
  pageCursor,
  percentile,
  queryFault,
  statsFromEvents,
  summarizeTelemetry,
  unwrapEvents,
  type SmokeRequest,
} from '../scripts/cd/telemetry.ts'

const VERSION = '8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e'
const SMOKE_ID = '11111111-1111-4111-8111-111111111111'
const PLATFORM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RAY = '8f3a2b1c4d5e6f70-IAD'
const OTHER_RAY = 'ffffffffffffffff-IAD'
const LOG_TRACE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SPAN_TRACE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/** A Workers Observability span event: requestId is null; traceId and rayId are set. */
function spanEvent(name: string, durationMs: number, rayId: string | null, traceId: string) {
  return {
    $metadata: {
      id: `span-${name}-${traceId.slice(0, 8)}`,
      requestId: null,
      traceId,
      service: 'ply',
      type: 'span',
    },
    traceId,
    rayId,
    name,
    durationMs,
  }
}

function smoke(id: string, ray: string | null, status = 200): SmokeRequest {
  return { id, version: VERSION, step: 'commit', status, expected: [200], ray }
}

function logEvent(id: string, requestId: string, traceId: string, status = 200) {
  return {
    $metadata: { id: `log-${id}`, requestId, traceId, service: 'ply', level: 'info' },
    $workers: { scriptVersion: { id: VERSION }, outcome: 'ok' },
    source: { msg: 'ply.request', id, status, method: 'POST', path: '/v1/commit', ms: 80 },
  }
}

function invocation(id: string, requestId: string, traceId: string) {
  return {
    $metadata: { id: `inv-${id}`, requestId, traceId, type: 'cf-worker-event', service: 'ply' },
    $workers: { scriptVersion: { id: VERSION }, eventType: 'fetch', outcome: 'ok', wallTimeMs: 80, cpuTimeMs: 12 },
  }
}

test('span events join on rayId when requestId is null', () => {
  const fetch = spanEvent('fetch', 20, RAY, SPAN_TRACE)
  const upload = spanEvent('git.upload-pack fetch', 30, RAY, SPAN_TRACE)
  const receive = spanEvent('git.receive-pack', 40, RAY, SPAN_TRACE)
  const spans = [fetch, upload, receive]
  const encoded = JSON.stringify(spans)
  assert.equal(fetch.$metadata.requestId, null)
  assert.equal(encoded.includes(PLATFORM), false)
  assert.equal(encoded.includes(SMOKE_ID), false)
  const summary = summarizeTelemetry(VERSION, [smoke(SMOKE_ID, RAY)], [logEvent(SMOKE_ID, PLATFORM, LOG_TRACE), invocation(SMOKE_ID, PLATFORM, LOG_TRACE)], spans)
  assert.equal(summary.tracedIds.has(SMOKE_ID), true)
  assert.deepEqual(summary.fetchMs, [20])
  const judge = judgeSmokeTelemetry({ version: VERSION, requests: [smoke(SMOKE_ID, RAY)], summary, ceilings: SMOKE_LATENCY })
  assert.equal(judge.kind, 'pass')
})

test('a colo-less rayId still joins the cf-ray from the smoke CSV', () => {
  const fetch = spanEvent('fetch', 20, '8f3a2b1c4d5e6f70', SPAN_TRACE)
  const summary = summarizeTelemetry(VERSION, [smoke(SMOKE_ID, RAY)], [logEvent(SMOKE_ID, PLATFORM, LOG_TRACE), invocation(SMOKE_ID, PLATFORM, LOG_TRACE)], [fetch])
  assert.equal(summary.tracedIds.has(SMOKE_ID), true)
  assert.deepEqual(summary.fetchMs, [20])
})

test('traceId joins a span when rayId does not', () => {
  const fetch = spanEvent('fetch', 15, null, LOG_TRACE)
  assert.equal(fetch.$metadata.requestId, null)
  assert.equal(JSON.stringify(fetch).includes(SMOKE_ID), false)
  assert.equal(JSON.stringify(fetch).includes(RAY), false)
  const summary = summarizeTelemetry(VERSION, [smoke(SMOKE_ID, RAY)], [logEvent(SMOKE_ID, PLATFORM, LOG_TRACE), invocation(SMOKE_ID, PLATFORM, LOG_TRACE)], [fetch])
  assert.equal(summary.tracedIds.has(SMOKE_ID), true)
  assert.deepEqual(summary.fetchMs, [15])
})

test('a join that misses the invocations the worker logged is a harness fault', () => {
  const requests: SmokeRequest[] = []
  const events: unknown[] = []
  const traces: unknown[] = []
  for (let i = 0; i < JOIN_MIN_LOGGED; i++) {
    const id = `22222222-2222-4222-8222-22222222222${i}`
    const requestId = `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${i}`
    const ray = `aaaaaaaaaaaaaaa${i}-IAD`
    requests.push(smoke(id, ray))
    events.push(logEvent(id, requestId, LOG_TRACE.replace(/a/g, String(i))), invocation(id, requestId, LOG_TRACE.replace(/a/g, String(i))))
    traces.push(spanEvent('fetch', 20, OTHER_RAY, SPAN_TRACE), spanEvent('git.upload-pack fetch', 30, OTHER_RAY, SPAN_TRACE), spanEvent('git.receive-pack', 40, OTHER_RAY, SPAN_TRACE))
  }
  const summary = summarizeTelemetry(VERSION, requests, events, traces)
  assert.equal(summary.tracedIds.size, 0)
  assert.equal(summary.invocations, JOIN_MIN_LOGGED)
  assert.equal(implausibleJoin({ smoke: requests.length, invocations: summary.invocations, joined: summary.tracedIds.size }), true)
  const judge = judgeSmokeTelemetry({ version: VERSION, requests, summary, ceilings: SMOKE_LATENCY })
  assert.equal(judge.kind, 'harness_fault')
  if (judge.kind === 'harness_fault') assert.match(judge.reason, /span join matched 0\//)
})

test('a 5xx stays a worker fault when the span join also misses', () => {
  const requests: SmokeRequest[] = []
  const events: unknown[] = []
  const traces: unknown[] = []
  for (let i = 0; i < JOIN_MIN_LOGGED; i++) {
    const id = `33333333-3333-4333-8333-33333333333${i}`
    const requestId = `cccccccc-cccc-4ccc-8ccc-ccccccccccc${i}`
    const ray = `bbbbbbbbbbbbbbb${i}-IAD`
    requests.push({ ...smoke(id, ray), status: 500 })
    events.push(logEvent(id, requestId, SPAN_TRACE, 500), invocation(id, requestId, SPAN_TRACE))
    traces.push(spanEvent('fetch', 20, OTHER_RAY, LOG_TRACE))
  }
  const summary = summarizeTelemetry(VERSION, requests, events, traces)
  const judge = judgeSmokeTelemetry({ version: VERSION, requests, summary, ceilings: SMOKE_LATENCY })
  assert.equal(judge.kind, 'worker')
})

test('a telemetry query failure is a harness fault and not a worker fault', () => {
  const fault = queryFault('telemetry unavailable: cf o11y down')
  assert.equal(fault.kind, 'harness_fault')
  assert.match(fault.reason, /cf o11y down/)
})

test('the smoke CSV cf-ray is the join key the report can omit', () => {
  const csv = [
    'step,method,path,status,ms,pass,cf_ray,x_ply_request_id,x_artifacts_ray,x_ply_version,x_ply_build,server_timing,detail',
    `commit,POST,/v1/commit,200,10,pass,${RAY},${SMOKE_ID},art-ray,${VERSION},build,total;dur=10,ok`,
  ].join('\n')
  assert.equal(raysByRequestId(csv).get(SMOKE_ID), RAY)
  const requests = readSmokeRequests(JSON.stringify({
    requests: [{ id: SMOKE_ID, version: VERSION, step: 'commit', status: 200, expected: [200] }],
  }))
  assert.equal(requests[0]?.ray, null)
  const ray = raysByRequestId(csv).get(SMOKE_ID) ?? null
  const joined = requests.map(request => request.ray ? request : { ...request, ray })
  assert.equal(joined[0]?.ray, RAY)
})

test('trace summaries with a full join are a harness fault, not a worker fault', () => {
  const trace = {
    traceId: LOG_TRACE,
    spans: 4,
    traceDurationMs: 80,
    rootSpanName: 'POST',
    rootTransactionName: 'POST https://ply.ivar.workers.dev/v1/commit',
    errors: [],
    id: '01TRACE',
    services: ['ply'],
    traceStartMs: 1,
    traceEndMs: 81,
  }
  const summary = summarizeTelemetry(
    VERSION,
    [smoke(SMOKE_ID, RAY)],
    [logEvent(SMOKE_ID, PLATFORM, LOG_TRACE), invocation(SMOKE_ID, PLATFORM, LOG_TRACE)],
    [trace],
  )
  assert.equal(isTraceSummary(trace), true)
  assert.equal(summary.spanShape, 'summaries')
  assert.equal(summary.tracedIds.has(SMOKE_ID), true)
  assert.deepEqual([...summary.fetchMs], [])
  const judge = judgeSmokeTelemetry({ version: VERSION, requests: [smoke(SMOKE_ID, RAY)], summary, ceilings: SMOKE_LATENCY })
  assert.equal(judge.kind, 'harness_fault')
  if (judge.kind === 'harness_fault') {
    assert.match(judge.reason, /trace summaries/)
    assert.equal(judge.checks.some(check => check.kind === 'shape'), true)
  }
})

test('an observed fetch duration over the ceiling is a worker fault', () => {
  const slow = {
    source: {
      name: 'fetch',
      durationMS: SMOKE_LATENCY.fetchMs.p99Ms + 1,
      url: { path: '/git/ply-loadgen/repo.git/git-upload-pack' },
      http: { response: { status_code: 200 } },
    },
    $metadata: { id: 'span-slow', type: 'span', spanName: 'fetch', requestId: null, traceId: LOG_TRACE, rayId: RAY, service: 'ply' },
  }
  const sample = fetchSample(slow)
  assert.equal(sample?.durationMs, SMOKE_LATENCY.fetchMs.p99Ms + 1)
  assert.equal(sample?.artifacts, true)
  const summary = summarizeTelemetry(
    VERSION,
    [smoke(SMOKE_ID, RAY)],
    [logEvent(SMOKE_ID, PLATFORM, LOG_TRACE), invocation(SMOKE_ID, PLATFORM, LOG_TRACE)],
    [slow],
  )
  const judge = judgeSmokeTelemetry({ version: VERSION, requests: [smoke(SMOKE_ID, RAY)], summary, ceilings: SMOKE_LATENCY })
  assert.equal(judge.kind, 'worker')
  if (judge.kind === 'worker') assert.equal(judge.failures.some(failure => failure.kind === 'latency'), true)
})

const CANARY = 'c2713bac-95bb-4a4a-b3c1-f5b07c86fddd'
const recordedTraces = unwrapEvents(JSON.parse(readFileSync(new URL('./fixtures/cd/canary-traces.json', import.meta.url), 'utf8')))
const recordedSpans = unwrapEvents(JSON.parse(readFileSync(new URL('./fixtures/cd/canary-spans.json', import.meta.url), 'utf8')))

test('recorded query responses exercise every telemetry evaluator', () => {
  assert.ok(recordedTraces.length > 0)
  assert.ok(recordedTraces.every(row => {
    const rec = asRecord(row)
    return rec !== null && isTraceSummary(rec) && typeof rec.spans === 'number'
  }))
  assert.equal(fetchSample(recordedTraces[0]), null)
  const samples = recordedSpans.flatMap(span => {
    const sample = fetchSample(span)
    return sample ? [sample] : []
  })
  const upload = samples.filter(sample => sample.version === CANARY && sample.path.endsWith('/git-upload-pack') && sample.status === 200)
  const receive = samples.filter(sample => sample.version === CANARY && sample.path.endsWith('/git-receive-pack') && sample.status === 200)
  const refs = samples.filter(sample => sample.path.endsWith('/info/refs') && sample.status === 200)
  assert.equal(upload.length, 160)
  assert.equal(percentile(upload.map(sample => sample.durationMs), 0.5), 108)
  assert.equal(upload.some(sample => sample.durationMs === 523), true)
  assert.equal(receive.length, 36)
  assert.equal(percentile(receive.map(sample => sample.durationMs), 0.5), 107)
  assert.equal(receive.some(sample => sample.durationMs === 691), true)
  assert.equal(refs.length, 1)
  assert.equal(refs[0]?.durationMs, 49)
  const cursor = pageCursor(recordedSpans)
  const last = asRecord(asRecord(recordedSpans[recordedSpans.length - 1])?.$metadata)
  assert.equal(cursor, last?.id)

  const requests: SmokeRequest[] = []
  const events: unknown[] = []
  for (const row of recordedTraces) {
    const traceId = asRecord(row)?.traceId
    if (typeof traceId !== 'string') continue
    const requestId = `req-${traceId.slice(0, 12)}`
    requests.push({ id: traceId, version: CANARY, step: 'commit', status: 200, expected: [200], ray: null })
    events.push({
      $metadata: { id: `log-${traceId}`, requestId, traceId, service: 'ply', level: 'info' },
      $workers: { scriptVersion: { id: CANARY }, outcome: 'ok' },
      source: { msg: 'ply.request', id: traceId, status: 200, method: 'POST', path: '/v1/commit', ms: 80 },
    })
    events.push({
      $metadata: { id: `inv-${traceId}`, requestId, traceId, type: 'cf-worker-event', service: 'ply' },
      $workers: { scriptVersion: { id: CANARY }, eventType: 'fetch', outcome: 'ok', wallTimeMs: 80, cpuTimeMs: 12 },
    })
  }
  const blinded = summarizeTelemetry(CANARY, requests, events, recordedTraces)
  assert.equal(blinded.spanShape, 'summaries')
  assert.equal(blinded.fetchMs.length, 0)
  assert.equal(blinded.tracedIds.size, requests.length)
  const blindedJudge = judgeSmokeTelemetry({ version: CANARY, requests, summary: blinded, ceilings: SMOKE_LATENCY })
  assert.equal(blindedJudge.kind, 'harness_fault')
  if (blindedJudge.kind === 'harness_fault') assert.match(blindedJudge.reason, /no child spans/)

  const seen = summarizeTelemetry(CANARY, requests, events, recordedTraces, recordedSpans)
  assert.equal(seen.spanShape, 'events')
  assert.equal(seen.fetchMs.length, 200)
  assert.ok((percentile(seen.fetchMs, 0.99) ?? 0) < SMOKE_LATENCY.fetchMs.p99Ms)
  const judge = judgeSmokeTelemetry({ version: CANARY, requests, summary: seen, ceilings: SMOKE_LATENCY })
  assert.equal(judge.kind, 'pass')
  const versionStats = statsFromEvents(events, recordedSpans)
  assert.equal(versionStats.fetchMs.length, 200)
})

test('the revoke probe URL does not carry the token', () => {
  const token = 'art_v2_super-secret-token-value'
  const remote = 'https://abc.artifacts.cloudflare.net/git/ply-loadgen/ply-web-cd-test.git'
  const url = artifactsProbeUrl(remote)
  assert.equal(url.includes(token), false)
  assert.equal(url, `${remote}/info/refs?service=git-upload-pack`)
  assert.equal(revokeConfirmed(403), true)
  assert.equal(revokeConfirmed(200), false)
  assert.equal(revokeConfirmed(401), false)
  assert.equal(revokeConfirmed(0), false)
})
