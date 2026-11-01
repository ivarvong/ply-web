// The x-artifacts-ray grammar: order, the cap, a missing ray, and a call that died before headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RAY_ENTRIES, applyUpstreamHeaders, createRayLog, durationMs, encodeRayHeader, encodeServerTiming,
  exposeRayHeaders, observeUpstream, parseCfRay, phaseOf, stampUpstreamSpans, type RayReport,
} from '../src/rays.ts';

/** Null and a missing value take the fallback. An empty string and 0 stay. */
function fill<T>(value: unknown, fallback: T): T {
  return value === null || value === void 0 ? fallback : value as T;
}

/** One property. A null receiver and a missing key are holes. A stored null stays null. */
function slot(receiver: unknown, key: string): unknown {
  if (receiver === null || receiver === void 0) return void 0;
  if (typeof receiver !== 'object' && typeof receiver !== 'function') return void 0;
  return (receiver as Record<string, unknown>)[key];
}

const HEADER = /^((ls-refs|fetch|receive-pack)=([0-9a-f]{16}-[A-Za-z]{3}|-|no-response);dur=\d+)(, ((ls-refs|fetch|receive-pack)=([0-9a-f]{16}-[A-Za-z]{3}|-|no-response);dur=\d+))*(, overflow=\d+)?$/;

function pkt(payload: string): Uint8Array<ArrayBuffer> {
  const raw = new TextEncoder().encode(`${(payload.length + 4).toString(16).padStart(4, '0')}${payload}`);
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  return copy;
}

test('phaseOf names info/refs, ls-refs, fetch, and receive-pack', () => {
  const repo = 'https://git.example/org/private.git';
  assert.equal(phaseOf('GET', `${repo}/info/refs?service=git-upload-pack`, null), 'ls-refs');
  assert.equal(phaseOf('GET', `${repo}/info/refs?service=git-receive-pack`, null), 'receive-pack');
  assert.equal(phaseOf('POST', `${repo}/git-receive-pack`, null), 'receive-pack');
  assert.equal(phaseOf('POST', `${repo}/git-upload-pack`, pkt('command=ls-refs\n')), 'ls-refs');
  assert.equal(phaseOf('POST', `${repo}/git-upload-pack`, pkt('command=fetch\n')), 'fetch');
  assert.equal(phaseOf('GET', `${repo}/git-upload-pack`, null), null);
  assert.equal(phaseOf('POST', 'not a url', null), null);
});

test('encodeRayHeader keeps start order, renders a missing ray as "-", and does not echo a bad header', () => {
  const log = createRayLog();
  const ls = log.reserve('ls-refs');
  const fetch = log.reserve('fetch');
  const push = log.reserve('receive-pack');
  assert.ok(ls !== null && fetch !== null && push !== null);
  const bad = parseCfRay('https://user:tok@github.com/secret/repo.git');
  assert.equal(bad.kind, 'missing');
  log.fill(push, parseCfRay('cccccccccccccccc-IAD'), durationMs(0, 180), true);
  log.fill(ls, bad, durationMs(0, 212), true);
  log.fill(fetch, { kind: 'no_response' }, durationMs(0, 301), true);
  const header = encodeRayHeader(log.report());
  assert.equal(header, 'ls-refs=-;dur=212, fetch=no-response;dur=301, receive-pack=cccccccccccccccc-IAD;dur=180');
  assert.match(header, HEADER);
  assert.equal(header.includes('github.com'), false);
  assert.equal(header.includes('tok'), false);
  assert.equal(header.includes('secret'), false);
});

test('the ray log caps entries and counts the rest', () => {
  const log = createRayLog();
  for (let i = 0; i < MAX_RAY_ENTRIES + 3; i++) {
    const index = log.reserve('fetch');
    if (index !== null) log.fill(index, parseCfRay('0123456789abcdef-IAD'), durationMs(0, i + 1), true);
  }
  const report = log.report();
  assert.equal(report.kind, 'overflow');
  assert.equal(report.entries.length, MAX_RAY_ENTRIES);
  if (report.kind === 'overflow') assert.equal(report.omitted, 3);
  const header = encodeRayHeader(report);
  assert.match(header, HEADER);
  assert.equal(header.split(', ').length, MAX_RAY_ENTRIES + 1);
  assert.ok(header.endsWith(', overflow=3'));
  const timing = encodeServerTiming(report, 40);
  assert.match(timing, /fetch;dur=1, fetch;dur=2/);
  assert.match(timing, /overflow;desc="3", total;dur=40$/);
});

