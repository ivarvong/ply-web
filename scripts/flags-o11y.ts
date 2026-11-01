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
import { MEASUREMENT, flagLogQuery, renderReport, reportFromEvents } from '../src/flags/report.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] ?? null : null;
};

const worker = arg('worker') ?? 'ply';
const from = Number(arg('from') ?? Date.now() - 60 * 60 * 1000);
const to = Number(arg('to') ?? Date.now() + 60_000);
if (!Number.isFinite(from) || !Number.isFinite(to)) {
  console.error('flags-o11y: --from and --to are unix milliseconds');
  process.exit(2);
}

type Page = { events?: { events?: unknown[] } };

function page(body: unknown): unknown[] {
  const parsed = JSON.parse(execFileSync('npx', ['cf', 'o11y', 'telemetry', 'query', '--body', JSON.stringify(body)], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    cwd: ROOT,
    env: process.env,
  })) as Page;
  return parsed.events?.events ?? [];
}

function cursor(rows: readonly unknown[]): string | null {
  const last = rows[rows.length - 1];
  if (!last || typeof last !== 'object') return null;
  const meta = (last as { $metadata?: { id?: string } }).$metadata;
  return typeof meta?.id === 'string' && meta.id ? meta.id : null;
}

function collect(msg: 'flags.eval' | 'flags.resolve'): unknown[] {
  const out: unknown[] = [];
  let offset: string | undefined;
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
