// scripts/calibrate: input distributions from Workers Observability, per route (issue #73).
//
//   node --experimental-strip-types scripts/calibrate/main.ts --since 7d
//   node --experimental-strip-types scripts/calibrate/main.ts --from 2026-11-01T00:00:00Z --to 2026-11-02T00:00:00Z --route 'GET /v1/tree'
//   node --experimental-strip-types scripts/calibrate/main.ts --since 7d --check --report drift.md
//   node --experimental-strip-types scripts/calibrate/main.ts --fixture test/fixtures/calibrate/spans.json --check
//
// Prints, per route (and `*` for all routes), every numeric input attribute's n, p50/p90/p99/p99.9, max and log2
// histogram, and categorical counts (error kind, cache status, outcome). --check judges every threshold in
// scripts/calibrate/thresholds.json that names a metric against this window and fails (exit 1) when one has left its
// band, or when a threshold lacks provenance. --cite KEY prints a citation block for that threshold from this window.
// --fixture reads recorded query responses instead of querying (no credentials, no network).
//
// Exit: 0 in band, 1 out of band or a provenance problem, 2 a usage or query error.
import { readFileSync, writeFileSync } from 'node:fs'
import { atIndex, captureGroup, mapGet, recordGet } from '../../src/absent.ts'
import { orNull, unwrapOr } from '../../src/option.ts'
import { WORKER_DEFAULT } from '../cd/baseline.ts'
import { extractJson } from '../cd/json.ts'
import { telemetryQueryRetry } from '../cd/o11y.ts'
import { DEFAULT_POLICY_PATH, loadPolicy } from '../cd/policy.ts'
import { unwrapEvents } from '../cd/telemetry.ts'
import { currentThresholds, loadRegistry, REGISTRY_PATH } from './current.ts'
import { checkBands, citationFor, isOutOfBand, provenanceProblems, type BandResult, type Problem } from './provenance.ts'
import { citedQuery, querySpanEvents, type SpanQuery } from './query.ts'
import { calibrationStats, statsText, type CalibrationStats } from './stats.ts'

const UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/** `30m`, `12h`, `7d` in milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+)([mhd])$/.exec(text)
  const unit = recordGet(UNIT_MS, unwrapOr(captureGroup(match, 2), ''))
  if (unit.tag === 'none') throw new Error(`duration ${JSON.stringify(text)} is not <n>m, <n>h or <n>d`)
  const n = Number(unwrapOr(captureGroup(match, 1), ''))
  if (!(n > 0)) throw new Error(`duration ${text} must be positive`)
  return n * unit.value
}

export type Args = {
  readonly from: number
  readonly to: number
  readonly worker: string
  readonly sliceMs: number
  readonly routes: readonly string[] | null
  readonly attributes: readonly string[] | null
  readonly versions: readonly string[] | null
  readonly fixtures: readonly string[]
  readonly histograms: boolean
  readonly check: boolean
  readonly report: string | null
  readonly json: string | null
  readonly cite: readonly string[]
  readonly registry: string
  readonly policy: string
}

/** One hour per slice by default: well under 50 pages of 1000 events at the current request rate. */
const DEFAULT_SLICE = '1h'

/** `first` when given, else `fallback`. */
function or(first: string | null, fallback: string): string {
  return first === null ? fallback : first
}

export function parseArgs(argv: readonly string[], now: number, env: Readonly<Record<string, unknown>>): Args {
  const many = new Map<string, string[]>()
  const flags = new Set<string>()
  const BOOL = new Set(['--check', '--no-histogram'])
  for (let i = 0; i < argv.length; i++) {
    const arg = unwrapOr(atIndex(argv, i), '')
    if (BOOL.has(arg)) {
      flags.add(arg)
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`)
    const value = atIndex(argv, i + 1)
    if (value.tag === 'none') throw new Error(`${arg} needs a value`)
    many.set(arg, [...unwrapOr(mapGet(many, arg), []), value.value])
    i += 1
  }
  const known = new Set(['--since', '--from', '--to', '--worker', '--slice', '--route', '--attr', '--version', '--fixture', '--report', '--json', '--cite', '--registry', '--policy'])
  for (const key of many.keys()) if (!known.has(key)) throw new Error(`unknown option ${key}`)
  const one = (key: string): string | null => {
    const values = unwrapOr(mapGet(many, key), [])
    if (values.length > 1) throw new Error(`${key} given more than once`)
    return orNull(atIndex(values, 0))
  }
  const list = (key: string): readonly string[] | null => orNull(mapGet(many, key))
  const fromText = one('--from')
  const toText = one('--to')
  const since = one('--since')
  const to = toText === null ? now : Date.parse(toText)
  if (!Number.isFinite(to)) throw new Error(`--to ${toText} is not a date`)
  let from: number
  if (fromText !== null) {
    if (since !== null) throw new Error('--from and --since are exclusive')
    from = Date.parse(fromText)
    if (!Number.isFinite(from)) throw new Error(`--from ${fromText} is not a date`)
  } else {
    from = to - parseDuration(or(since, '1d'))
  }
  if (!(to > from)) throw new Error('the window must end after it starts')
  return {
    from,
    to,
    worker: or(one('--worker'), envText(env, 'PLY_WORKER', WORKER_DEFAULT)),
    sliceMs: parseDuration(or(one('--slice'), DEFAULT_SLICE)),
    routes: list('--route'),
    attributes: list('--attr'),
    versions: list('--version'),
    fixtures: unwrapOr(mapGet(many, '--fixture'), []),
    histograms: !flags.has('--no-histogram'),
    check: flags.has('--check'),
    report: one('--report'),
    json: one('--json'),
    cite: unwrapOr(mapGet(many, '--cite'), []),
    registry: or(one('--registry'), REGISTRY_PATH),
    policy: or(one('--policy'), DEFAULT_POLICY_PATH),
  }
}

function envText(env: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const found = recordGet(env, key)
  return found.tag === 'some' && typeof found.value === 'string' && found.value !== '' ? found.value : fallback
}

/** Recorded query responses (cf's stdout, banner and all), concatenated. */
export function fixtureEvents(texts: readonly string[]): unknown[] {
  return texts.flatMap(text => unwrapEvents(extractJson(text)))
}

/** The issue body for the scheduled run: what left its band, what lacks provenance, and the window. */
export function driftMarkdown(input: { readonly from: number; readonly to: number; readonly events: number; readonly bands: readonly BandResult[]; readonly problems: readonly Problem[] }): string {
  const out = [
    `Re-calibration window ${new Date(input.from).toISOString()} .. ${new Date(input.to).toISOString()} (${input.events} span events).`,
    '',
  ]
  const outside = input.bands.filter(isOutOfBand)
  if (outside.length > 0) {
    out.push('## Thresholds out of band', '', ...outside.map(band => `- \`${band.line}\``), '')
  }
  if (input.problems.length > 0) {
    out.push('## Thresholds without provenance', '', ...input.problems.map(problem => `- \`${problem.key}\`: ${problem.problem}`), '')
  }
  const rest = input.bands.filter(band => !isOutOfBand(band))
  if (rest.length > 0) out.push('## Other thresholds with a metric', '', ...rest.map(band => `- \`${band.line}\``), '')
  out.push('Re-run `node --experimental-strip-types scripts/calibrate/main.ts --since 7d --cite <key>` for a citation block, and update scripts/calibrate/thresholds.json with the new value.', '')
  return out.join('\n')
}

