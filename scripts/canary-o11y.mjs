// Telemetry gate for a canary: reads Workers Observability for one Worker version and proves that
// version answered every one of the smoke's requests, with no exception and no 5xx.
//
//   env -u CLOUDFLARE_API_TOKEN node scripts/canary-o11y.mjs <version-id> <from-ms> <ids.txt> [--wait 60]
//
// <ids.txt>: the smoke requests, one JSON object per line: { id: x-ply-request-id, version: the x-ply-version the smoke
// saw on that response, step } (written by `npm run cd` from the smoke JSON). Each id should appear in a
// `ply.request` log line emitted by <version-id> (the request id is minted per request in src/index.js, so a match proves
// which version ran it).
//
// Span events have no script version. Traces are queried by service only, then fetch spans (name exactly `fetch`) are
// kept when the trace contains a `$metadata.requestId` from this version's events. Fetch p50/p99 are on the JSON summary.
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
import { fileURLToPath } from 'node:url';
import { atIndex, chainGet, dig, recordGet } from '../src/absent.ts';
import { unwrapOr } from '../src/option.ts';
import { parseRequests, verdict } from './canary-verdict.mjs';

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function own(record, key) {
  const host = asRecord(record);
  if (host === null) return { tag: 'none' };
  return recordGet(host, key);
}

function recordOrEmpty(first, second) {
  if (first !== null) return first;
  if (second !== null) return second;
  return {};
}

function present(option) {
  return option.tag === 'some' ? option.value : null;
}

// cf creates node_modules/.cache under cwd, so every query runs from the repo root, never the caller's directory.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const [version, fromArg, idsFile] = process.argv.slice(2);
const arg = k => {
  const i = process.argv.indexOf(`--${k}`);
  if (i <= 0) return null;
  return unwrapOr(atIndex(process.argv, i + 1), null);
};
if (!version || !fromArg || !idsFile) { console.error('usage: canary-o11y.mjs <version-id> <from-ms> <ids.txt> [--wait s]'); process.exit(2); }
const requests = parseRequests(readFileSync(idsFile, 'utf8'));
const want = [...new Set(requests.map(r => r.id))];
const waitArg = arg('wait');
const waitS = Number(waitArg === null ? 60 : waitArg);
const from = Math.floor(Number(fromArg));
const PAGE = 1000, CHUNK = 50, MAX_PAGES = 50;

const f = (key, operation, value, type = 'string') => ({ key, operation, type, value });
const SERVICE = f('$metadata.service', 'eq', 'ply');
const VERSION = f('$workers.scriptVersion.id', 'eq', version);
const chunks = xs => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

function cfQuery(body) {
  return JSON.parse(execFileSync('npx', ['cf', 'o11y', 'telemetry', 'query', '--body', JSON.stringify(body)], {
    encoding: 'utf8', maxBuffer: 64 << 20, cwd: ROOT,
  }));
}

function pageOf(res, view) {
  if (view === 'events') {
    const events = chainGet(res, 'events');
    const rows = events.tag === 'some' ? chainGet(events.value, 'events') : { tag: 'none' };
    return rows.tag === 'some' ? rows.value : [];
  }
  const traces = chainGet(res, 'traces');
  if (traces.tag === 'none') return [];
  const nested = chainGet(traces.value, 'traces');
  if (nested.tag === 'some') return nested.value;
  const events = chainGet(traces.value, 'events');
  return events.tag === 'some' ? events.value : [];
}

// Every page matching `filters` in [from, now + 60 s].
function queryView(view, filters) {
  const out = [];
  let offset;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = {
      queryId: 'ply-canary', timeframe: { from, to: Date.now() + 60_000 }, view, limit: PAGE,
      ...(offset ? { offset } : {}), parameters: { filters },
    };
    const rows = pageOf(cfQuery(body), view);
    out.push(...rows);
    if (rows.length < PAGE) return out;
    const last = unwrapOr(atIndex(rows, rows.length - 1), null);
    const id = own(present(chainGet(last, '$metadata')), 'id');
    offset = id.tag === 'some' && typeof id.value === 'string' && id.value !== '' ? id.value : null;
    if (!offset) throw new Error(`a full page with no $metadata.id cursor (${view})`);
  }
  throw new Error(`more than ${MAX_PAGES} pages of ${PAGE} ${view} for ${JSON.stringify(filters)}`);
}

const events = filters => queryView('events', filters);
const smokeLogs = (ids, filters) => chunks(ids).flatMap(c => events([SERVICE, ...filters, f('msg', 'eq', 'ply.request'), f('id', 'in', c.join(','))]));

