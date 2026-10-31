// Telemetry gate for a deploy (scripts/deploy.sh): reads Workers Observability for one Worker version and proves that
// version answered every one of the smoke's requests, with no exception and no 5xx.
//
//   env -u CLOUDFLARE_API_TOKEN node scripts/canary-o11y.mjs <version-id> <from-ms> <ids.txt> [--wait 60]
//
// <ids.txt>: the smoke requests, one JSON object per line: { id: x-ply-request-id, version: the x-ply-version the smoke
// saw on that response, step } (written by scripts/deploy.sh from the smoke JSON). Each id should appear in a
// `ply.request` log line emitted by <version-id> (the request id is minted per request in src/index.js, so a match proves
// which version ran it).
//
// Every query is narrow, so other traffic on the Worker can never crowd smoke events out of a result:
//   - smoke logs: `id in (<≤50 smoke ids>)` AND scriptVersion = <version>, one query per chunk of ids;
//   - smoke invocations: `$metadata.requestId in (...)` of the requests those logs belong to (outcome, wall, cpu);
//   - health: only the bad events of <version> since <from-ms>: fetch invocations with outcome != ok, ply.request logs
//     with status >= 500, and level=error events.
// Each query pages with the `offset` cursor until a page comes back short, so no result is ever truncated at `limit`.
// (Before 2026-10-31 this was one limit-1000 query over all of the version's events. Deploy b9a40b21: ~560 foreign
// invocations in the window pushed 23 of 79 smoke ids past the cap and failed a healthy deploy.)
//
// Ingest lag: a missing id is re-queried with backoff (5, 10, 15, 15 … s) until --wait seconds (default 60) have passed
// since the first query. Lag observed is 10-30 s.
// Loss: Workers Observability sometimes never ingests an event. Deploy b9a40b21 (2026-10-31 18:25Z): 5 of 79 smoke
// requests (all answered 2xx/4xx by b9a40b21, per x-ply-version) had no ply.request log 15 min later; 4 of them had no
// invocation event either, and 3 no otel root span, while their neighbours a few ms apart were ingested within seconds.
// Across 2026-10-31 ≈12 of ~830 smoke requests (~1.4%, bursty) were lost on healthy versions. So after --wait, each
// still-missing id is looked up under every version, and scripts/canary-verdict.mjs decides: an id logged by another
// version fails (routing); an id logged nowhere is a tolerated loss iff the smoke recorded x-ply-version: <version> on its
// response and at most max(2, 2%) of the phase's ids are lost; otherwise it fails. Each tolerated loss is printed (id,
// step) on stderr, and stderr's last line is the verdict, e.g. `telemetry: 117/119 matched, 2 lost (tolerated)`.
//
// Fails (exit 1) when the verdict fails, i.e. also when any fetch invocation of <version> since <from-ms> has an outcome
// other than ok, when any of its ply.request logs has a 5xx status, or when it logged at level error.
// Prints one JSON summary on stdout (with `telemetry`, the verdict line).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseRequests, verdict } from './canary-verdict.mjs';

const [version, fromArg, idsFile] = process.argv.slice(2);
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
if (!version || !fromArg || !idsFile) { console.error('usage: canary-o11y.mjs <version-id> <from-ms> <ids.txt> [--wait s]'); process.exit(2); }
const requests = parseRequests(readFileSync(idsFile, 'utf8'));
const want = [...new Set(requests.map(r => r.id))];
const waitS = Number(arg('wait') ?? 60);
const from = Math.floor(Number(fromArg));
const PAGE = 1000, CHUNK = 50, MAX_PAGES = 50;

const f = (key, operation, value, type = 'string') => ({ key, operation, type, value });
const SERVICE = f('$metadata.service', 'eq', 'ply');
const VERSION = f('$workers.scriptVersion.id', 'eq', version);
const chunks = xs => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

// Every event matching `filters` in [from, now + 60 s], all pages.
function events(filters) {
  const out = [];
  let offset;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = {
      queryId: 'ply-canary', timeframe: { from, to: Date.now() + 60_000 }, view: 'events', limit: PAGE,
      ...(offset ? { offset } : {}), parameters: { filters },
    };
    const res = JSON.parse(execFileSync('npx', ['cf', 'o11y', 'telemetry', 'query', '--body', JSON.stringify(body)], { encoding: 'utf8', maxBuffer: 64 << 20 }));
    const evs = res.events?.events ?? [];
    out.push(...evs);
    if (evs.length < PAGE) return out;
    offset = evs.at(-1).$metadata?.id;
    if (!offset) throw new Error('a full page with no $metadata.id cursor');
  }
  throw new Error(`more than ${MAX_PAGES} pages of ${PAGE} events for ${JSON.stringify(filters)}`);
}
const smokeLogs = (ids, filters) => chunks(ids).flatMap(c => events([SERVICE, ...filters, f('msg', 'eq', 'ply.request'), f('id', 'in', c.join(','))]));

