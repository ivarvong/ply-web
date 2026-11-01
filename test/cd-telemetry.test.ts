import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JOIN_MIN_LOGGED, SMOKE_LATENCY } from '../scripts/cd/baseline.ts'
import { artifactsProbeUrl, revokeConfirmed } from '../scripts/cd/classify.ts'
import { raysByRequestId } from '../scripts/cd/csv.ts'
import { asRecord } from '../scripts/cd/json.ts'
import { DEFAULT_MAX_LOSS_RATE, DEFAULT_POLICY_PATH, loadPolicy } from '../scripts/cd/policy.ts'
import { progressLine } from '../scripts/cd/ramp.ts'
import { readSmokeRequests } from '../scripts/cd/stage-telemetry.ts'
import { judgeStep, routedShare } from '../scripts/cd/slo.ts'
import {
  DEFAULT_ENTRYPOINT,
  fetchInvocation,
  fetchSample,
  isTraceSummary,
  judgeSmokeTelemetry,
  implausibleJoin,
  pageCursor,
  percentile,
  queryFault,
  statsFromEvents,
  summarizeTelemetry,
  telemetryLoss,
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
  const judge = judgeSmokeTelemetry({ version: VERSION, requests: [smoke(SMOKE_ID, RAY)], summary, ceilings: SMOKE_LATENCY, maxLossRate: null })
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
  const judge = judgeSmokeTelemetry({ version: VERSION, requests, summary, ceilings: SMOKE_LATENCY, maxLossRate: null })
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
  const judge = judgeSmokeTelemetry({ version: VERSION, requests, summary, ceilings: SMOKE_LATENCY, maxLossRate: null })
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
  const judge = judgeSmokeTelemetry({ version: VERSION, requests: [smoke(SMOKE_ID, RAY)], summary, ceilings: SMOKE_LATENCY, maxLossRate: null })
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
  const judge = judgeSmokeTelemetry({ version: VERSION, requests: [smoke(SMOKE_ID, RAY)], summary, ceilings: SMOKE_LATENCY, maxLossRate: null })
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
  const blindedJudge = judgeSmokeTelemetry({ version: CANARY, requests, summary: blinded, ceilings: SMOKE_LATENCY, maxLossRate: null })
  assert.equal(blindedJudge.kind, 'harness_fault')
  if (blindedJudge.kind === 'harness_fault') assert.match(blindedJudge.reason, /no child spans/)

  const seen = summarizeTelemetry(CANARY, requests, events, recordedTraces, recordedSpans)
  assert.equal(seen.spanShape, 'events')
  assert.equal(seen.fetchMs.length, 200)
  assert.ok((percentile(seen.fetchMs, 0.99) ?? 0) < SMOKE_LATENCY.fetchMs.p99Ms)
  const judge = judgeSmokeTelemetry({ version: CANARY, requests, summary: seen, ceilings: SMOKE_LATENCY, maxLossRate: null })
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

/** The 10% flag-service rollback. Named entrypoints were counted as routed traffic. */
const NEW_VERSION = '3a56fa4f-7b3d-4c1a-9e20-6f0a1b2c3d4e'
const OLD_VERSION = '11111111-2222-4333-8444-555566667777'
const NEW_EXTERNAL = 203
const NEW_FLAGS = 92
const OLD_EXTERNAL = 1774
const OLD_GIT = 1
const FLAGS_CACHE = 'FlagsCache'
const GIT_CACHE = 'GitCache'
const INTERNAL_WALL_MS = 99_000
const LOGGED_MS = 12
const EXTERNAL_FETCH_MS = 20

function percentText(fraction: number | null): string {
  if (fraction === null) return '-'
  return (fraction * 100).toFixed(2)
}

function eventIdentity(n: number) {
  const hex = n.toString(16).padStart(12, '0')
  return {
    requestId: `${hex.slice(0, 8)}-0000-4000-8000-${hex}`,
    traceId: hex.padStart(32, 'c'),
    rayId: `${hex.padStart(16, 'd')}-IAD`,
  }
}

function workerFetch(
  version: string,
  n: number,
  entrypoint: string | null,
  workersOver: Record<string, unknown> = {},
) {
  const id = eventIdentity(n)
  const workers: Record<string, unknown> = {
    scriptVersion: { id: version },
    eventType: 'fetch',
    outcome: 'ok',
    wallTimeMs: 40,
    cpuTimeMs: 8,
    ...workersOver,
  }
  if (entrypoint !== null) workers.entrypoint = entrypoint
  return {
    $metadata: {
      id: `inv-${id.requestId}`,
      requestId: id.requestId,
      traceId: id.traceId,
      type: 'cf-worker-event',
      service: 'ply',
    },
    rayId: id.rayId,
    traceId: id.traceId,
    $workers: workers,
  }
}

test('named entrypoints are not routed traffic', () => {
  const bare = workerFetch(NEW_VERSION, 1, null)
  const namedDefault = workerFetch(NEW_VERSION, 2, DEFAULT_ENTRYPOINT)
  const flags = workerFetch(NEW_VERSION, 3, FLAGS_CACHE)
  const classified = fetchInvocation(flags)
  assert.equal(fetchInvocation(bare)?.kind, 'external')
  assert.equal(fetchInvocation(namedDefault)?.kind, 'external')
  assert.equal(classified?.kind, 'internal')
  if (classified?.kind === 'internal') assert.equal(classified.entrypoint, FLAGS_CACHE)
  assert.equal(fetchInvocation({ $metadata: { type: 'span' }, $workers: { eventType: 'fetch' } }), null)

  const events: ReturnType<typeof workerFetch>[] = []
  for (let n = 0; n < NEW_EXTERNAL; n++) events.push(workerFetch(NEW_VERSION, n, n === 0 ? null : DEFAULT_ENTRYPOINT))
  const flagsStart = NEW_EXTERNAL
  for (let n = 0; n < NEW_FLAGS; n++) {
    const extra = n === 0
      ? { outcome: 'exception', exceptions: [{ name: 'Error' }], wallTimeMs: INTERNAL_WALL_MS, cpuTimeMs: INTERNAL_WALL_MS }
      : {}
    events.push(workerFetch(NEW_VERSION, flagsStart + n, FLAGS_CACHE, extra))
  }
  const oldStart = flagsStart + NEW_FLAGS
  for (let n = 0; n < OLD_EXTERNAL; n++) events.push(workerFetch(OLD_VERSION, oldStart + n, DEFAULT_ENTRYPOINT))
  const gitIndex = oldStart + OLD_EXTERNAL
  events.push(workerFetch(OLD_VERSION, gitIndex, GIT_CACHE))

  const requestIds = new Set(events.map(event => event.$metadata.requestId))
  const rays = new Set(events.map(event => event.rayId))
  const traces = new Set(events.map(event => event.traceId))
  const inflated = events.length
  assert.equal(inflated, NEW_EXTERNAL + NEW_FLAGS + OLD_EXTERNAL + OLD_GIT)
  assert.equal(requestIds.size, inflated)
  assert.equal(rays.size, inflated)
  assert.equal(traces.size, inflated)

  const flagsId = eventIdentity(flagsStart)
  const logTrace = 'f'.repeat(32)
  const logRay = `${'e'.repeat(16)}-IAD`
  events.push({
    $metadata: { id: 'log-flags', requestId: flagsId.requestId, traceId: logTrace, type: 'log', service: 'ply', level: 'info' },
    rayId: logRay,
    traceId: logTrace,
    $workers: { scriptVersion: { id: NEW_VERSION }, outcome: 'ok' },
    source: { msg: 'ply.request', id: 'flags-log', status: 200, method: 'GET', path: '/v1/discover', ms: LOGGED_MS },
  } as ReturnType<typeof workerFetch>)

  const externalRay = eventIdentity(0).rayId
  const internalRay = flagsId.rayId
  const spans = [
    { rayId: externalRay, traceId: eventIdentity(0).traceId, name: 'fetch', durationMs: EXTERNAL_FETCH_MS, $metadata: { type: 'span', requestId: null, traceId: eventIdentity(0).traceId } },
    { rayId: internalRay, traceId: flagsId.traceId, name: 'fetch', durationMs: INTERNAL_WALL_MS, $metadata: { type: 'span', requestId: null, traceId: flagsId.traceId } },
  ]
  const onNew = events.filter(event => (event.$workers.scriptVersion as { id: string }).id === NEW_VERSION)
  const onOld = events.filter(event => (event.$workers.scriptVersion as { id: string }).id === OLD_VERSION)
  const next = statsFromEvents(onNew, spans)
  const previous = statsFromEvents(onOld, spans)
  const aggregate = statsFromEvents(events, spans)

  assert.equal(next.invocations, NEW_EXTERNAL)
  assert.equal(previous.invocations, OLD_EXTERNAL)
  assert.equal(aggregate.invocations, NEW_EXTERNAL + OLD_EXTERNAL)
  assert.equal(next.requests, NEW_EXTERNAL)
  assert.equal(next.errors, 0)
  assert.equal(next.exceptions, 0)
  assert.equal(next.wallMs.includes(INTERNAL_WALL_MS), false)
  assert.equal(next.cpuMs.includes(INTERNAL_WALL_MS), false)
  assert.deepEqual(next.fetchMs, [EXTERNAL_FETCH_MS])
  assert.deepEqual(next.internal, [{ entrypoint: FLAGS_CACHE, count: NEW_FLAGS }])
  assert.deepEqual(previous.internal, [{ entrypoint: GIT_CACHE, count: OLD_GIT }])
  assert.equal(next.v1.length, 1)
  assert.equal(next.v1[0]?.exception, false)
  assert.equal(next.v1[0]?.wallMs, LOGGED_MS)

  const summary = summarizeTelemetry(NEW_VERSION, [], onNew, [])
  assert.equal(summary.invocations, NEW_EXTERNAL)
  assert.equal(summary.health.exceptions, 0)
  assert.equal(summary.health.nonOk, 0)

  const policy = loadPolicy(DEFAULT_POLICY_PATH).policy
  const targetPercent = policy.steps[0]?.percent
  if (targetPercent === undefined) throw new Error('policy has no step')
  const counted = routedShare(next.invocations, aggregate.invocations, targetPercent, policy.split.z)
  const asFetched = routedShare(NEW_EXTERNAL + NEW_FLAGS, inflated, targetPercent, policy.split.z)
  assert.equal(percentText(asFetched.share), '14.25')
  assert.equal(asFetched.kind, 'mismatch')
  assert.equal(`${percentText(asFetched.low)}..${percentText(asFetched.high)}`, '8.02..11.98')
  assert.equal(percentText(counted.share), '10.27')
  assert.equal(counted.kind, 'match')
  assert.equal(counted.newRequests, NEW_EXTERNAL)
  assert.equal(counted.n, NEW_EXTERNAL + OLD_EXTERNAL)
  assert.ok(counted.share !== null && asFetched.low !== null && asFetched.high !== null)
  if (counted.share !== null && asFetched.low !== null && asFetched.high !== null) {
    assert.ok(counted.share >= asFetched.low && counted.share <= asFetched.high)
  }
  const decision = judgeStep({ next, previous, aggregate, targetPercent, policy })
  assert.equal(decision.outcome, 'advance')
  const line = progressLine({
    step: 1,
    steps: policy.steps.length,
    percent: targetPercent,
    next,
    previous,
    carriedPrevious: null,
    share: counted,
    decision,
    latency: policy.gates.latency.mode,
    probe: { kind: 'none' },
  })
  assert.match(line, new RegExp(`samples=${NEW_EXTERNAL}/${OLD_EXTERNAL}`))
  assert.match(line, /routed_share=10.27/)
  assert.match(line, /tolerance=7.98..12.02/)
  assert.match(line, new RegExp(`agg=${NEW_EXTERNAL + OLD_EXTERNAL}`))
  assert.match(line, new RegExp(`internal_next=${FLAGS_CACHE}:${NEW_FLAGS}`))
  assert.match(line, new RegExp(`internal_previous=${GIT_CACHE}:${OLD_GIT}`))
  assert.match(line, /decision=advance/)
  assert.equal(line.includes('reason='), false)
})

/** N smoke requests; the first `lost` have no log, invocation or trace. Each traced one has its own ray. */
function lossFixture(total: number, lost: number, status = 200) {
  const requests: SmokeRequest[] = []
  const events: unknown[] = []
  const spans: unknown[] = []
  for (let i = 0; i < total; i++) {
    const hex = i.toString(16).padStart(12, '0')
    const id = `44444444-4444-4444-8444-${hex}`
    const requestId = `dddddddd-dddd-4ddd-8ddd-${hex}`
    const ray = `${hex}abcd-IAD`
    const trace = `${hex}${'e'.repeat(20)}`
    requests.push({ ...smoke(id, ray, status), step: `step-${i}` })
    if (i < lost) continue
    events.push(logEvent(id, requestId, trace, status), invocation(id, requestId, trace))
    spans.push(spanEvent('fetch', 20, ray, trace))
  }
  return { requests, summary: summarizeTelemetry(VERSION, requests, events, spans) }
}

const LOSS_TOTAL = 79
const LOSS_SEEN = 6

test('telemetry loss below maxLossRate is informational, with count, rate and ids', () => {
  const { requests, summary } = lossFixture(LOSS_TOTAL, LOSS_SEEN)
  const loss = telemetryLoss(requests, summary, DEFAULT_MAX_LOSS_RATE)
  assert.equal(loss.count, LOSS_SEEN)
  assert.equal(loss.total, LOSS_TOTAL)
  assert.equal(loss.rate, LOSS_SEEN / LOSS_TOTAL)
  assert.equal(loss.exceeded, false)
  assert.deepEqual(loss.ids.map(lost => lost.step), requests.slice(0, LOSS_SEEN).map(request => request.step))
  assert.ok(loss.ids.every(lost => lost.log && lost.trace))
  const judge = judgeSmokeTelemetry({ version: VERSION, requests, summary, ceilings: SMOKE_LATENCY, maxLossRate: DEFAULT_MAX_LOSS_RATE })
  assert.equal(judge.kind, 'pass')
  assert.match(judge.line, /telemetry loss 6\/79 .* informational/)
})

test('telemetry loss above maxLossRate is a harness fault', () => {
  const lost = Math.ceil(LOSS_TOTAL * DEFAULT_MAX_LOSS_RATE) + 1
  const { requests, summary } = lossFixture(LOSS_TOTAL, lost)
  const judge = judgeSmokeTelemetry({ version: VERSION, requests, summary, ceilings: SMOKE_LATENCY, maxLossRate: DEFAULT_MAX_LOSS_RATE })
  assert.equal(judge.kind, 'harness_fault')
  if (judge.kind === 'harness_fault') assert.match(judge.reason, /telemetry-loss: telemetry loss/)
})

test('a tight maxLossRate fails the same loss the default tolerates', () => {
  const { requests, summary } = lossFixture(LOSS_TOTAL, LOSS_SEEN)
  const tight = (LOSS_SEEN - 1) / LOSS_TOTAL
  const judge = judgeSmokeTelemetry({ version: VERSION, requests, summary, ceilings: SMOKE_LATENCY, maxLossRate: tight })
  assert.equal(judge.kind, 'harness_fault')
})

test('loss never hides a correctness fault: a 5xx with loss is still a worker fault', () => {
  const { requests, summary } = lossFixture(LOSS_TOTAL, LOSS_SEEN, 500)
  const judge = judgeSmokeTelemetry({ version: VERSION, requests, summary, ceilings: SMOKE_LATENCY, maxLossRate: DEFAULT_MAX_LOSS_RATE })
  assert.equal(judge.kind, 'worker')
})
