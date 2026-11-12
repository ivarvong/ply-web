// The rate limiter's silent-degradation gate (docs/rate-limit.md "CD gate"). The limiter fails soft by design: a broken
// read admits (fail_open), a flush that cannot reach the counter is dropped after 5 s, and a missing counter binding
// sends every request to `legacy` (59926117 / e61a5742, 2026-11-06: ctx.exports.RateCounter was a function, so batched
// fell back to legacy and nothing alerted). Each of those is a 200 to the client, so the smoke and the error gates pass.
// This gate reads the version's own `ply.rate.check` / `ply.rate.flush` spans and fails it when:
//
//   mode       a default-mode check (not chosen by a load request's x-ply-rate-mode) ran a limiter other than the policy's
//   fail_open  warm default-mode checks failed open above maxFailOpenRate. A check the Worker stamps `rate.cold` is an
//              expected fail-open and is counted on its own line, out of the warm share: `isolate_start` (the isolate's
//              first read is in flight) and `memo_expired` (an idle isolate's document aged past MEMO_FALLBACK_MS;
//              ply-web#156). A memo_expired check whose own refresh then failed is put back as a warm failure.
//   dropped    flushes dropped (deadline or overflow) with no injected fault, above maxDroppedFlushes
//
// The gate sends its own pinned probes first (the viewer redirect route: rate-checked, no git work), carrying the load
// token and a run-unique client label but no mode header, so the version has default-mode checks even at 0% and the
// probes never spend the operator's address quota (the visual smoke shares it).
import { atIndex, dig, recordGet } from '../../src/absent.ts'
import { unwrapOr } from '../../src/option.ts'
import type { ExpectedCold } from '../../src/rate/admit.ts'
import type { RateGatePolicy } from './policy.ts'
import type { CountRow } from './o11y.ts'
import type { Filter } from './telemetry.ts'

/** Default-mode checks of one expected cold cause, and how many of them failed open. */
export type ColdTally = { readonly checks: number; readonly failOpen: number }

export const EXPECTED_COLD: readonly ExpectedCold[] = ['isolate_start', 'memo_expired']

export type RateCounts = {
  /** Default-mode checks by `rate.mode`. */
  readonly modes: Readonly<Record<string, number>>
  readonly defaultChecks: number
  readonly failOpen: number
  /** Default-mode checks stamped `rate.cold`, by cause: expected fail-opens, out of the warm share. */
  readonly cold: Readonly<Record<ExpectedCold, ColdTally>>
  /** `ply.rate.refresh` started by a memo_expired check, by outcome. A failed one is a warm read-path failure. */
  readonly expiredRefresh: { readonly ok: number; readonly failed: number }
  /** Checks whose mode a load request chose (excluded from every judgement). */
  readonly headerChecks: number
  readonly overflowDrops: number
  readonly flushes: number
  readonly droppedFlushes: number
  readonly faultedDrops: number
}

/** The warm share's inputs: expected cold checks out, memo_expired ones whose refresh failed back in. Pure. */
export function warmShare(counts: RateCounts): { readonly warm: number; readonly warmOpen: number; readonly back: number } {
  const coldChecks = EXPECTED_COLD.reduce((n, k) => n + counts.cold[k].checks, 0)
  const coldOpen = EXPECTED_COLD.reduce((n, k) => n + counts.cold[k].failOpen, 0)
  const back = Math.min(counts.expiredRefresh.failed, counts.cold.memo_expired.failOpen)
  return { warm: counts.defaultChecks - coldChecks + back, warmOpen: counts.failOpen - coldOpen + back, back }
}

export type RateVerdict =
  | { readonly kind: 'pass'; readonly line: string; readonly counts: RateCounts }
  | { readonly kind: 'worker'; readonly line: string; readonly counts: RateCounts; readonly failures: readonly string[] }
  | { readonly kind: 'harness_fault'; readonly line: string; readonly counts: RateCounts | null }

