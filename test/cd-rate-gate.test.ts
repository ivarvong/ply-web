// The CD rate limiter silent-degradation gate (scripts/cd/rate-gate.ts, docs/rate-limit.md "CD gate").
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parsePolicy, DEFAULT_RATE_GATE, type RateGatePolicy } from '../scripts/cd/policy.ts'
import { countRows, type CountRow } from '../scripts/cd/o11y.ts'
import { countsFromRows, countsFromSpans, judgeRate, pollRate, queryRateRows, sendRateProbes, type RateCounts } from '../scripts/cd/rate-gate.ts'
import type { Filter } from '../scripts/cd/telemetry.ts'
import type { ExpectedCold } from '../src/rate/admit.ts'
import { dig, recordGet } from '../src/absent.ts'
import { unwrapOr } from '../src/option.ts'

const POLICY_TEXT = readFileSync(new URL('../scripts/cd/cd.policy.json', import.meta.url), 'utf8')
const POLICY: RateGatePolicy = parsePolicy(POLICY_TEXT).policy.rate

/** Real ply.rate.check spans of 59926117 and e61a5742 (2026-11-06): asked for batched, silently ran legacy. */
const SILENT = (JSON.parse(readFileSync(new URL('./fixtures/cd/rate-silent-legacy.json', import.meta.url), 'utf8')) as { events: unknown[] }).events
const V59926117 = '59926117-40f5-4d84-aa12-89eac76736b2'
const VE61A5742 = 'e61a5742-d17e-4adf-beda-0ed2e9e26272'

const V = 'aaaaaaaa-0000-4000-8000-000000000001'

type Check = Partial<{ mode: string; decision: string; source: 'default' | 'header'; cold: ExpectedCold; dropped: string }>

function check(c: Check, version = V): unknown {
  const field = (key: keyof Check, fallback: string): string => {
    const got = recordGet(c, key)
    return got.tag === 'some' ? String(got.value) : fallback
  }
  const rate: Record<string, unknown> = { mode: field('mode', 'memo'), decision: field('decision', 'allow'), mode_source: field('source', 'default'), bucket: 'page' }
  if (c.cold) rate.cold = c.cold
  if (c.dropped) rate.batch = { dropped: c.dropped }
  return { $metadata: { spanName: 'ply.rate.check', type: 'span' }, source: { name: 'ply.rate.check', rate, ply: { script_version: version, route: 'rate.check' } } }
}

function flush(outcome: 'ok' | 'dropped', fault: string | null = null, version = V): unknown {
  const rate: Record<string, unknown> = { batch: { outcome } }
  if (fault) rate.fault = fault
  return { $metadata: { spanName: 'ply.rate.flush', type: 'span' }, source: { name: 'ply.rate.flush', rate, ply: { script_version: version, route: 'rate.flush' } } }
}

/** A ply.rate.refresh span: `cold` is the cause the starting check stamped (rate.refresh.cold), read its outcome. */
function refresh(cold: string, read: string, version = V): unknown {
  return { $metadata: { spanName: 'ply.rate.refresh', type: 'span' }, source: { name: 'ply.rate.refresh', rate: { refresh: { trigger: 'cold', cold, read } }, ply: { script_version: version, route: 'rate.refresh' } } }
}

function times<T>(n: number, f: () => T): T[] {
  return Array.from({ length: n }, f)
}

const HEALTHY = [check({ cold: 'isolate_start', decision: 'fail_open' }), ...times(40, () => check({})), ...times(30, () => flush('ok'))]

test('policy: cd.policy.json carries the rate gate with its evidence', () => {
  assert.equal(POLICY.expectMode, 'memo')
  assert.equal(POLICY.maxDroppedFlushes, 0)
  assert.ok(POLICY.maxFailOpenRate > 0 && POLICY.maxFailOpenRate < 1)
  assert.ok(POLICY.minChecks <= POLICY.probes)
  assert.match(POLICY.calibration.observed, /128,753/)
  const body = JSON.parse(POLICY_TEXT) as Record<string, unknown>
  const { rate: _rate, ...without } = body
  assert.deepEqual(parsePolicy(JSON.stringify(without)).policy.rate, DEFAULT_RATE_GATE, 'omitted: the default')
  const bad = { ...body, rate: { ...(body.rate as object), minChecks: 31, probes: 30 } }
  assert.throws(() => parsePolicy(JSON.stringify(bad)), /rate.minChecks/)
  const unknown = { ...body, rate: { ...(body.rate as object), extra: 1 } }
  assert.throws(() => parsePolicy(JSON.stringify(unknown)), /unknown field/)
})

