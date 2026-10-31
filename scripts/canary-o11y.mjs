// Telemetry gate for a deploy (scripts/deploy.sh): reads Workers Observability for one Worker version and proves that
// version answered exactly the smoke's requests, with no exception and no 5xx.
//
//   env -u CLOUDFLARE_API_TOKEN node scripts/canary-o11y.mjs <version-id> <from-ms> <ids.txt> [--wait 180]
//
// <ids.txt>: the x-ply-request-id values the smokes got back, one per line. Each must appear in a `ply.request` log line
// emitted by <version-id> (the request id is minted per request in src/index.js, so a match proves which version ran it).
// Fails (exit 1) when any id is still missing after --wait seconds (ingest lag is ~10-30 s), when any fetch invocation of
// that version since <from-ms> has an outcome other than ok, or when any of its responses is a 5xx. Prints one JSON summary.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [version, fromArg, idsFile] = process.argv.slice(2);
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
if (!version || !fromArg || !idsFile) { console.error('usage: canary-o11y.mjs <version-id> <from-ms> <ids.txt> [--wait s]'); process.exit(2); }
const want = new Set(readFileSync(idsFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
const waitS = Number(arg('wait') ?? 180);
const from = Math.floor(Number(fromArg));

function query(to) {
  const body = {
    queryId: 'ply-canary', timeframe: { from, to }, view: 'events', limit: 1000,
    parameters: { filters: [
      { key: '$metadata.service', operation: 'eq', type: 'string', value: 'ply' },
      { key: '$workers.scriptVersion.id', operation: 'eq', type: 'string', value: version },
    ] },
  };
  const out = execFileSync('npx', ['cf', 'o11y', 'telemetry', 'query', '--body', JSON.stringify(body)], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out).events?.events ?? [];
}

const t0 = Date.now();
let events = [], seen = new Set();
for (;;) {
  events = query(Date.now() + 60_000);
  seen = new Set(events.filter(e => e.source?.msg === 'ply.request').map(e => e.source.id));
  if ([...want].every(id => seen.has(id)) || Date.now() - t0 > waitS * 1000) break;
  await new Promise(r => setTimeout(r, 10_000));
}
const inv = events.filter(e => e.$metadata?.type === 'cf-worker-event' && e.$workers?.eventType === 'fetch');
const bad = inv.filter(e => e.$workers.outcome !== 'ok');
const logs = events.filter(e => e.source?.msg === 'ply.request');
const fivexx = logs.filter(e => Number(e.source.status) >= 500);
const errors = events.filter(e => e.$metadata?.level === 'error');
const missing = [...want].filter(id => !seen.has(id));
const count = (xs, f) => Object.fromEntries(Object.entries(Object.groupBy(xs, f)).map(([k, v]) => [k, v.length]));
const pct = (xs, p) => { const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) * p)] : null; };
const wall = inv.map(e => e.$workers.wallTimeMs), cpu = inv.map(e => e.$workers.cpuTimeMs);
const summary = {
  version, from: new Date(from).toISOString(), smokeRequests: want.size, matched: want.size - missing.length, missing,
  invocations: inv.length, outcomes: count(inv, e => e.$workers.outcome), statuses: count(logs, e => e.source.status),
  nonOk: bad.length, fivexx: fivexx.length, errorLogs: errors.length,
  wallMs: { p50: pct(wall, 0.5), p95: pct(wall, 0.95) }, cpuMs: { p50: pct(cpu, 0.5), p95: pct(cpu, 0.95) },
};
console.log(JSON.stringify(summary));
process.exit(missing.length || bad.length || fivexx.length || errors.length ? 1 : 0);
