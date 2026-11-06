// scripts/calibrate (issue #73): the statistics are pure and run on a recorded query response; the query adapter runs
// through the CD's own cf path with a fake runner. No credentials, no network.
//
// test/fixtures/calibrate/spans.json is shaped like a `cf o11y telemetry query` events page (events.events[], each with
// `source`, `dataset`, `timestamp`, `$metadata`), as test/fixtures/cd/canary-spans.json recorded from prod: its first
// event is that file's real runtime fetch span, unchanged. The ply spans after it carry ply's attributes as single
// dotted keys under `source`; the request spans at the end carry theirs nested by dot, the way the runtime nests its own
// (`source.http.response.status_code`). The statistics read both shapes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { useCfRunner, type CfResult } from '../scripts/cd/cf.ts'
import { TELEMETRY_PAGE } from '../scripts/cd/baseline.ts'
import { unwrapEvents } from '../scripts/cd/telemetry.ts'
import { driftMarkdown, evaluate, fixtureEvents, parseArgs, parseDuration } from '../scripts/calibrate/main.ts'
import { checkBands, citationFor, readRegistry, type Metric } from '../scripts/calibrate/provenance.ts'
import { citedQuery, querySpanEvents, slices } from '../scripts/calibrate/query.ts'
import {
  ALL_ROUTES,
  API_GROUP,
  bucketUpper,
  calibrationStats,
  distribution,
  EVERYTHING,
  eventAttributes,
  flattenAttributes,
  groupOf,
  numericOf,
  log2Histogram,
  statsText,
  UNROUTED,
  type CalibrationStats,
  type Distribution,
  type GroupStats,
} from '../scripts/calibrate/stats.ts'

const FIXTURE_PATH = new URL('./fixtures/calibrate/spans.json', import.meta.url)
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8')
const EVENTS = unwrapEvents(JSON.parse(FIXTURE_TEXT))
const V1 = 'bb0907e1-99f6-4a4f-8254-841909b33bdf'
const V2 = '19ee3cab-0000-4000-8000-000000000002'

/** One attribute's distribution; a missing one fails the test here, not as a TypeError later. */
function dist(stats: CalibrationStats, route: string, attribute: string): Distribution {
  const found = numericOf(stats, route, attribute)
  assert.ok(found, `${route} ${attribute}`)
  return found
}

function group(stats: CalibrationStats, route: string): GroupStats {
  const found = groupOf(stats, route)
  assert.ok(found, route)
  return found
}

test('distribution: n, observed percentiles (the CD\'s floor((n-1)p) rule), max, and a log2 histogram', () => {
  const values = Array.from({ length: 1000 }, (_, i) => i + 1)
  const dist = distribution(values)
  assert.ok(dist)
  assert.deepEqual([dist.n, dist.min, dist.p50, dist.p90, dist.p99, dist.p999, dist.max], [1000, 1, 500, 900, 990, 999, 1000])
  assert.equal(distribution([]), null)
  assert.equal(distribution([Number.NaN]), null)
  const one = distribution([7])
  assert.ok(one)
  assert.deepEqual([one.n, one.p50, one.p999, one.max], [1, 7, 7, 7])
  assert.deepEqual([0, 0.5, 1, 1.5, 2, 3, 1024, 1025, -3].map(bucketUpper), [1, 1, 1, 2, 2, 4, 1024, 2048, 0])
  assert.deepEqual(log2Histogram([0, 1, 2, 3, 4, 5, 1000]), [{ upper: 1, count: 2 }, { upper: 2, count: 1 }, { upper: 4, count: 2 }, { upper: 8, count: 1 }, { upper: 1024, count: 1 }])
  assert.equal(dist.histogram.reduce((sum, bucket) => sum + bucket.count, 0), 1000)
})

test('attributes are read as dotted keys or nested objects; a literal dotted key wins', () => {
  assert.deepEqual(flattenAttributes({ git: { pack: { bytes: 3 } }, 'git.ls_tree.entries': 9, http: { response: { status_code: 200 } } }), {
    'git.pack.bytes': 3,
    'git.ls_tree.entries': 9,
    'http.response.status_code': 200,
  })
  assert.deepEqual(flattenAttributes({ 'git.pack.bytes': 5, git: { pack: { bytes: 4 } } }), { 'git.pack.bytes': 5 })
  // The real runtime fetch span: no ply.route, so unrouted; the version is the runtime's own script version.
  const fetch = eventAttributes(EVENTS[0])
  assert.ok(fetch)
  assert.equal(fetch.route, UNROUTED)
  assert.equal(fetch.version, V1)
  assert.equal(eventAttributes({ $metadata: {} }), null)
})