test('cloudflare.config.ts RATE_MODE is the mode the gate expects (one edit cannot ship without the other)', () => {
  const config = readFileSync(new URL('../cloudflare.config.ts', import.meta.url), 'utf8')
  const found = /RATE_MODE: bindings\.text\("(\w+)"\)/.exec(config)
  assert.ok(found, 'RATE_MODE binding in cloudflare.config.ts')
  assert.equal(found[1], POLICY.expectMode)
  assert.equal(DEFAULT_RATE_GATE.expectMode, POLICY.expectMode)
})

test('59926117 / e61a5742: the silent fallback to legacy fails the version (real spans)', () => {
  for (const version of [V59926117, VE61A5742]) {
    const counts = countsFromSpans(SILENT, version)
    assert.ok(unwrapOr(recordGet(counts.modes, 'legacy'), 0) > 0, version)
    assert.equal(unwrapOr(recordGet(counts.modes, 'batched'), 0), 0)
    assert.equal(unwrapOr(recordGet(counts.modes, 'memo'), 0), 0)
    const verdict = judgeRate(counts, POLICY)
    assert.equal(verdict.kind, 'worker', `${version}: ${verdict.line}`)
    assert.match(verdict.line, /mode: legacy \d+ of \d+ default-mode checks ran a limiter other than memo/)
  }
})

test('mode: a single default-mode check on the wrong limiter fails, with no minimum sample', () => {
  const verdict = judgeRate(countsFromSpans([check({ mode: 'legacy' })], V), POLICY)
  assert.equal(verdict.kind, 'worker')
  const batched = judgeRate(countsFromSpans([...HEALTHY, check({ mode: 'batched' })], V), POLICY)
  assert.equal(batched.kind, 'worker', 'batched is not the configured default either')
  // A deliberate rollback edits expectMode with RATE_MODE: the same spans then pass on batched.
  const rolledBack = judgeRate(countsFromSpans(times(30, () => check({ mode: 'batched' })), V), { ...POLICY, expectMode: 'batched' })
  assert.equal(rolledBack.kind, 'pass', rolledBack.line)
})

test('mode: load requests that chose their arm with x-ply-rate-mode are not judged', () => {
  const arms = [...HEALTHY, ...times(50, () => check({ mode: 'legacy', source: 'header' })), ...times(50, () => check({ mode: 'batched', source: 'header', decision: 'fail_open' }))]
  const verdict = judgeRate(countsFromSpans(arms, V), POLICY)
  assert.equal(verdict.kind, 'pass', verdict.line)
  assert.equal(verdict.kind === 'pass' ? verdict.counts.headerChecks : -1, 100)
})

test('healthy: memo everywhere, cold fail_open excluded, no drops → pass', () => {
  const verdict = judgeRate(countsFromSpans(HEALTHY, V), POLICY)
  assert.equal(verdict.kind, 'pass', verdict.line)
  assert.match(verdict.line, /fail_open warm 0\/40/)
})

test('fail_open: a warm share above the threshold fails; at it passes; cold isolates do not count', () => {
  const warm = 40
  const limit = Math.floor(warm * POLICY.maxFailOpenRate)
  const at = [...times(warm - limit, () => check({})), ...times(limit, () => check({ decision: 'fail_open' }))]
  assert.equal(judgeRate(countsFromSpans(at, V), POLICY).kind, 'pass')
  const over = [...times(warm - limit - 1, () => check({})), ...times(limit + 1, () => check({ decision: 'fail_open' }))]
  const failed = judgeRate(countsFromSpans(over, V), POLICY)
  assert.equal(failed.kind, 'worker')
  assert.match(failed.line, /fail_open: \d+\/40 warm default-mode checks failed open/)
  // A fresh canary: every isolate's first check fails open (no document yet). That is by design, not degradation.
  const fresh = [...times(15, () => check({ cold: 'isolate_start', decision: 'fail_open' })), ...times(30, () => check({}))]
  assert.equal(judgeRate(countsFromSpans(fresh, V), POLICY).kind, 'pass')
  // A broken read path: every warm check fails open.
  const broken = [...times(3, () => check({ cold: 'isolate_start', decision: 'fail_open' })), ...times(30, () => check({ decision: 'fail_open' }))]
  assert.equal(judgeRate(countsFromSpans(broken, V), POLICY).kind, 'worker')
})