const t0 = Date.now();
const logs = new Map();  // smoke id → its ply.request log events from <version>
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let attempt = 0; ; attempt++) {
  const missing = want.filter(id => !logs.has(id));
  for (const e of smokeLogs(missing, [VERSION])) { const id = e.source?.id; if (!logs.has(id)) logs.set(id, []); logs.get(id).push(e); }
  const elapsed = Date.now() - t0;
  if (logs.size === want.length || elapsed >= waitS * 1000) break;
  await sleep(Math.min([5, 10, 15][attempt] ?? 15, waitS) * 1000);
}
const missing = want.filter(id => !logs.has(id));
const loggedBy = new Map([...logs.keys()].map(id => [id, new Set([version])]));
for (const e of missing.length ? smokeLogs(missing, []) : []) {
  const id = e.source?.id, v = e.$workers?.scriptVersion?.id ?? 'unknown';
  if (!loggedBy.has(id)) loggedBy.set(id, new Set());
  loggedBy.get(id).add(v);
}
const smokeLog = [...logs.values()].map(es => es.find(e => e.source.status !== undefined) ?? es[0]);
const requestIds = [...new Set(smokeLog.map(e => e.$metadata?.requestId).filter(Boolean))];
const inv = chunks(requestIds).flatMap(c => events([SERVICE, VERSION, f('$metadata.type', 'eq', 'cf-worker-event'), f('$metadata.requestId', 'in', c.join(','))]));
const nonOk = events([SERVICE, VERSION, f('$metadata.type', 'eq', 'cf-worker-event'), f('$workers.eventType', 'eq', 'fetch'), f('$workers.outcome', 'neq', 'ok')]);
const fivexx = events([SERVICE, VERSION, f('msg', 'eq', 'ply.request'), f('status', 'gte', 500, 'number')]);
const errors = events([SERVICE, VERSION, f('$metadata.level', 'eq', 'error')]);

const count = (xs, g) => Object.fromEntries(Object.entries(Object.groupBy(xs, g)).map(([k, v]) => [k, v.length]));
const pct = (xs, p) => { const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) * p)] : null; };
const wall = inv.map(e => e.$workers?.wallTimeMs), cpu = inv.map(e => e.$workers?.cpuTimeMs);
const brief = e => ({ t: new Date(e.timestamp).toISOString(), path: e.$workers?.event?.request?.path ?? e.source?.path, outcome: e.$workers?.outcome, status: e.source?.status, message: String(e.source?.message ?? e.$metadata?.message ?? '').slice(0, 200) });
const health = { nonOk: nonOk.length, fivexx: fivexx.length, errorLogs: errors.length };
const v = verdict({ version, requests, loggedBy, health });
for (const r of v.lost) console.error(`telemetry loss${v.lost.length <= v.allowance ? ' (tolerated)' : ''}: ${r.id} ${r.step} (answered by ${r.version}; logged by no version)`);
for (const r of v.unconfirmed) console.error(`telemetry loss (unconfirmed): ${r.id} ${r.step} (smoke saw x-ply-version ${r.version}; logged by no version)`);
for (const r of v.otherVersion) console.error(`other version: ${r.id} ${r.step} logged by ${r.loggedBy.join(',')}`);
console.error(v.line);
const summary = {
  telemetry: v.line, pass: v.pass, reasons: v.reasons,
  version, from: new Date(from).toISOString(), waitedS: Math.round((Date.now() - t0) / 1000),
  smokeRequests: want.length, matched: v.matched, missing, allowance: v.allowance,
  lost: v.lost, unconfirmed: v.unconfirmed, otherVersion: v.otherVersion,
  smokeInvocations: inv.length, smokeOutcomes: count(inv, e => e.$workers?.outcome), smokeStatuses: count(smokeLog, e => e.source.status),
  ...health,
  bad: [...nonOk, ...fivexx, ...errors].slice(0, 20).map(brief),
  wallMs: { p50: pct(wall, 0.5), p95: pct(wall, 0.95) }, cpuMs: { p50: pct(cpu, 0.5), p95: pct(cpu, 0.95) },
};
console.log(JSON.stringify(summary));
process.exit(v.pass ? 0 : 1);
