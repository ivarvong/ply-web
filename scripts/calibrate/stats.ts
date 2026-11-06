// Input distributions from Workers Observability span events (issue #73). Pure: no network, no clock. The adapter
// (scripts/calibrate/query.ts) fetches the events; this module turns them into per-route, per-attribute distributions
// (n, p50/p90/p99/p99.9, max, a log2 histogram) and categorical counts, and prints them.
//
// Where an attribute lives on an event: Workers Observability indexes a span's attributes under `source`. The runtime's
// own attributes arrive nested by their dots (`source.http.response.status_code`, test/fixtures/cd/canary-spans.json);
// a custom attribute set with ctx.tracing may arrive nested the same way or as one dotted key. Both are read: `source`
// is flattened to dotted paths, and a literal dotted key wins over a nested one of the same path.
import { find, orNull, unwrapOr } from '../../src/option.ts'
import { mapGet, recordGet } from '../../src/absent.ts'
import { asRecord } from '../cd/json.ts'
import { percentile, scriptVersionId } from '../cd/telemetry.ts'
import { CATEGORICAL, NOT_INPUTS } from './attributes.ts'

export const ROUTE_KEY = 'ply.route'
export const VERSION_KEY = 'ply.script_version'
/** A span that carries no `ply.route`: a span from before #73, or one the Worker did not stamp. */
export const UNROUTED = 'unrouted'
/** Every route together. A threshold that is not per route (a cap shared by all of /v1) reads this group. */
export const ALL_ROUTES = '*'
/** Every /v1 route together: the group the /v1 API's caps (src/limits.ts API_CAPS) are set against. */
export const API_GROUP = 'api'

/** A `/v1` route key (`GET /v1/tree`), as src/index.js stamps it. */
export function isApiRoute(route: string): boolean {
  return /^[A-Z]+ \/v1\//.test(route)
}

/** The percentiles printed and cited. p99.9 is the tail a hard cap is set against. */
export const QUANTILES = [0.5, 0.9, 0.99, 0.999] as const

export type Quantile = (typeof QUANTILES)[number]

export type Bucket = {
  /** Values in (lower, upper]. The first bucket is [0, 1]; a negative value has its own bucket with upper 0. */
  readonly upper: number
  readonly count: number
}

export type Distribution = {
  readonly n: number
  readonly min: number
  readonly max: number
  readonly p50: number
  readonly p90: number
  readonly p99: number
  readonly p999: number
  readonly histogram: readonly Bucket[]
}

export type CategoryCounts = Readonly<Record<string, number>>

export type GroupStats = {
  readonly route: string
  /** Distinct `ply.script_version` (or `$workers.scriptVersion.id`) values seen in this group, sorted. */
  readonly versions: readonly string[]
  /** Span events in the group. */
  readonly events: number
  readonly numeric: Readonly<Record<string, Distribution>>
  readonly categorical: Readonly<Record<string, CategoryCounts>>
}

export type CalibrationStats = {
  readonly events: number
  /** Span events with no attributes to read (a malformed row). */
  readonly skipped: number
  /** By route, sorted; ALL_ROUTES then API_GROUP first. */
  readonly groups: readonly GroupStats[]
}

type Scalar = string | number | boolean

/** `source` flattened to dotted paths. Nested objects become `a.b.c`; a literal `a.b.c` key replaces the nested one. */
export function flattenAttributes(source: unknown): Readonly<Record<string, Scalar>> {
  const nested: Record<string, Scalar> = {}
  const literal: Record<string, Scalar> = {}
  const walk = (value: unknown, path: string, depth: number): void => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (path.includes('.') && depth === 1) literal[path] = value
      else nested[path] = value
      return
    }
    const rec = asRecord(value)
    if (!rec || Array.isArray(value) || depth > 12) return
    for (const [key, child] of Object.entries(rec)) walk(child, path === '' ? key : `${path}.${key}`, depth + 1)
  }
  walk(source, '', 0)
  return { ...nested, ...literal }
}

function scalarOf(value: unknown): Scalar | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null
}