export type Outcome = { readonly code: 0 | 1; readonly text: string; readonly stats: CalibrationStats; readonly bands: readonly BandResult[]; readonly problems: readonly Problem[] }

/** Everything after the events are in hand. Pure but for reading the registry and the current thresholds. */
export function evaluate(args: Args, events: readonly unknown[], source: string): Outcome {
  const stats = calibrationStats(events, { routes: args.routes, attributes: args.attributes, versions: args.versions })
  const parts = [statsText(stats, args, args.histograms)]
  const loaded = loadRegistry(args.registry)
  const query: SpanQuery = { worker: args.worker, from: args.from, to: args.to, sliceMs: args.sliceMs }
  for (const key of args.cite) {
    const entry = loaded.registry.thresholds.get(key)
    const block = entry && entry.metric ? citationFor({ metric: entry.metric, stats, query: citedQuery(query), from: args.from, to: args.to, source }) : null
    parts.push(block === null ? `cite ${key}: no metric, or no samples for it in this window\n` : `cite ${key}:\n${JSON.stringify(block, null, 2)}\n`)
  }
  if (!args.check) return { code: 0, text: parts.join('\n'), stats, bands: [], problems: [] }
  const bands = checkBands(loaded.registry, stats)
  const problems = provenanceProblems(loaded, currentThresholds(args.policy))
  parts.push(['check:', ...bands.map(band => `  ${band.line}`), ...problems.map(problem => `  provenance ${problem.key}: ${problem.problem}`)].join('\n'))
  const failed = bands.some(isOutOfBand) || problems.length > 0
  parts.push(failed ? 'check: FAIL (a threshold left its band, or lacks provenance)\n' : 'check: ok\n')
  return { code: failed ? 1 : 0, text: parts.join('\n'), stats, bands, problems }
}

export async function cli(argv: readonly string[], env: Readonly<Record<string, unknown>>): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv, Date.now(), env)
  } catch (error) {
    process.stderr.write(`calibrate: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  let events: unknown[]
  let source: string
  try {
    if (args.fixtures.length > 0) {
      events = fixtureEvents(args.fixtures.map(path => readFileSync(path, 'utf8')))
      source = `fixture ${args.fixtures.join(',')}`
    } else {
      const retry = telemetryQueryRetry(loadPolicy(args.policy).policy)
      events = await querySpanEvents({ worker: args.worker, from: args.from, to: args.to, sliceMs: args.sliceMs }, retry)
      source = `scripts/calibrate ${new Date(args.to).toISOString()}`
    }
  } catch (error) {
    process.stderr.write(`calibrate: telemetry unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const outcome = evaluate(args, events, source)
  process.stdout.write(outcome.text)
  if (args.json !== null) writeFileSync(args.json, `${JSON.stringify({ from: args.from, to: args.to, worker: args.worker, stats: outcome.stats, bands: outcome.bands, problems: outcome.problems }, null, 2)}\n`)
  if (args.report !== null && outcome.code !== 0) {
    writeFileSync(args.report, driftMarkdown({ from: args.from, to: args.to, events: outcome.stats.events, bands: outcome.bands, problems: outcome.problems }))
  }
  return outcome.code
}

if (import.meta.url === `file://${unwrapOr(atIndex(process.argv, 1), '')}`) {
  cli(process.argv.slice(2), process.env).then(code => process.exit(code), (error: unknown) => {
    process.stderr.write(`calibrate: ${error instanceof Error ? (typeof error.stack === 'string' ? error.stack : error.message) : String(error)}\n`)
    process.exit(2)
  })
}