test('the fixture window, per route: every input attribute\'s distribution, categorical counts, versions', () => {
  const stats = calibrationStats(EVENTS)
  assert.equal(stats.events, EVENTS.length)
  assert.deepEqual(stats.groups.map(group => group.route), [ALL_ROUTES, API_GROUP, 'GET /v1/refs', 'GET /v1/tree', 'POST /v1/edit', UNROUTED, 'viewer'])
  const tree = group(stats, 'GET /v1/tree')
  assert.deepEqual(tree.versions, [V2, V1].sort())
  const entries = dist(stats, 'GET /v1/tree', 'git.ls_tree.entries')
  assert.deepEqual([entries.n, entries.p50, entries.p90, entries.p99, entries.p999, entries.max], [120, 60, 108, 118, 119, 120])
  assert.equal(numericOf(stats, 'GET /v1/tree', 'git.protocol.version'), null, 'a protocol constant is not an input distribution')
  assert.deepEqual(tree.categorical['git.response.cache'], { MISS: 80, HIT: 40 })
  assert.deepEqual(tree.categorical['git.ls_tree.outcome'], { ok: 117, error: 3 })
  assert.deepEqual(tree.categorical['error.type'], { not_found: 3 })
  // Request spans (nested attributes): the route's counts and its status and error code.
  const refs = group(stats, 'GET /v1/refs')
  assert.equal(dist(stats, 'GET /v1/refs', 'ply.spans').n, 5)
  assert.deepEqual(refs.categorical['http.response.status_code'], { 200: 4, 404: 1 })
  assert.deepEqual(refs.categorical['ply.error.code'], { not_found: 1 })
  // `api` is every /v1 route; `*` adds the viewer and unrouted spans.
  assert.equal(dist(stats, API_GROUP, 'git.pack.bytes').n, 120)
  assert.equal(dist(stats, ALL_ROUTES, 'git.pack.bytes').n, 130)
  // A long tail: p99.9 and max differ on a small n only by the floor rule.
  const push = dist(stats, 'POST /v1/edit', 'git.push.pack.bytes')
  assert.deepEqual([push.n, push.p50, push.max], [40, 332, 2 ** 20])
})

test('route, version and attribute filters', () => {
  const v2 = calibrationStats(EVENTS, { ...EVERYTHING, versions: [V2] })
  assert.equal(v2.events, 80)
  assert.equal(dist(v2, 'GET /v1/tree', 'git.ls_tree.entries').min, 81)
  const only = calibrationStats(EVENTS, { ...EVERYTHING, routes: ['viewer'], attributes: ['git.pack.chain.max'] })
  assert.deepEqual(only.groups.map(group => group.route), [ALL_ROUTES, API_GROUP, 'viewer'])
  assert.deepEqual(Object.keys(group(only, 'viewer').numeric), ['git.pack.chain.max'])
  assert.equal(group(only, API_GROUP).events, 0)
})