/** The attributes of one span event, with the route and version it ran under. Null for a row with no `source`. */
export function eventAttributes(event: unknown): { readonly route: string; readonly version: string | null; readonly attrs: Readonly<Record<string, Scalar>> } | null {
  const rec = asRecord(event)
  if (!rec) return null
  const source = asRecord(rec.source)
  if (!source) return null
  const attrs = flattenAttributes(source)
  const route = scalarOf(attrs[ROUTE_KEY])
  const stamped = scalarOf(attrs[VERSION_KEY])
  const cloudflare = scalarOf(attrs['cloudflare.script_version.id'])
  const version = typeof stamped === 'string' && stamped !== ''
    ? stamped
    : typeof cloudflare === 'string' && cloudflare !== '' ? cloudflare : scriptVersionId(rec)
  return { route: typeof route === 'string' && route !== '' ? route : UNROUTED, version, attrs }
}

/** An attribute that is an input distribution: a finite number under `git.` or `ply.`, not an id, constant or echo. */
export function isInputAttribute(key: string, value: Scalar): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  if (!key.startsWith('git.') && !key.startsWith('ply.')) return false
  return !NOT_INPUTS.includes(key)
}

const CATEGORY_KEYS: readonly string[] = CATEGORICAL

/** Categorical keys: the fixed taxonomy plus every ply operation's `<root>.outcome`. */
export function isCategoryAttribute(key: string): boolean {
  return CATEGORY_KEYS.includes(key) || /^git\.[a-z_]+(\.[a-z_]+)*\.outcome$/.test(key)
}

/** Upper bound of the log2 bucket that holds `value`: 1 for [0, 1], then 2, 4, 8, ... A negative value is bucket 0. */
export function bucketUpper(value: number): number {
  if (value < 0) return 0
  if (value <= 1) return 1
  return 2 ** Math.ceil(Math.log2(value))
}

export function log2Histogram(values: readonly number[]): Bucket[] {
  const counts = new Map<number, number>()
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    const upper = bucketUpper(value)
    counts.set(upper, unwrapOr(mapGet(counts, upper), 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([upper, count]) => ({ upper, count }))
}

/**
 * n, min, max, p50/p90/p99/p99.9 and the histogram. Null for an empty series.
 * The percentile is the CD's (scripts/cd/telemetry.ts): sorted[floor((n - 1) * p)], an observed value, never interpolated.
 */
export function distribution(values: readonly number[]): Distribution | null {
  const finite = values.filter(value => Number.isFinite(value))
  if (finite.length === 0) return null
  const at = (p: number): number => {
    const value = percentile(finite, p)
    return value === null ? Number.NaN : value
  }
  let min = Infinity
  let max = -Infinity
  for (const value of finite) {
    if (value < min) min = value
    if (value > max) max = value
  }
  return { n: finite.length, min, max, p50: at(0.5), p90: at(0.9), p99: at(0.99), p999: at(0.999), histogram: log2Histogram(finite) }
}

/** The value of `q` on a distribution. */
export function quantileOf(dist: Distribution, q: Quantile | 1): number {
  switch (q) {
    case 0.5: return dist.p50
    case 0.9: return dist.p90
    case 0.99: return dist.p99
    case 0.999: return dist.p999
    case 1: return dist.max
  }
}

type Accumulator = { events: number; versions: Set<string>; numeric: Map<string, number[]>; categorical: Map<string, Map<string, number>> }

function accumulator(): Accumulator {
  return { events: 0, versions: new Set(), numeric: new Map(), categorical: new Map() }
}

function add(acc: Accumulator, version: string | null, attrs: Readonly<Record<string, Scalar>>, only: ReadonlySet<string> | null): void {
  acc.events += 1
  if (version) acc.versions.add(version)
  for (const [key, value] of Object.entries(attrs)) {
    if (only !== null && !only.has(key)) continue
    if (isCategoryAttribute(key)) {
      const counts = unwrapOr(mapGet(acc.categorical, key), new Map<string, number>())
      const label = String(value)
      counts.set(label, unwrapOr(mapGet(counts, label), 0) + 1)
      acc.categorical.set(key, counts)
    }
    if (!isInputAttribute(key, value)) continue
    const series = unwrapOr(mapGet(acc.numeric, key), [])
    series.push(value)
    acc.numeric.set(key, series)
  }
}

function finish(route: string, acc: Accumulator): GroupStats {
  const numeric: Record<string, Distribution> = {}
  for (const key of [...acc.numeric.keys()].sort()) {
    const dist = distribution(unwrapOr(mapGet(acc.numeric, key), []))
    if (dist) numeric[key] = dist
  }
  const categorical: Record<string, CategoryCounts> = {}
  for (const key of [...acc.categorical.keys()].sort()) {
    const counts = unwrapOr(mapGet(acc.categorical, key), new Map<string, number>())
    categorical[key] = Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)))
  }
  return { route, versions: [...acc.versions].sort(), events: acc.events, numeric, categorical }
}

