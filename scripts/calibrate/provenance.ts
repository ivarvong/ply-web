// Every threshold cites its source or says it is a prior (issue #73). Pure: the registry is
// scripts/calibrate/thresholds.json, the current thresholds are passed in (scripts/calibrate/current.ts reads them from
// cd.policy.json and the limits modules), and the distributions are scripts/calibrate/stats.ts output.
//
//   provenanceProblems  a threshold with no entry, an entry whose value is stale, a citation missing a field, an entry
//                       for a threshold that no longer exists. test/calibrate-provenance.test.ts requires none.
//   checkBands          for each entry naming a metric: the observed quantile x headroom against the threshold.
//                       tight: the threshold is below the observed quantile (real traffic at that percentile is refused).
//                       drift: a calibrated threshold is more than `band` times off what the distribution now suggests.
//                       Either fails the scheduled re-calibration (.github/workflows/calibrate.yml).
import { chainGet, mapGet } from '../../src/absent.ts'
import type { Option } from '../../src/option.ts'
import { unwrapOr } from '../../src/option.ts'
import { asRecord } from '../cd/json.ts'
import { numericOf, quantileOf, QUANTILES, type CalibrationStats, type Quantile } from './stats.ts'

export const PRIOR = 'PRIOR (uncalibrated)'
export const CALIBRATED = 'calibrated'

/** A citation's required fields: where the distribution came from and how the threshold was set against it. */
export const CITATION_FIELDS = ['source', 'query', 'window', 'date', 'n', 'percentile', 'headroom'] as const

export type Metric = {
  readonly attribute: string
  /** A `ply.route` value, `api` for every /v1 route, or `*` for every route. */
  readonly route: string
  /** 1 is the max. */
  readonly quantile: Quantile | 1
  /** The threshold should sit at this multiple of the observed quantile. */
  readonly headroom: number
  /** A calibrated threshold more than this factor away from quantile x headroom has drifted. */
  readonly band: number
}

export type Citation = {
  readonly source: string
  readonly query: string
  readonly window: string
  readonly date: string
  readonly n: number
  readonly percentile: string
  readonly headroom: string
}

export type Provenance =
  | { readonly status: typeof CALIBRATED; readonly value: number | readonly number[]; readonly citation: Citation; readonly metric: Metric | null }
  | { readonly status: typeof PRIOR; readonly value: number | readonly number[]; readonly why: string; readonly metric: Metric | null }

export type Registry = {
  readonly minN: number
  readonly thresholds: ReadonlyMap<string, Provenance>
}

/** A problem with one entry, or with the registry as a whole. */
export type Problem = { readonly key: string; readonly problem: string }

const QUANTILE_SET: readonly number[] = [...QUANTILES, 1]

function text(rec: Record<string, unknown>, key: string): string | null {
  const value = rec[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function textOr(rec: Record<string, unknown>, key: string): string {
  const value = text(rec, key)
  return value === null ? '' : value
}

function valueOf(raw: unknown): number | readonly number[] | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (Array.isArray(raw) && raw.length > 0 && raw.every(item => typeof item === 'number' && Number.isFinite(item))) return raw as number[]
  return null
}

function metricOf(given: Option<unknown>, key: string, problems: Problem[]): Metric | null {
  if (given.tag === 'none') return null
  const rec = asRecord(given.value)
  const bad = (problem: string): null => {
    problems.push({ key, problem: `metric ${problem}` })
    return null
  }
  if (!rec) return bad('is not an object')
  const attribute = text(rec, 'attribute')
  const route = text(rec, 'route')
  if (!attribute) return bad('has no attribute')
  if (!route) return bad('has no route')
  const quantile = rec.quantile
  if (typeof quantile !== 'number' || !QUANTILE_SET.includes(quantile)) return bad(`quantile must be one of ${QUANTILE_SET.join(', ')}`)
  const headroom = rec.headroom
  if (typeof headroom !== 'number' || !(headroom >= 1)) return bad('headroom must be a number >= 1')
  const band = rec.band
  if (typeof band !== 'number' || !(band > 1)) return bad('band must be a number > 1')
  return { attribute, route, quantile: quantile as Quantile | 1, headroom, band }
}

function entryOf(key: string, raw: unknown, problems: Problem[]): Provenance | null {
  const rec = asRecord(raw)
  if (!rec) {
    problems.push({ key, problem: 'entry is not an object' })
    return null
  }
  const value = valueOf(rec.value)
  if (value === null) {
    problems.push({ key, problem: 'value must be a finite number, or a non-empty array of them' })
    return null
  }
  const metric = metricOf(chainGet(rec, 'metric'), key, problems)
  if (rec.status === PRIOR) {
    const why = text(rec, 'why')
    if (!why) {
      problems.push({ key, problem: `${PRIOR} needs a why` })
      return null
    }
    return { status: PRIOR, value, why, metric }
  }
  if (rec.status === CALIBRATED) {
    const missing = CITATION_FIELDS.filter(field => field === 'n' ? !(typeof rec.n === 'number' && Number.isInteger(rec.n) && rec.n >= 1) : text(rec, field) === null)
    if (missing.length > 0) {
      problems.push({ key, problem: `a calibrated threshold must cite ${missing.join(', ')}` })
      return null
    }
    const date = textOr(rec, 'date')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      problems.push({ key, problem: `date ${date} is not YYYY-MM-DD` })
      return null
    }
    const citation: Citation = {
      source: textOr(rec, 'source'),
      query: textOr(rec, 'query'),
      window: textOr(rec, 'window'),
      date,
      n: rec.n as number,
      percentile: textOr(rec, 'percentile'),
      headroom: textOr(rec, 'headroom'),
    }
    return { status: CALIBRATED, value, citation, metric }
  }
  problems.push({ key, problem: `status must be "${CALIBRATED}" (with a citation) or "${PRIOR}"; got ${JSON.stringify(rec.status)}` })
  return null
}