const PREFIX = 'rate:'

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`
}

/** Judge one window's counts. Pure. A mode or drop failure needs no minimum; the fail_open share needs minChecks. */
export function judgeRate(counts: RateCounts, policy: RateGatePolicy): RateVerdict {
  const failures: string[] = []
  const wrong = Object.entries(counts.modes).filter(([mode, n]) => mode !== policy.expectMode && n > 0)
  if (wrong.length > 0) {
    const seen = wrong.map(([mode, n]) => `${mode} ${n}`).join(', ')
    failures.push(`mode: ${seen} of ${counts.defaultChecks} default-mode checks ran a limiter other than ${policy.expectMode} (silent fallback; see 59926117)`)
  }
  const dropped = counts.droppedFlushes - counts.faultedDrops + counts.overflowDrops
  if (dropped > policy.maxDroppedFlushes) {
    failures.push(`dropped: ${dropped} batches lost without an injected fault (deadline ${counts.droppedFlushes - counts.faultedDrops}, overflow ${counts.overflowDrops}) of ${counts.flushes} flushes > ${policy.maxDroppedFlushes}`)
  }
  const { warm, warmOpen, back } = warmShare(counts)
  const share = warm > 0 ? warmOpen / warm : 0
  const { isolate_start: start, memo_expired: expired } = counts.cold
  const expected = `expected fail_open isolate_start ${start.failOpen}/${start.checks}, memo_expired ${expired.failOpen}/${expired.checks} (refresh ok ${counts.expiredRefresh.ok}, failed ${counts.expiredRefresh.failed}${back > 0 ? `, ${back} counted warm` : ''})`
  const summary = `default ${counts.defaultChecks}, fail_open warm ${warmOpen}/${warm} = ${pct(share)}; ${expected}; flushes ${counts.flushes} dropped ${dropped}, header-mode ${counts.headerChecks}`
  if (warm >= policy.minChecks && share > policy.maxFailOpenRate) {
    failures.push(`fail_open: ${warmOpen}/${warm} warm default-mode checks failed open = ${pct(share)} > ${pct(policy.maxFailOpenRate)}`)
  }
  if (failures.length > 0) return { kind: 'worker', line: `${PREFIX} FAIL ${failures.join('; ')} [${summary}]`, counts, failures }
  if (warm < policy.minChecks) {
    return { kind: 'harness_fault', line: `${PREFIX} ${warm} warm default-mode checks < minChecks ${policy.minChecks}: the fail_open share cannot be judged [${summary}]`, counts }
  }
  return { kind: 'pass', line: `${PREFIX} mode ${policy.expectMode} on every default check; ${summary}`, counts }
}

// ---- counting: from aggregate rows (production) or raw span events (tests, and a dump) ----

function sum(rows: readonly CountRow[], match: (g: Readonly<Record<string, string>>) => boolean = () => true): number {
  let n = 0
  for (const row of rows) if (match(row.groups)) n += row.count
  return n
}

/** The aggregate rows the gate's queries return, by query. */
export type RateRows = {
  /** ply.rate.check grouped by rate.mode, rate.decision. */
  readonly checks: readonly CountRow[]
  /** The same, only rate.mode_source = header. */
  readonly header: readonly CountRow[]
  /** ply.rate.check with rate.cold present, grouped by rate.cold, rate.mode_source, rate.decision. */
  readonly cold: readonly CountRow[]
  /** ply.rate.refresh with rate.refresh.cold = memo_expired, grouped by rate.refresh.read. */
  readonly expiredRefresh: readonly CountRow[]
  /** ply.rate.check with rate.batch.dropped present. */
  readonly overflow: readonly CountRow[]
  /** ply.rate.flush grouped by rate.batch.outcome. */
  readonly flushes: readonly CountRow[]
  /** ply.rate.flush, outcome dropped, rate.fault present. */
  readonly faulted: readonly CountRow[]
}

function bump(counts: Record<string, number>, key: string, by: number): void {
  const next = unwrapOr(recordGet(counts, key), 0) + by
  if (next === 0) delete counts[key]
  else counts[key] = next
}

function isExpectedCold(value: unknown): value is ExpectedCold {
  return EXPECTED_COLD.some(k => k === value)
}

function tallyCold(rows: readonly CountRow[]): Record<ExpectedCold, ColdTally> {
  const tally = (kind: ExpectedCold): ColdTally => ({
    checks: sum(rows, g => g['rate.cold'] === kind && g['rate.mode_source'] !== 'header'),
    failOpen: sum(rows, g => g['rate.cold'] === kind && g['rate.mode_source'] !== 'header' && g['rate.decision'] === 'fail_open'),
  })
  return { isolate_start: tally('isolate_start'), memo_expired: tally('memo_expired') }
}

export function countsFromRows(rows: RateRows): RateCounts {
  const modes: Record<string, number> = {}
  for (const row of rows.checks) bump(modes, unwrapOr(recordGet(row.groups, 'rate.mode'), '?'), row.count)
  for (const row of rows.header) bump(modes, unwrapOr(recordGet(row.groups, 'rate.mode'), '?'), -row.count)
  const failOpen = (g: Readonly<Record<string, string>>): boolean => g['rate.decision'] === 'fail_open'
  const refreshOk = sum(rows.expiredRefresh, g => g['rate.refresh.read'] === 'ok')
  return {
    modes,
    defaultChecks: sum(rows.checks) - sum(rows.header),
    failOpen: sum(rows.checks, failOpen) - sum(rows.header, failOpen),
    cold: tallyCold(rows.cold),
    expiredRefresh: { ok: refreshOk, failed: sum(rows.expiredRefresh) - refreshOk },
    headerChecks: sum(rows.header),
    overflowDrops: sum(rows.overflow),
    flushes: sum(rows.flushes),
    droppedFlushes: sum(rows.flushes, g => g['rate.batch.outcome'] === 'dropped'),
    faultedDrops: sum(rows.faulted),
  }
}

/** A span attribute under `source`, by dotted path. Absent is `null`. */
function attr(event: unknown, key: string): unknown {
  return unwrapOr(dig(event, ['source', ...key.split('.')]), null)
}

function spanName(event: unknown): string {
  const meta = dig(event, ['$metadata', 'spanName'])
  if (meta.tag === 'some' && typeof meta.value === 'string') return meta.value
  const name = attr(event, 'name')
  return typeof name === 'string' ? name : ''
}

/**
 * Counts from raw span events (Workers Observability `events` rows of `$metadata.type = span`). A check with no
 * `rate.mode_source` comes from a version that predates the attribute: it is judged as default-mode, so a load request's
 * header-chosen arm on such a version would count against it (the gate only runs on versions that stamp it).
 */
export function countsFromSpans(events: readonly unknown[], version: string): RateCounts {
  const modes: Record<string, number> = {}
  const cold: Record<ExpectedCold, { checks: number; failOpen: number }> = { isolate_start: { checks: 0, failOpen: 0 }, memo_expired: { checks: 0, failOpen: 0 } }
  const expiredRefresh = { ok: 0, failed: 0 }
  let defaultChecks = 0, failOpen = 0, headerChecks = 0, overflowDrops = 0, flushes = 0, droppedFlushes = 0, faultedDrops = 0
  for (const event of events) {
    if (attr(event, 'ply.script_version') !== version) continue
    const name = spanName(event)
    if (name === 'ply.rate.check') {
      if (attr(event, 'rate.batch.dropped') !== null) overflowDrops++
      if (attr(event, 'rate.mode_source') === 'header') { headerChecks++; continue }
      const mode = attr(event, 'rate.mode')
      bump(modes, mode === null ? '?' : String(mode), 1)
      defaultChecks++
      const open = attr(event, 'rate.decision') === 'fail_open'
      if (open) failOpen++
      const kind = attr(event, 'rate.cold')
      if (isExpectedCold(kind)) {
        cold[kind].checks++
        if (open) cold[kind].failOpen++
      }
    } else if (name === 'ply.rate.refresh') {
      if (attr(event, 'rate.refresh.cold') !== 'memo_expired') continue
      if (attr(event, 'rate.refresh.read') === 'ok') expiredRefresh.ok++
      else expiredRefresh.failed++
    } else if (name === 'ply.rate.flush') {
      flushes++
      if (attr(event, 'rate.batch.outcome') === 'dropped') {
        droppedFlushes++
        if (attr(event, 'rate.fault') !== null) faultedDrops++
      }
    }
  }
  return { modes, defaultChecks, failOpen, cold, expiredRefresh, headerChecks, overflowDrops, flushes, droppedFlushes, faultedDrops }
}

// ---- the queries ----

export type CountQuery = (filters: readonly Filter[], groupBys: readonly string[]) => Promise<CountRow[]>

function eq(key: string, value: string): Filter {
  return { key, operation: 'eq', type: 'string', value }
}

function exists(key: string): Filter {
  return { key, operation: 'exists', type: 'string', value: '' }
}

/** The seven aggregate queries, scoped to the Worker and to the version's own `ply.script_version` stamp. */
export async function queryRateRows(worker: string, version: string, count: CountQuery): Promise<RateRows> {
  const base = [eq('$metadata.service', worker), eq('ply.script_version', version)]
  const check = [...base, eq('$metadata.spanName', 'ply.rate.check')]
  const flush = [...base, eq('$metadata.spanName', 'ply.rate.flush')]
  const refresh = [...base, eq('$metadata.spanName', 'ply.rate.refresh')]
  const [checks, header, cold, expiredRefresh, overflow, flushes, faulted] = await Promise.all([
    count(check, ['rate.mode', 'rate.decision']),
    count([...check, eq('rate.mode_source', 'header')], ['rate.mode', 'rate.decision']),
    count([...check, exists('rate.cold')], ['rate.cold', 'rate.mode_source', 'rate.decision']),
    count([...refresh, eq('rate.refresh.cold', 'memo_expired')], ['rate.refresh.read']),
    count([...check, exists('rate.batch.dropped')], []),
    count(flush, ['rate.batch.outcome']),
    count([...flush, eq('rate.batch.outcome', 'dropped'), exists('rate.fault')], []),
  ])
  return { checks, header, cold, expiredRefresh, overflow, flushes, faulted }
}

// ---- the probes ----

export type ProbeIo = {
  readonly fetch: (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; body: unknown }>
  readonly sleep: (ms: number) => Promise<void>
}

export type ProbeResult = { readonly sent: number; readonly answered: number; readonly onVersion: number; readonly statuses: Readonly<Record<string, number>> }

/**
 * `policy.probes` sequential GETs of `policy.probePath`, pinned to `version`, as load client `label` (the load token
 * keeps them off the operator's address quota). No x-ply-rate-mode: they run the version's default limiter.
 */
export async function sendRateProbes(input: { readonly baseUrl: string; readonly worker: string; readonly version: string; readonly loadToken: string; readonly label: string; readonly policy: RateGatePolicy }, io: ProbeIo): Promise<ProbeResult> {
  const statuses: Record<string, number> = {}
  let answered = 0
  let onVersion = 0
  for (let i = 0; i < input.policy.probes; i++) {
    if (i > 0) await io.sleep(input.policy.probeGapMs)
    let status = 'error'
    try {
      const res = await io.fetch(`${input.baseUrl}${input.policy.probePath}`, {
        headers: {
          'cloudflare-workers-version-overrides': `${input.worker}="${input.version}"`,
          'x-ply-load-token': input.loadToken,
          'x-ply-rate-client': input.label,
          'user-agent': 'ply-cd-rate-gate/1',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      const cancel = dig(res, ['body', 'cancel'])
      if (cancel.tag === 'some' && typeof cancel.value === 'function') await Promise.resolve((cancel.value as () => Promise<void>).call(res.body)).catch(() => {})
      status = String(res.status)
      answered++
      if (res.headers.get('x-ply-version') === input.version) onVersion++
    } catch {
      status = 'error'
    }
    bump(statuses, status, 1)
  }
  return { sent: input.policy.probes, answered, onVersion, statuses }
}

export type RatePoll = {
  readonly query: () => Promise<RateCounts>
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly pollsMs: readonly number[]
  readonly waitMs: number
}

/**
 * Query and judge until the verdict is not a harness fault (enough warm checks ingested) or `waitMs` has passed. A
 * mode or drop failure is final at once: more data cannot undo a check that already ran the wrong limiter.
 */
export async function pollRate(policy: RateGatePolicy, poll: RatePoll): Promise<RateVerdict> {
  const started = poll.now()
  for (let attempt = 0; ; attempt++) {
    const verdict = judgeRate(await poll.query(), policy)
    const waited = poll.now() - started
    if (verdict.kind !== 'harness_fault' || waited >= poll.waitMs) return verdict
    const pause = unwrapOr(atIndex(poll.pollsMs, Math.min(attempt, poll.pollsMs.length - 1)), poll.waitMs)
    await poll.sleep(Math.min(pause, poll.waitMs - waited))
  }
}