test('observeUpstream records a ray, a missing ray, a redirect, and a failure before headers', async () => {
  const log = createRayLog();
  const call = (impl: () => Promise<Response> | Response, url: string, init: RequestInit) => observeUpstream(async () => impl(), log)(url, init);
  const upload = 'https://git.example/r.git/git-upload-pack';
  await call(() => new Response(null, { status: 200, headers: { 'cf-ray': 'aaaaaaaaaaaaaaaa-IAD' } }), upload, { method: 'POST', body: pkt('command=ls-refs\n') });
  await call(() => new Response(null, { status: 302, headers: { 'cf-ray': 'bbbbbbbbbbbbbbbb-IAD', location: '/next' } }), upload, { method: 'POST', body: pkt('command=fetch\n') });
  await call(() => new Response('x', { headers: { 'cf-ray': 'not a ray' } }), 'https://git.example/r.git/git-receive-pack', { method: 'POST' });
  await assert.rejects(() => call(() => { throw new Error('timeout'); }, upload, { method: 'POST', body: pkt('command=fetch\n') }));
  const report = log.report();
  const parts = encodeRayHeader(report).split(', ');
  assert.match(fill(parts[0], ''), /^ls-refs=aaaaaaaaaaaaaaaa-IAD;dur=\d+$/);
  assert.match(fill(parts[1], ''), /^fetch=bbbbbbbbbbbbbbbb-IAD;dur=\d+$/);
  assert.match(fill(parts[2], ''), /^receive-pack=-;dur=\d+$/);
  assert.match(fill(parts[3], ''), /^fetch=no-response;dur=\d+$/);
  assert.equal(parts.length, 4);
  assert.match(encodeRayHeader(report), HEADER);
  assert.equal(slot(report.entries[1], 'delivered'), false, 'a redirect hop is listed and not the hop ply read');
  assert.equal(report.entries[3] == null ? void 0 : report.entries[3].ray.kind, 'no_response');
});

test('headers and spans use the same tokens, and CORS exposure is opt-in', () => {
  const entries = [
    { phase: 'fetch' as const, ray: parseCfRay('https://user:tok@github.com/secret/repo.git'), durMs: durationMs(0, 4), delivered: false },
    { phase: 'fetch' as const, ray: parseCfRay('dddddddddddddddd-IAD'), durMs: durationMs(0, 9), delivered: true },
  ];
  const report: RayReport = { kind: 'within', entries };
  const headers = new Headers({ 'server-timing': 'total;dur=8, app;dur=1', 'access-control-allow-origin': 'https://app.example' });
  applyUpstreamHeaders(headers, report, 100);
  assert.equal(headers.get('x-artifacts-ray'), 'fetch=-;dur=4, fetch=dddddddddddddddd-IAD;dur=9');
  assert.equal(headers.get('server-timing'), 'fetch;dur=4, fetch;dur=9, total;dur=8, app;dur=1');
  assert.equal(headers.get('access-control-expose-headers'), 'x-artifacts-ray, server-timing');
  exposeRayHeaders(headers);
  assert.equal(headers.get('access-control-expose-headers'), 'x-artifacts-ray, server-timing');
  const bare = new Headers();
  exposeRayHeaders(bare);
  assert.equal(bare.get('access-control-expose-headers'), null);
  applyUpstreamHeaders(bare, { kind: 'within', entries: [] }, 12);
  assert.equal(bare.get('x-artifacts-ray'), null);
  assert.equal(bare.get('server-timing'), 'total;dur=12');

  const line = { resourceSpans: [{ scopeSpans: [{ spans: [
    { name: 'git.ls_tree', startTimeUnixNano: '1', attributes: [{ key: 'keep', value: { stringValue: 'yes' } }] },
    { name: 'git.upload-pack fetch', startTimeUnixNano: '10', attributes: [] },
  ] }] }] };
  stampUpstreamSpans([line], report);
  const scope = slot(line.resourceSpans[0], 'scopeSpans');
  const spans = fill(slot(slot(scope, '0'), 'spans'), [] as { name: string; attributes: { length: number } }[]);
  const tree = spans.find(span => span.name === 'git.ls_tree');
  const fetchSpan = spans.find(span => span.name === 'git.upload-pack fetch');
  assert.equal(tree == null ? void 0 : tree.attributes.length, 1, 'a non-exchange span is left alone');
  assert.deepEqual(fetchSpan == null ? void 0 : fetchSpan.attributes, [
    { key: 'git.upstream.cf_ray', value: { stringValue: 'dddddddddddddddd-IAD' } },
    { key: 'git.upstream.phase', value: { stringValue: 'fetch' } },
    { key: 'git.upstream.dur_ms', value: { intValue: '9' } },
  ]);
});