/** Parse thresholds.json. Malformed entries are problems, not throws, so one run lists them all. */
export function readRegistry(raw: unknown): { readonly registry: Registry; readonly problems: readonly Problem[] } {
  const problems: Problem[] = []
  const parsedRoot = asRecord(raw)
  const rec = parsedRoot === null ? {} : parsedRoot
  const thresholds = new Map<string, Provenance>()
  const table = asRecord(rec.thresholds)
  if (!table) problems.push({ key: 'thresholds', problem: 'missing' })
  for (const [key, entry] of Object.entries(table === null ? {} : table)) {
    const parsed = entryOf(key, entry, problems)
    if (parsed) thresholds.set(key, parsed)
  }
  // The registry's own floor is a threshold too, and carries its own provenance.
  const floor = entryOf('minN', rec.minN, problems)
  const minN = floor !== null && typeof floor.value === 'number' && Number.isInteger(floor.value) && floor.value >= 1 ? floor.value : 1
  if (floor !== null && minN !== floor.value) problems.push({ key: 'minN', problem: 'value must be an integer >= 1' })
  return { registry: { minN, thresholds }, problems }
}

/** Numeric leaves of a policy JSON, by path, under `policy:`. `calibration` and `schedule` blocks are citations, not thresholds. */
export function policyThresholds(policy: unknown): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'number') {
      out.set(`policy:${path}`, value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`))
      return
    }
    const rec = asRecord(value)
    if (!rec) return
    for (const [key, child] of Object.entries(rec)) {
      if (key === 'calibration' || key === 'schedule') continue
      walk(child, path === '' ? key : `${path}.${key}`)
    }
  }
  walk(policy, '')
  return out
}

/** Numeric fields of a caps object, by `<source>:<field>`. */
export function capThresholds(source: string, caps: Readonly<Record<string, unknown>>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [key, value] of Object.entries(caps)) if (typeof value === 'number') out.set(`${source}:${key}`, value)
  return out
}

/** `policy:steps[3].dwellMs` → `policy:steps[*].dwellMs`. Null when the key has no index. */
export function wildcardOf(key: string): string | null {
  const star = key.replace(/\[\d+\]/g, '[*]')
  return star === key ? null : star
}

function sameValue(want: number | readonly number[], got: number | readonly number[]): boolean {
  if (typeof want === 'number' || typeof got === 'number') return want === got
  return want.length === got.length && want.every((value, i) => value === got[i])
}

/**
 * Every current threshold has an entry (exact, or its `[*]` wildcard) whose value matches; every entry names a
 * threshold that exists. Plus the registry's own parse problems.
 */
export function provenanceProblems(parsed: { readonly registry: Registry; readonly problems: readonly Problem[] }, current: ReadonlyMap<string, number>): Problem[] {
  const problems: Problem[] = [...parsed.problems]
  const { thresholds } = parsed.registry
  const used = new Set<string>()
  const wildValues = new Map<string, number[]>()
  for (const [key, value] of current) {
    const exact = thresholds.get(key)
    if (exact) {
      used.add(key)
      if (!sameValue(exact.value, value)) problems.push({ key, problem: `threshold is ${value}, its provenance entry says ${JSON.stringify(exact.value)}: re-cite it or mark it ${PRIOR}` })
      continue
    }
    const star = wildcardOf(key)
    if (star !== null && thresholds.has(star)) {
      used.add(star)
      wildValues.set(star, [...unwrapOr(mapGet(wildValues, star), []), value])
      continue
    }
    problems.push({ key, problem: `threshold ${value} has no provenance: add a citation (${CITATION_FIELDS.join(', ')}) or mark it ${PRIOR}` })
  }
  for (const [star, values] of wildValues) {
    const entry = thresholds.get(star)
    if (entry && !sameValue(entry.value, values)) problems.push({ key: star, problem: `thresholds are ${JSON.stringify(values)}, the provenance entry says ${JSON.stringify(entry.value)}` })
  }
  for (const key of thresholds.keys()) if (!used.has(key)) problems.push({ key, problem: 'provenance entry for a threshold that does not exist' })
  return problems
}

export type BandResult = {
  readonly key: string
  readonly status: Provenance['status']
  readonly value: number
  readonly metric: Metric
  readonly verdict: 'ok' | 'tight' | 'drift' | 'insufficient' | 'uncalibrated'
  readonly n: number
  readonly observed: number | null
  /** observed x headroom: what this distribution would set the threshold to. */
  readonly suggested: number | null
  readonly line: string
}

/** True when a band verdict should fail the scheduled run. */
export function isOutOfBand(result: BandResult): boolean {
  return result.verdict === 'tight' || result.verdict === 'drift'
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(4)
}

/** Each registry entry with a metric, judged against this window's distributions. */
export function checkBands(registry: Registry, stats: CalibrationStats): BandResult[] {
  const out: BandResult[] = []
  for (const [key, entry] of [...registry.thresholds.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const metric = entry.metric
    if (metric === null || typeof entry.value !== 'number') continue
    const value = entry.value
    const label = `${key}=${fmt(value)} ${metric.attribute}@${metric.route} q${metric.quantile}`
    const dist = numericOf(stats, metric.route, metric.attribute)
    if (dist === null || dist.n < registry.minN) {
      const n = dist === null ? 0 : dist.n
      out.push({ key, status: entry.status, value, metric, verdict: 'insufficient', n, observed: null, suggested: null, line: `insufficient ${label}: n=${n} < ${registry.minN}` })
      continue
    }
    const observed = quantileOf(dist, metric.quantile)
    const suggested = observed * metric.headroom
    const seen = `n=${dist.n} observed=${fmt(observed)} suggested=${fmt(suggested)} (x${metric.headroom})`
    if (value < observed) {
      out.push({ key, status: entry.status, value, metric, verdict: 'tight', n: dist.n, observed, suggested, line: `tight ${label}: ${seen}; the threshold is below the observed quantile` })
      continue
    }
    if (entry.status === PRIOR) {
      out.push({ key, status: entry.status, value, metric, verdict: 'uncalibrated', n: dist.n, observed, suggested, line: `uncalibrated ${label}: ${seen}; cite this window to calibrate it` })
      continue
    }
    const low = suggested / metric.band
    const high = suggested * metric.band
    if (suggested > 0 && (value < low || value > high)) {
      out.push({ key, status: entry.status, value, metric, verdict: 'drift', n: dist.n, observed, suggested, line: `drift ${label}: ${seen}; outside ${fmt(low)}..${fmt(high)}` })
      continue
    }
    out.push({ key, status: entry.status, value, metric, verdict: 'ok', n: dist.n, observed, suggested, line: `ok ${label}: ${seen}` })
  }
  return out
}

/** A citation block for one metric over this window, ready to paste into thresholds.json. */
export function citationFor(input: {
  readonly metric: Metric
  readonly stats: CalibrationStats
  readonly query: unknown
  readonly from: number
  readonly to: number
  readonly source: string
}): Record<string, unknown> | null {
  const dist = numericOf(input.stats, input.metric.route, input.metric.attribute)
  if (dist === null) return null
  const observed = quantileOf(dist, input.metric.quantile)
  return {
    status: CALIBRATED,
    value: observed * input.metric.headroom,
    source: input.source,
    query: JSON.stringify(input.query),
    window: `${new Date(input.from).toISOString()}..${new Date(input.to).toISOString()}`,
    date: new Date(input.to).toISOString().slice(0, 10),
    n: dist.n,
    percentile: `${input.metric.attribute} @ ${input.metric.route} q${input.metric.quantile} = ${observed}`,
    headroom: `x${input.metric.headroom}`,
    metric: input.metric,
  }
}