// ply-web#156: the live window of CD 2026-11-12T13-06-51-511Z (33d69a40): 33 default-mode checks, 4 isolate starts, and
// one crawler request (cf-ray a595ccf10c639249) on isolate 2058502eefa348bb9abc after 339.4 s idle, whose memo had
// expired; its refresh read ok in 6 ms. Before the Worker stamped rate.cold = memo_expired, that read 1/29 warm.
const LIVE_156 = [
  ...times(4, () => check({ cold: 'isolate_start', decision: 'fail_open' })),
  check({ cold: 'memo_expired', decision: 'fail_open' }),
  refresh('memo_expired', 'ok'),
  ...times(28, () => check({})),
  ...times(33, () => flush('ok')),
]

test('#156: an idle isolate\'s expired memo is an expected fail_open, counted on its own, not in the warm share', () => {
  const verdict = judgeRate(countsFromSpans(LIVE_156, V), POLICY)
  assert.equal(verdict.kind, 'pass', verdict.line)
  assert.match(verdict.line, /fail_open warm 0\/28 = 0\.00%/)
  assert.match(verdict.line, /expected fail_open isolate_start 4\/4, memo_expired 1\/1 \(refresh ok 1, failed 0\)/)
  // Three idle expiries in one window: 3/31 = 9.7% warm before, a false rollback one expiry away. Now 0 warm.
  const three = [...LIVE_156, ...times(2, () => check({ cold: 'memo_expired', decision: 'fail_open' })), ...times(2, () => refresh('memo_expired', 'ok'))]
  const threeVerdict = judgeRate(countsFromSpans(three, V), POLICY)
  assert.equal(threeVerdict.kind, 'pass', threeVerdict.line)
  assert.match(threeVerdict.line, /fail_open warm 0\/28/)
  // The same three as read_failed (no document after a settled refresh) are real failures: 3/31 warm, and 4 fails.
  const broken = [...LIVE_156, ...times(4, () => check({ decision: 'fail_open' }))]
  const brokenVerdict = judgeRate(countsFromSpans(broken, V), POLICY)
  assert.equal(brokenVerdict.kind, 'worker', brokenVerdict.line)
  assert.match(brokenVerdict.line, /fail_open: 4\/32 warm/)
})

test('#156: an expired memo whose own refresh failed is a warm read-path failure', () => {
  const failedRefresh = [...LIVE_156.filter(e => e !== LIVE_156[5]), refresh('memo_expired', 'fail')]
  const counts = countsFromSpans(failedRefresh, V)
  assert.deepEqual(counts.expiredRefresh, { ok: 0, failed: 1 })
  const verdict = judgeRate(counts, POLICY)
  assert.match(verdict.line, /fail_open warm 1\/29 = 3\.45%/)
  assert.match(verdict.line, /1 counted warm/)
  // Enough of them fail the version, at the unchanged threshold.
  const many = [...failedRefresh, ...times(3, () => check({ cold: 'memo_expired', decision: 'fail_open' })), ...times(3, () => refresh('memo_expired', 'fail'))]
  const manyVerdict = judgeRate(countsFromSpans(many, V), POLICY)
  assert.equal(manyVerdict.kind, 'worker', manyVerdict.line)
  assert.match(manyVerdict.line, /fail_open: 4\/32 warm/)
})

test('dropped: one flush dropped without a fault fails; injected-fault drops do not; overflow does', () => {
  assert.equal(judgeRate(countsFromSpans([...HEALTHY, flush('dropped')], V), POLICY).kind, 'worker')
  const faulted = judgeRate(countsFromSpans([...HEALTHY, flush('dropped', 'error=0;attempts=2'), flush('dropped', 'slow-ack=9000;attempts=9')], V), POLICY)
  assert.equal(faulted.kind, 'pass', faulted.line)
  const overflow = judgeRate(countsFromSpans([...HEALTHY, check({ dropped: 'overflow' })], V), POLICY)
  assert.equal(overflow.kind, 'worker')
  assert.match(overflow.line, /overflow 1/)
})