export type StatsOptions = {
  /** Keep only these attributes (numeric or categorical). Null keeps every input attribute. */
  readonly attributes: readonly string[] | null
  /** Keep only these routes. Null keeps every route. ALL_ROUTES and API_GROUP are computed over what is kept. */
  readonly routes: readonly string[] | null
  /** Keep only these versions. Null keeps every version. */
  readonly versions: readonly string[] | null
}

/** No filter: every route, version and input attribute. */
export const EVERYTHING: StatsOptions = { attributes: null, routes: null, versions: null }

/** Group span events by route (and ALL_ROUTES), and summarize every input attribute in each group. */
export function calibrationStats(events: readonly unknown[], options: StatsOptions = EVERYTHING): CalibrationStats {
  const only = options.attributes ? new Set(options.attributes) : null
  const routes = options.routes ? new Set(options.routes) : null
  const versions = options.versions ? new Set(options.versions) : null
  const all = accumulator()
  const api = accumulator()
  const byRoute = new Map<string, Accumulator>()
  let skipped = 0
  let kept = 0
  for (const event of events) {
    const read = eventAttributes(event)
    if (!read) {
      skipped += 1
      continue
    }
    if (routes !== null && !routes.has(read.route)) continue
    if (versions !== null && (read.version === null || !versions.has(read.version))) continue
    kept += 1
    const acc = unwrapOr(mapGet(byRoute, read.route), accumulator())
    add(acc, read.version, read.attrs, only)
    byRoute.set(read.route, acc)
    add(all, read.version, read.attrs, only)
    if (isApiRoute(read.route)) add(api, read.version, read.attrs, only)
  }
  const groups = [finish(ALL_ROUTES, all), finish(API_GROUP, api), ...[...byRoute.keys()].sort().map(route => finish(route, unwrapOr(mapGet(byRoute, route), accumulator())))]
  return { events: kept, skipped, groups }
}

export function groupOf(stats: CalibrationStats, route: string): GroupStats | null {
  return orNull(find(stats.groups, group => group.route === route))
}

/** One attribute's distribution in one route group, or null when the group or the attribute is absent. */
export function numericOf(stats: CalibrationStats, route: string, attribute: string): Distribution | null {
  const group = groupOf(stats, route)
  return group === null ? null : orNull(recordGet(group.numeric, attribute))
}

const BAR_WIDTH = 40

function fmt(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

function histogramLines(histogram: readonly Bucket[]): string[] {
  const peak = histogram.reduce((most, bucket) => Math.max(most, bucket.count), 0)
  return histogram.map(bucket => {
    const width = peak === 0 ? 0 : Math.max(1, Math.round((bucket.count / peak) * BAR_WIDTH))
    return `      <=${fmt(bucket.upper).padStart(12)} ${String(bucket.count).padStart(7)} ${'#'.repeat(width)}`
  })
}

/** One attribute's summary line: n, p50/p90/p99/p99.9, max. */
export function distributionLine(key: string, dist: Distribution): string {
  return `    ${key} n=${dist.n} p50=${fmt(dist.p50)} p90=${fmt(dist.p90)} p99=${fmt(dist.p99)} p99.9=${fmt(dist.p999)} max=${fmt(dist.max)}`
}

/** The report: per route, per attribute, the summary line and its histogram; then categorical counts. */
export function statsText(stats: CalibrationStats, window: { readonly from: number; readonly to: number }, histograms = true): string {
  const lines = [
    `calibrate: ${new Date(window.from).toISOString()} .. ${new Date(window.to).toISOString()} span events=${stats.events} skipped=${stats.skipped}`,
  ]
  for (const group of stats.groups) {
    lines.push('', `route ${group.route} events=${group.events} versions=${group.versions.length === 0 ? '-' : group.versions.join(',')}`)
    for (const [key, dist] of Object.entries(group.numeric)) {
      lines.push(distributionLine(key, dist))
      if (histograms) lines.push(...histogramLines(dist.histogram))
    }
    for (const [key, counts] of Object.entries(group.categorical)) {
      lines.push(`    ${key} ${Object.entries(counts).map(([value, count]) => `${value}=${count}`).join(' ')}`)
    }
  }
  return `${lines.join('\n')}\n`
}
