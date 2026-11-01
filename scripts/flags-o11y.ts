// Query Workers observability for flag evaluations and print p50/p95/p99 per cache status,
// plus the resolved-variant breakdown per flag and revision.
// Durations are resolve_ms (the awaited FlagsCache/R2 read), not the pure hash. See MEASUREMENT.
//
//   node --experimental-strip-types scripts/flags-o11y.ts [--from ms] [--to ms] [--worker ply]
//
// Uses `cf o11y telemetry query`. The API token stays in the environment. This script does not read or print it.
// Filters are msg = flags.eval and msg = flags.resolve. Unit id is not a filter and not a column.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atIndex, chainGet } from '../src/absent.ts';
import { unwrapOr } from '../src/option.ts';
import { MEASUREMENT, flagLogQuery, renderReport, reportFromEvents } from '../src/flags/report.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  if (index <= 0) return null;
  return unwrapOr(atIndex(process.argv, index + 1), null);
};

const workerArg = arg('worker');
const worker = workerArg === null ? 'ply' : workerArg;
const fromArg = arg('from');
const toArg = arg('to');
const from = Number(fromArg === null ? Date.now() - 60 * 60 * 1000 : fromArg);
const to = Number(toArg === null ? Date.now() + 60_000 : toArg);
if (!Number.isFinite(from) || !Number.isFinite(to)) {
  console.error('flags-o11y: --from and --to are unix milliseconds');
  process.exit(2);
}

function page(body: unknown): unknown[] {
  const parsed: unknown = JSON.parse(execFileSync('npx', ['cf', 'o11y', 'telemetry', 'query', '--body', JSON.stringify(body)], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    cwd: ROOT,
    env: process.env,
  }));
  const events = chainGet(parsed, 'events');
  if (events.tag === 'none') return [];
  const rows = chainGet(events.value, 'events');
  if (rows.tag === 'none' || !Array.isArray(rows.value)) return [];
  return rows.value;
}

function cursor(rows: readonly unknown[]): string | null {
  const last = unwrapOr(atIndex(rows, rows.length - 1), null);
  if (last === null || typeof last !== 'object') return null;
  const id = chainGet(unwrapOr(chainGet(last, '$metadata'), null), 'id');
  if (id.tag !== 'some' || typeof id.value !== 'string' || id.value === '') return null;
  return id.value;
}

function collect(msg: 'flags.eval' | 'flags.resolve'): unknown[] {
  const out: unknown[] = [];
  let offset: string | null = null;
  for (let i = 0; i < 50; i++) {
    const rows = page(flagLogQuery(worker, msg, from, to, offset));
    out.push(...rows);
    if (rows.length < 1000) return out;
    const next = cursor(rows);
    if (!next) throw new Error(`a full ${msg} page had no cursor`);
    offset = next;
  }
  throw new Error(`more than 50 pages of ${msg}`);
}

const events = [...collect('flags.eval'), ...collect('flags.resolve')];
const report = reportFromEvents(events);
console.error(`flags-o11y: ${MEASUREMENT}`);
console.log(renderReport(report));