test('too few warm checks: a harness fault, not a pass; a mode or drop failure still fails at once', () => {
  const few = judgeRate(countsFromSpans(times(5, () => check({})), V), POLICY)
  assert.equal(few.kind, 'harness_fault')
  assert.match(few.line, /< minChecks/)
  assert.equal(judgeRate(countsFromSpans([...times(5, () => check({})), flush('dropped')], V), POLICY).kind, 'worker')
})

test('other versions in the window are ignored', () => {
  const mixed = [...HEALTHY, ...times(10, () => check({ mode: 'legacy' }, 'bbbbbbbb-0000-4000-8000-000000000002')), flush('dropped', null, 'bbbbbbbb-0000-4000-8000-000000000002')]
  assert.equal(judgeRate(countsFromSpans(mixed, V), POLICY).kind, 'pass')
})

/** What Workers Observability's grouped counts return for a set of span events: a key absent on an event drops it. */
function aggregate(events: readonly unknown[], filter: (rate: Record<string, unknown>, name: string) => boolean, groupBys: readonly string[]): CountRow[] {
  const rows = new Map<string, CountRow>()
  for (const e of events) {
    const source = (e as { source: Record<string, unknown> }).source
    const rate = dig(source, ['rate'])
    if (!filter((rate.tag === 'some' ? rate.value : {}) as Record<string, unknown>, String(source.name))) continue
    const groups: Record<string, string> = {}
    let complete = true
    for (const key of groupBys) {
      const v = dig(source, key.split('.'))
      if (v.tag === 'none') complete = false
      else groups[key] = String(v.value)
    }
    if (!complete) continue
    const id = JSON.stringify(groups)
    const prev = rows.get(id)
    rows.set(id, { groups, count: (prev ? prev.count : 0) + 1 })
  }
  return [...rows.values()]
}

test('countsFromRows (the production aggregate path) agrees with countsFromSpans', async () => {
  const events = [
    ...HEALTHY,
    ...times(7, () => check({ decision: 'fail_open' })),
    ...times(3, () => check({ cold: 'isolate_start' })),
    ...times(4, () => check({ mode: 'legacy', source: 'header' })),
    ...times(2, () => check({ mode: 'batched', source: 'header', decision: 'fail_open', cold: 'isolate_start' })),
    ...times(2, () => check({ cold: 'memo_expired', decision: 'fail_open' })),
    check({ cold: 'memo_expired', decision: 'fail_open', source: 'header' }),
    refresh('memo_expired', 'ok'),
    refresh('memo_expired', 'fail'),
    refresh('isolate_start', 'fail'),
    check({ dropped: 'overflow' }),
    flush('dropped'),
    flush('dropped', 'error=0;attempts=2'),
  ]
  const seen: { filters: readonly Filter[]; groupBys: readonly string[] }[] = []
  const rows = await queryRateRows('ply', V, async (filters, groupBys) => {
    seen.push({ filters, groupBys })
    const has = (key: string, value: string | null = null) => filters.some(f => f.key === key && (value === null || f.value === value))
    const named = filters.find(f => f.key === '$metadata.spanName')
    const name = named ? named.value : ''
    return aggregate(events, (rate, n) => {
      if (n !== name) return false
      if (has('rate.mode_source', 'header') && rate.mode_source !== 'header') return false
      if (has('rate.cold') && dig(rate, ['cold']).tag === 'none') return false
      if (has('rate.refresh.cold', 'memo_expired') && unwrapOr(dig(rate, ['refresh', 'cold']), '') !== 'memo_expired') return false
      if (has('rate.batch.dropped') && dig(rate, ['batch', 'dropped']).tag === 'none') return false
      if (has('rate.batch.outcome', 'dropped') && unwrapOr(dig(rate, ['batch', 'outcome']), '') !== 'dropped') return false
      if (has('rate.fault') && dig(rate, ['fault']).tag === 'none') return false
      return true
    }, groupBys)
  })
  assert.deepEqual(countsFromRows(rows), countsFromSpans(events, V))
  assert.equal(seen.length, 7)
  for (const q of seen) {
    assert.ok(q.filters.some(f => f.key === 'ply.script_version' && f.value === V), 'every query is scoped to the version')
    assert.ok(q.filters.some(f => f.key === '$metadata.service' && f.value === 'ply'))
  }
  const cold = seen.find(q => q.filters.some(f => f.key === 'rate.cold'))
  assert.ok(cold)
  assert.deepEqual(cold.filters.find(f => f.key === 'rate.cold'), { key: 'rate.cold', operation: 'exists', type: 'string', value: '' })
  assert.deepEqual(cold.groupBys, ['rate.cold', 'rate.mode_source', 'rate.decision'])
  const expired = seen.find(q => q.filters.some(f => f.key === 'rate.refresh.cold'))
  assert.ok(expired)
  assert.deepEqual(expired.groupBys, ['rate.refresh.read'])
  const counts = countsFromRows(rows)
  assert.deepEqual(counts.cold.memo_expired, { checks: 2, failOpen: 2 }, 'the header-mode one is not judged')
  assert.deepEqual(counts.expiredRefresh, { ok: 1, failed: 1 })
})