test('the printed report has, per route and attribute, n, p50/p90/p99/p99.9 and max, and the histogram', () => {
  const text = statsText(calibrationStats(EVENTS), { from: 0, to: 1000 })
  assert.match(text, /^calibrate: 1970-01-01T00:00:00\.000Z \.\. 1970-01-01T00:00:01\.000Z span events=296 skipped=0$/m)
  assert.match(text, /^route GET \/v1\/tree events=240 /m)
  assert.match(text, /^ {4}git\.ls_tree\.entries n=120 p50=60 p90=108 p99=118 p99\.9=119 max=120$/m)
  assert.match(text, /^ {6}<= +128 +56 #+$/m)
  assert.match(text, /^ {4}git\.response\.cache MISS=80 HIT=40$/m)
  assert.doesNotMatch(statsText(calibrationStats(EVENTS), { from: 0, to: 1000 }, false), /<=/)
})

const METRIC: Metric = { attribute: 'git.ls_tree.entries', route: 'GET /v1/tree', quantile: 0.99, headroom: 2, band: 2 }

function registry(entries: Record<string, unknown>, minN = 30) {
  const parsed = readRegistry({ minN: { value: minN, status: 'PRIOR (uncalibrated)', why: 'test' }, thresholds: entries })
  assert.deepEqual(parsed.problems, [])
  return parsed.registry
}

const CITED = { status: 'calibrated', source: 'run x', query: 'q', window: 'w', date: '2026-11-01', n: 120, percentile: 'p99', headroom: 'x2' }

test('bands: tight below the observed quantile; drift outside band x headroom; priors report a suggestion', () => {
  const stats = calibrationStats(EVENTS)
  // p99 of entries is 118; suggested is 236; the band is 118..472.
  const results = checkBands(registry({
    'a:ok': { ...CITED, value: 236, metric: METRIC },
    'a:loose': { ...CITED, value: 1000, metric: METRIC },
    'a:tight': { ...CITED, value: 100, metric: METRIC },
    'a:prior': { value: 5000, status: 'PRIOR (uncalibrated)', why: 'test', metric: METRIC },
    'a:prior-tight': { value: 50, status: 'PRIOR (uncalibrated)', why: 'test', metric: METRIC },
    'a:thin': { ...CITED, value: 10, metric: { ...METRIC, route: 'viewer', attribute: 'git.pack.chain.max' } },
    'a:none': { value: 1, status: 'PRIOR (uncalibrated)', why: 'no metric' },
  }), stats)
  assert.deepEqual(results.map(r => [r.key, r.verdict]), [
    ['a:loose', 'drift'],
    ['a:ok', 'ok'],
    ['a:prior', 'uncalibrated'],
    ['a:prior-tight', 'tight'],
    ['a:thin', 'insufficient'],
    ['a:tight', 'tight'],
  ])
  const line = (key: string): string => {
    const found = results.find(r => r.key === key)
    assert.ok(found, key)
    return found.line
  }
  assert.equal(line('a:loose'), 'drift a:loose=1000 git.ls_tree.entries@GET /v1/tree q0.99: n=120 observed=118 suggested=236 (x2); outside 118..472')
  assert.equal(line('a:thin'), 'insufficient a:thin=10 git.pack.chain.max@viewer q0.99: n=10 < 30')
})

test('a citation block cites the query, window, date, n, percentile and headroom', () => {
  const stats = calibrationStats(EVENTS)
  const query = citedQuery({ worker: 'ply', from: Date.parse('2026-11-01T00:00:00Z'), to: Date.parse('2026-11-08T00:00:00Z'), sliceMs: 3_600_000 })
  const block = citationFor({ metric: METRIC, stats, query, from: query.timeframe.from, to: query.timeframe.to, source: 'scripts/calibrate test' })
  assert.ok(block)
  assert.equal(block.value, 236)
  assert.equal(block.n, 120)
  assert.equal(block.date, '2026-11-08')
  assert.equal(block.window, '2026-11-01T00:00:00.000Z..2026-11-08T00:00:00.000Z')
  assert.equal(block.percentile, 'git.ls_tree.entries @ GET /v1/tree q0.99 = 118')
  assert.match(String(block.query), /"\$metadata\.type".*"span"/)
  // The block is itself a valid calibrated entry.
  assert.deepEqual(readRegistry({ minN: { value: 1, status: 'PRIOR (uncalibrated)', why: 't' }, thresholds: { 'a:b': block } }).problems, [])
  assert.equal(citationFor({ metric: { ...METRIC, attribute: 'git.nope' }, stats, query, from: 0, to: 1, source: 's' }), null)
})

test('the query adapter slices the window and pages each slice through cf o11y telemetry query', async () => {
  assert.deepEqual(slices(0, 250, 100), [{ from: 0, to: 100 }, { from: 100, to: 200 }, { from: 200, to: 250 }])
  assert.throws(() => slices(10, 10, 5), /end after/)
  assert.throws(() => slices(0, 10, 0), /positive/)
  const bodies: Record<string, unknown>[] = []
  // A full first page forces a second page (the CD's cursor rule); then a short page ends the slice.
  const full = { events: { events: Array.from({ length: TELEMETRY_PAGE }, (_, i) => ({ ...(EVENTS[1] as object), $metadata: { id: `page-${i}`, type: 'span' } })), count: TELEMETRY_PAGE } }
  try {
    let calls = 0
    useCfRunner(async (args): Promise<CfResult> => {
      assert.deepEqual(args.slice(0, 4), ['o11y', 'telemetry', 'query', '--body'])
      const body = JSON.parse(String(args[4])) as Record<string, unknown>
      bodies.push(body)
      calls += 1
      // A banner before the JSON, as cf prints one; the second call times out once and is retried.
      if (calls === 2) return { code: 1, stdout: '', stderr: 'APIError: timeout Envelope Error' }
      const page = calls === 1 ? JSON.stringify(full) : FIXTURE_TEXT
      return { code: 0, stdout: `cf o11y\n${page}`, stderr: '' }
    })
    const retry = { bound: { attempts: 3, backoffMs: 1 }, sleep: async () => {}, note: async () => {} }
    const events = await querySpanEvents({ worker: 'ply', from: 0, to: 7_200_000, sliceMs: 3_600_000 }, retry)
    assert.equal(events.length, TELEMETRY_PAGE + 2 * EVENTS.length)
  } finally {
    useCfRunner(null)
  }
  assert.equal(bodies.length, 4)
  const firstBody = bodies[0]
  assert.ok(firstBody)
  const filters = (firstBody.parameters as { filters: unknown[] }).filters
  assert.deepEqual(filters, [
    { key: '$metadata.service', operation: 'eq', type: 'string', value: 'ply' },
    { key: '$metadata.type', operation: 'eq', type: 'string', value: 'span' },
  ])
  assert.deepEqual(bodies.map(body => body.timeframe), [{ from: 0, to: 3_600_000 }, { from: 0, to: 3_600_000 }, { from: 0, to: 3_600_000 }, { from: 3_600_000, to: 7_200_000 }])
  assert.equal(bodies[1].offset, `page-${TELEMETRY_PAGE - 1}`)
})

test('cli arguments: window, filters, and errors', () => {
  const now = Date.parse('2026-11-08T00:00:00Z')
  const args = parseArgs(['--since', '7d', '--route', 'GET /v1/tree', '--route', 'viewer', '--check'], now, {})
  assert.equal(args.to - args.from, 7 * 86_400_000)
  assert.deepEqual(args.routes, ['GET /v1/tree', 'viewer'])
  assert.equal(args.check, true)
  assert.equal(args.worker, 'ply')
  assert.equal(parseArgs([], now, { PLY_WORKER: 'ply-staging' }).worker, 'ply-staging')
  const fixed = parseArgs(['--from', '2026-11-01T00:00:00Z', '--to', '2026-11-02T00:00:00Z'], now, {})
  assert.equal(fixed.to - fixed.from, 86_400_000)
  assert.equal(parseDuration('90m'), 5_400_000)
  assert.throws(() => parseDuration('7w'), /not <n>m/)
  assert.throws(() => parseArgs(['--bogus', '1'], now, {}), /unknown option/)
  assert.throws(() => parseArgs(['--since', '1d', '--from', '2026-11-01'], now, {}), /exclusive/)
  assert.throws(() => parseArgs(['--from', '2026-11-03T00:00:00Z', '--to', '2026-11-02T00:00:00Z'], now, {}), /end after/)
})

test('--check over the fixture: the checked-in registry is in band (thin metrics are insufficient, not drift)', () => {
  const args = parseArgs(['--from', '2026-11-01T00:00:00Z', '--to', '2026-11-02T00:00:00Z', '--check', '--no-histogram', '--cite', 'api:maxPackBytes'], 0, {})
  const outcome = evaluate(args, fixtureEvents([FIXTURE_TEXT]), 'fixture')
  assert.equal(outcome.code, 0, outcome.text)
  assert.deepEqual(outcome.problems, [])
  assert.ok(outcome.bands.length > 0)
  assert.ok(outcome.bands.every(band => band.verdict === 'insufficient' || band.verdict === 'uncalibrated' || band.verdict === 'ok'))
  assert.match(outcome.text, /^cite api:maxPackBytes:$/m)
  assert.match(outcome.text, /^check: ok$/m)
})

test('--check fails on a threshold out of band, and the issue body names it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calibrate-'))
  try {
    const path = join(dir, 'thresholds.json')
    const raw = JSON.parse(readFileSync(new URL('../scripts/calibrate/thresholds.json', import.meta.url), 'utf8')) as { thresholds: Record<string, Record<string, unknown>> }
    // Point one threshold (100) at a distribution whose p99.9 is 119: it no longer holds the traffic it bounds.
    raw.thresholds['viewer:maxTagsShown'] = { ...raw.thresholds['viewer:maxTagsShown'], metric: { attribute: 'git.ls_tree.entries', route: 'GET /v1/tree', quantile: 0.999, headroom: 1, band: 2 } }
    writeFileSync(path, JSON.stringify(raw))
    const args = parseArgs(['--from', '2026-11-01T00:00:00Z', '--to', '2026-11-02T00:00:00Z', '--check', '--registry', path], 0, {})
    const outcome = evaluate(args, fixtureEvents([FIXTURE_TEXT]), 'fixture')
    assert.equal(outcome.code, 1)
    // 100 tags shown < p99.9 119 tree entries: tight.
    assert.ok(outcome.bands.some(band => band.key === 'viewer:maxTagsShown' && band.verdict === 'tight'))
    const body = driftMarkdown({ from: args.from, to: args.to, events: outcome.stats.events, bands: outcome.bands, problems: outcome.problems })
    assert.match(body, /^## Thresholds out of band$/m)
    assert.match(body, /`tight viewer:maxTagsShown=100 git\.ls_tree\.entries@GET \/v1\/tree q0\.999: n=120 observed=119/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