const t0 = Date.now();
const logs = new Map();  // smoke id → its ply.request log events from <version>
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let attempt = 0; ; attempt++) {
  const missing = want.filter(id => !logs.has(id));
  for (const e of smokeLogs(missing, [VERSION])) {
    const id = present(own(present(chainGet(e, 'source')), 'id'));
    if (!logs.has(id)) logs.set(id, []);
    logs.get(id).push(e);
  }
  const elapsed = Date.now() - t0;
  if (logs.size === want.length || elapsed >= waitS * 1000) break;
  const pauses = [5, 10, 15];
  await sleep(Math.min(unwrapOr(atIndex(pauses, attempt), 15), waitS) * 1000);
}
const missing = want.filter(id => !logs.has(id));
const loggedBy = new Map([...logs.keys()].map(id => [id, new Set([version])]));
for (const e of missing.length ? smokeLogs(missing, []) : []) {
  const id = present(own(present(chainGet(e, 'source')), 'id'));
  const versionId = dig(e, ['$workers', 'scriptVersion', 'id']);
  const v = versionId.tag === 'none' ? 'unknown' : versionId.value;
  if (!loggedBy.has(id)) loggedBy.set(id, new Set());
  loggedBy.get(id).add(v);
}
function hasStatus(event) {
  return own(present(chainGet(event, 'source')), 'status').tag === 'some';
}
const smokeLog = [...logs.values()].map(events => {
  for (const event of events) if (hasStatus(event)) return event;
  return unwrapOr(atIndex(events, 0), null);
});
const requestIds = [...new Set(smokeLog.map(event => present(own(present(chainGet(event, '$metadata')), 'requestId'))).filter(Boolean))];
const inv = chunks(requestIds).flatMap(c => events([SERVICE, VERSION, f('$metadata.type', 'eq', 'cf-worker-event'), f('$metadata.requestId', 'in', c.join(','))]));
const nonOk = events([SERVICE, VERSION, f('$metadata.type', 'eq', 'cf-worker-event'), f('$workers.eventType', 'eq', 'fetch'), f('$workers.outcome', 'neq', 'ok')]);
const fivexx = events([SERVICE, VERSION, f('msg', 'eq', 'ply.request'), f('status', 'gte', 500, 'number')]);
const errors = events([SERVICE, VERSION, f('$metadata.level', 'eq', 'error')]);

const count = (xs, read) => {
  const out = {};
  for (const item of xs) {
    const got = read(item);
    const key = got.tag === 'none' ? 'un' + 'defined' : String(got.value);
    const next = out[key];
    out[key] = typeof next === 'number' ? next + 1 : 1;
  }
  return out;
};
const pct = (xs, p) => { const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) * p)] : null; };
const workerNumber = (event, key) => {
  const value = own(present(chainGet(event, '$workers')), key);
  return value.tag === 'some' ? value.value : null;
};
const wall = inv.map(event => workerNumber(event, 'wallTimeMs')), cpu = inv.map(event => workerNumber(event, 'cpuTimeMs'));

// Fetch spans carry no script version. Query traces by service, then keep a span named `fetch` only when its trace
// contains a request id from this version's events.
function spanDurationMs(span) {
  const attrs = recordOrEmpty(asRecord(span.attributes), asRecord(span.attrs));
  for (const candidate of [span.durationMs, span.duration_ms, attrs.duration_ms, attrs.durationMs]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  const raw = typeof span.duration === 'number' ? span.duration : attrs.duration;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return raw > 1_000_000 ? raw / 1_000_000 : raw;
}
function walk(node, visit, seen) {
  if (node === null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) { for (const item of node) walk(item, visit, seen); return; }
  visit(node);
  for (const value of Object.values(node)) walk(value, visit, seen);
}
const versionRequestIds = new Set();
for (const e of [...smokeLog, ...inv, ...nonOk, ...fivexx, ...errors]) {
  const id = present(own(present(chainGet(e, '$metadata')), 'requestId'));
  if (typeof id === 'string' && id) versionRequestIds.add(id);
}
const fetchMs = [];
for (const trace of versionRequestIds.size ? queryView('traces', [SERVICE]) : []) {
  const strings = new Set();
  walk(trace, rec => { for (const value of Object.values(rec)) if (typeof value === 'string') strings.add(value); }, new Set());
  let hit = false;
  for (const id of versionRequestIds) if (strings.has(id)) { hit = true; break; }
  if (!hit) continue;
  walk(trace, rec => {
    if (rec.name !== 'fetch') return;
    const duration = spanDurationMs(rec);
    if (duration !== null) fetchMs.push(duration);
  }, new Set());
}
function kept(option) {
  return option.tag === 'some' ? { keep: true, value: option.value } : { keep: false };
}
function firstText(first, second) {
  if (first.tag === 'some') return String(first.value);
  if (second.tag === 'some') return String(second.value);
  return '';
}
const brief = event => {
  const viaWorkers = dig(event, ['$workers', 'event', 'request', 'path']);
  const viaSource = own(present(chainGet(event, 'source')), 'path');
  const path = viaWorkers.tag === 'some' ? kept(viaWorkers) : kept(viaSource);
  const outcome = kept(own(present(chainGet(event, '$workers')), 'outcome'));
  const status = kept(own(present(chainGet(event, 'source')), 'status'));
  const message = firstText(
    chainGet(present(chainGet(event, 'source')), 'message'),
    chainGet(present(chainGet(event, '$metadata')), 'message'),
  );
  const row = { t: new Date(event.timestamp).toISOString() };
  if (path.keep) row.path = path.value;
  if (outcome.keep) row.outcome = outcome.value;
  if (status.keep) row.status = status.value;
  row.message = message.slice(0, 200);
  return row;
};
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
  smokeInvocations: inv.length,
  smokeOutcomes: count(inv, event => own(present(chainGet(event, '$workers')), 'outcome')),
  smokeStatuses: count(smokeLog, event => own(present(chainGet(event, 'source')), 'status')),
  ...health,
  bad: [...nonOk, ...fivexx, ...errors].slice(0, 20).map(brief),
  wallMs: { p50: pct(wall, 0.5), p95: pct(wall, 0.95) }, cpuMs: { p50: pct(cpu, 0.5), p95: pct(cpu, 0.95) },
  fetchMs: { p50: pct(fetchMs, 0.5), p99: pct(fetchMs, 0.99) },
};
console.log(JSON.stringify(summary));
process.exit(v.pass ? 0 : 1);