test('countRows reads a calculations response, grouped and ungrouped', () => {
  const grouped = { calculations: [{ aggregates: [{ groups: [{ key: 'rate.mode', value: 'batched' }, { key: 'rate.decision', value: 'allow' }], count: 12 }] }] }
  assert.deepEqual(countRows(grouped), [{ groups: { 'rate.mode': 'batched', 'rate.decision': 'allow' }, count: 12 }])
  assert.deepEqual(countRows({ calculations: [{ aggregates: [{ value: 0, count: 0 }] }] }), [{ groups: {}, count: 0 }])
  assert.throws(() => countRows({ events: [] }), /no calculations/)
})

test('pollRate: re-queries while too few checks are ingested, then judges; gives up at waitMs', async () => {
  let t = 0
  const pages: RateCounts[] = [countsFromSpans(times(3, () => check({})), V), countsFromSpans(times(12, () => check({})), V), countsFromSpans(HEALTHY, V)]
  let i = 0
  const verdict = await pollRate(POLICY, { query: async () => pages[Math.min(i++, pages.length - 1)] as RateCounts, sleep: async ms => { t += ms }, now: () => t, pollsMs: [3_000], waitMs: 60_000 })
  assert.equal(verdict.kind, 'pass')
  assert.equal(i, 3)
  t = 0
  const stuck = await pollRate(POLICY, { query: async () => countsFromSpans([], V), sleep: async ms => { t += ms }, now: () => t, pollsMs: [3_000], waitMs: 10_000 })
  assert.equal(stuck.kind, 'harness_fault')
  assert.ok(t <= 10_000)
})

test('probes: pinned, carry the load token and a run label, never a mode header; manual redirects', async () => {
  const sent: { url: string; headers: Record<string, string>; redirect: string }[] = []
  const r = await sendRateProbes({ baseUrl: 'https://ply.example', worker: 'ply', version: V, loadToken: 'load-secret', label: 'cd-rate:run1:canary', policy: { ...POLICY, probes: 4, probeGapMs: 0 } }, {
    fetch: async (url, init) => {
      sent.push({ url, headers: init.headers, redirect: init.redirect })
      const n = sent.length
      if (n === 4) throw new Error('network')
      return { status: n === 3 ? 429 : 302, headers: { get: (h: string) => (h === 'x-ply-version' ? (n === 2 ? 'other' : V) : null) }, body: null }
    },
    sleep: async () => {},
  })
  assert.deepEqual(r, { sent: 4, answered: 3, onVersion: 2, statuses: { 302: 2, 429: 1, error: 1 } })
  for (const s of sent) {
    assert.equal(s.url, `https://ply.example${POLICY.probePath}`)
    assert.equal(s.headers['cloudflare-workers-version-overrides'], `ply="${V}"`)
    assert.equal(s.headers['x-ply-load-token'], 'load-secret')
    assert.equal(s.headers['x-ply-rate-client'], 'cd-rate:run1:canary')
    assert.equal('x-ply-rate-mode' in s.headers, false, 'the probes must run the default limiter')
    assert.equal(s.redirect, 'manual')
  }
})
