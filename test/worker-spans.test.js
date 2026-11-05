// Every /v1 route exports its ply spans to Workers tracing, nested under the request span (src/edge-trace.ts, issue #67).
// The Worker is the cf-built bundle under workerd, against git http-backend (test/server.js). A streaming tail Worker
// receives what the runtime records for each invocation (spanOpen, attributes, spanClose, logs) — the same span stream
// Workers Observability ingests — and posts it to a collector here. The route table is src/api-routes.ts, which
// src/index.js asserts at load, so a new route without a case below fails this file. Skipped if workerd is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyCfBundle } from './cf-bundle.js';
import { git, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { API_ROUTES } from '../src/api-routes.ts';
import { TRACED_EDIT_SPANS } from '../scripts/cd/span-check.ts';

const WORKERD = [process.env.WORKERD, fileURLToPath(new URL('../node_modules/.bin/workerd', import.meta.url))].filter(Boolean).find(p => existsSync(p));
const skip = !WORKERD && 'workerd not installed';
const PORT = 19000 + (process.pid % 50);
const PLY = 'test-ply-token-' + 'y'.repeat(20);
const A = { name: 'w', email: 'w@x', time: 1_700_000_000 };
let root, cleanup, srv, collector, proc, logs = '';

/** Every tail event, as the tail Worker posted it. */
const events = [];

function startCollector() {
  const s = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { events.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* not an event */ }
      res.writeHead(204); res.end();
    });
  });
  return new Promise(ok => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise(r => { s.closeAllConnections(); s.close(r); }) })));
}

// The tail Worker: one POST per event of every invocation of the Worker under test.
const TAIL = collectorUrl => `
const post = ev => fetch(${JSON.stringify(collectorUrl)}, { method: 'POST', body: JSON.stringify(ev, (k, v) => typeof v === 'bigint' ? String(v) : v) });
export default {
  tailStream(onset) {
    const sent = [post(onset)];
    return ev => { sent.push(post(ev)); return Promise.all(sent); };
  },
};
`;

before(async () => {
  if (!WORKERD) return;
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  collector = await startCollector();
  const out = join(root, 'wk'); mkdirSync(out, { recursive: true });
  copyCfBundle(join(out, 'worker.mjs'));
  writeFileSync(join(out, 'tail.mjs'), TAIL(collector.url));
  writeFileSync(join(out, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "rw", worker = (modules = [ (name = "worker.mjs", esModule = embed "worker.mjs") ], compatibilityDate = "2026-10-19", compatibilityFlags = ["nodejs_als"], globalOutbound = "internet",
      bindings = [ (name = "PLY_TOKEN", text = "${PLY}"), (name = "WRITES", text = "on"), (name = "PACK_CACHE", text = "off"), (name = "ALLOW_REMOTE_ORIGINS", text = "${srv.url}") ],
      streamingTails = [ "tail" ])),
    (name = "tail", worker = (modules = [ (name = "tail.mjs", esModule = embed "tail.mjs") ], compatibilityDate = "2026-10-19", globalOutbound = "internet")),
    (name = "internet", network = (allow = ["private", "public", "local"])),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:${PORT}", http = (), service = "rw") ],
);
`);
  proc = spawn(WORKERD, ['serve', join(out, 'config.capnp'), '--verbose'], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => { logs += d; }); proc.stderr.on('data', d => { logs += d; });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
});
after(async () => { if (!WORKERD) return; proc.kill(); await Promise.all([srv.close(), collector.close()]); cleanup(); });

let n = 0;
/** A fresh repository: main c0 → c1, feat (c0 → f1), side (c0 → s1), old at c0, tag v0 at c0. */
function seed() {
  const name = `s${n++}`;
  const bare = makeBareRepo(root, name);
  const work = join(root, `w${name}`); mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  const c0 = commitFiles(work, bare, { 'a.txt': 'one\n' }, 'c0');
  const at = (branch, from, files, msg) => {
    git(work, ['checkout', '-q', '-B', branch, from]);
    for (const [path, data] of Object.entries(files)) writeFileSync(join(work, path), data);
    git(work, ['add', '-A']);
    git(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', msg]);
    git(work, ['push', '-q', bare, `HEAD:refs/heads/${branch}`]);
    return git(work, ['rev-parse', 'HEAD']).trim();
  };
  const f1 = at('feat', c0, { 'f.txt': 'feat\n' }, 'f1');
  const s1 = at('side', c0, { 's.txt': 'side\n' }, 's1');
  const c1 = at('main', c0, { 'b.txt': 'two\n' }, 'c1');
  git(work, ['push', '-q', bare, `${c0}:refs/heads/old`]);
  git(work, ['tag', 'v0', c0]); git(work, ['push', '-q', bare, 'refs/tags/v0']);
  return { remote: `${srv.url}/${name}.git`, c0, c1, f1, s1 };
}

/**
 * One request per /v1 route, and the ply span names it must export. Each case gets its own repository.
 * `names` is a floor: every ply span the request recorded is checked below, whatever its name.
 */
const CASES = {
  'GET /v1/refs': { query: r => ({ remote: r.remote }), names: ['git.upload-pack ls-refs'] },
  'GET /v1/discover': { query: r => ({ remote: r.remote }), names: ['git.upload-pack discover'] },
  'GET /v1/tree': { query: r => ({ remote: r.remote }), names: ['git.ls_tree', 'git.upload-pack ls-refs', 'git.upload-pack fetch'] },
  'GET /v1/commit': { query: r => ({ remote: r.remote }), names: ['git.read_commit', 'git.upload-pack fetch'] },
  'GET /v1/read': { query: r => ({ remote: r.remote, path: 'a.txt' }), names: ['git.read', 'git.read.blob', 'git.upload-pack fetch'] },
  'POST /v1/edit': {
    // The shape of the CD smoke's edit-traced step: the post-deploy check requires the same names (scripts/cd/span-check.ts).
    body: r => ({ remote: r.remote, ref: 'main', path: 'a.txt', find: 'one', replace: 'uno', author: A, message: 'edit' }),
    names: TRACED_EDIT_SPANS,
  },
  'POST /v1/branch': { body: r => ({ remote: r.remote, ref: 'fresh', from: 'main' }), names: ['git.branch_create', 'git.receive-pack'] },
  'DELETE /v1/branch': { body: r => ({ remote: r.remote, ref: 'old' }), names: ['git.branch_delete', 'git.receive-pack'] },
  'POST /v1/tag': { body: r => ({ remote: r.remote, name: 'v1', target: 'main' }), names: ['git.tag_create', 'git.receive-pack'] },
  'DELETE /v1/tag': { body: r => ({ remote: r.remote, name: 'v0' }), names: ['git.tag_delete', 'git.receive-pack'] },
  'POST /v1/merge': { body: r => ({ remote: r.remote, ref: 'main', from: 'feat', author: A, message: 'merge' }), names: ['git.merge', 'git.receive-pack'] },
  'POST /v1/rebase': { body: r => ({ remote: r.remote, ref: 'feat', onto: 'main', committer: A }), names: ['git.rebase', 'git.receive-pack'] },
  'POST /v1/cherry-pick': { body: r => ({ remote: r.remote, ref: 'main', commit: r.s1, committer: A }), names: ['git.cherry_pick', 'git.receive-pack'] },
  'POST /v1/revert': { body: r => ({ remote: r.remote, ref: 'main', commit: r.c1, committer: A }), names: ['git.revert', 'git.receive-pack'] },
};

async function call(route, r) {
  const [method, path] = route.split(' ');
  const c = CASES[route];
  const qs = c.query ? `?${new URLSearchParams(c.query(r))}` : '';
  const res = await fetch(`http://127.0.0.1:${PORT}${path}${qs}`, {
    method,
    headers: { authorization: `Bearer ${PLY}`, ...(c.body ? { 'content-type': 'application/json' } : {}) },
    body: c.body ? JSON.stringify(c.body(r)) : void 0,
  });
  const text = await res.text();
  return { status: res.status, text, id: res.headers.get('x-ply-request-id') };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The tail events of the invocation that logged `ply.request` with this id, once its outcome and every span have arrived. */
async function invocationOf(id) {
  for (let i = 0; i < 100; i++) {
    const marked = events.find(e => e.event && e.event.type === 'log' && JSON.stringify(e.event).includes(`"id\\":\\"${id}\\"`));
    if (marked) {
      const mine = events.filter(e => e.invocationId === marked.invocationId).sort((a, b) => a.sequence - b.sequence);
      const opened = mine.filter(e => e.event.type === 'spanOpen').length;
      const closed = mine.filter(e => e.event.type === 'spanClose').length;
      if (mine.some(e => e.event.type === 'outcome') && opened === closed) return mine;
    }
    await sleep(50);
  }
  throw new Error(`no complete tail stream for request ${id}\n${logs.slice(-2000)}`);
}

/** Platform spans of one invocation: id, name, parent, attributes, status, closed. And the request (root) span id. */
function spansOf(mine) {
  const spans = new Map();
  for (const e of mine) {
    const ev = e.event;
    if (ev.type === 'spanOpen') spans.set(ev.spanId, { id: ev.spanId, name: ev.name, parent: e.spanContext.spanId, attrs: {}, status: null, closed: false, opened: e.sequence, closedAt: Infinity });
    const own = spans.get(e.spanContext.spanId);
    if (!own) continue;
    if (ev.type === 'attributes') for (const { name, value } of ev.info) own.attrs[name] = value;
    if (ev.type === 'spanUpdate' && ev.info.type === 'status') own.status = ev.info.status;
    if (ev.type === 'spanClose') { own.closed = true; own.closedAt = e.sequence; }
  }
  const outcome = mine.find(e => e.event.type === 'outcome');
  return { spans: [...spans.values()], rootId: outcome.spanContext.spanId };
}

/** The `ply.request` log line of the invocation, parsed. */
function requestLog(mine) {
  for (const e of mine) {
    if (e.event.type !== 'log') continue;
    for (const part of [].concat(e.event.message)) {
      try { const rec = JSON.parse(part); if (rec.msg === 'ply.request') return rec; } catch { /* another line */ }
    }
  }
  return null;
}

test('every /v1 route has a case here (src/api-routes.ts is the route table src/index.js asserts at load)', { skip }, async () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...API_ROUTES].sort());
});

test('every /v1 route exports each ply span to Workers tracing under the request span, with its attributes', { skip }, async () => {
  for (const route of API_ROUTES) {
    const r = seed();
    const res = await call(route, r);
    assert.ok(res.status >= 200 && res.status < 300, `${route}: ${res.status} ${res.text}`);
    assert.ok(res.id, `${route}: x-ply-request-id`);
    const mine = await invocationOf(res.id);
    const { spans, rootId } = spansOf(mine);
    const log = requestLog(mine);
    assert.ok(log, `${route}: ply.request log`);
    const ply = spans.filter(s => typeof s.attrs['ply.span_id'] === 'string');
    const byPlyId = new Map(ply.map(s => [s.attrs['ply.span_id'], s]));
    const byEdgeId = new Map(spans.map(s => [s.id, s]));
    const names = ply.map(s => s.name);
    if (process.env.PLY_SPANS_DEBUG) console.log(route, JSON.stringify(ply.map(s => ({ name: s.name, parent: byEdgeId.get(s.parent) ? byEdgeId.get(s.parent).name : s.parent === rootId ? '<request>' : s.parent, attrs: Object.keys(s.attrs).length }))));
    // ply's own count, logged on the request, is what Workers tracing received. /v1/read's blob span follows the
    // response (it ends when the body is drained), so the log can count one fewer.
    assert.ok(log.spans > 0, `${route}: ply recorded no span`);
    assert.ok(ply.length >= log.spans, `${route}: ply recorded ${log.spans} spans, Workers tracing got ${ply.length}: ${names.join(', ')}`);
    for (const want of CASES[route].names) assert.ok(names.includes(want), `${route}: no ${want} span in ${names.join(', ')}`);
    for (const s of ply) {
      const where = `${route} ${s.name}`;
      assert.ok(s.closed, `${where}: span not closed`);
      // Nested as ply nests it: the platform parent is the platform span of the ply parent (or of the span this one
      // follows, while that is open). A ply root, and a follower whose leader has closed, is a child of the request span.
      const hostId = s.attrs['ply.parent_span_id'] || s.attrs['ply.follows_span_id'];
      const host = hostId ? byPlyId.get(hostId) : null;
      if (hostId && !s.attrs['ply.follows_span_id']) assert.ok(host, `${where}: its ply parent ${hostId} never reached Workers tracing`);
      const want = host && host.closedAt > s.opened ? host.id : rootId;
      const got = byEdgeId.get(s.parent);
      assert.equal(s.parent, want, `${where}: platform parent is ${got ? got.name : s.parent === rootId ? 'the request span' : s.parent}, wanted ${want === rootId ? 'the request span' : host.name}`);
      let hops = 0;
      for (let at = s; at.parent !== rootId; at = byEdgeId.get(at.parent)) {
        assert.ok(byEdgeId.has(at.parent) && ++hops < 32, `${where}: does not reach the request span`);
      }
      assert.match(s.attrs['ply.trace_id'], /^[0-9a-f]{32}$/, where);
      assert.equal(typeof s.attrs['ply.duration_ms'], 'number', where);
      // ply's telemetry contract: every wire span carries these; every operation root its outcome.
      if (/^git\.(upload-pack|receive-pack)/.test(s.name)) {
        for (const key of ['git.response.bytes', 'server.address']) assert.ok(key in s.attrs, `${where}: no ${key}`);
      }
      if (/^git\.[a-z_]+$/.test(s.name) && !s.attrs['ply.parent_span_id'] && !s.attrs['ply.follows_span_id']) {
        assert.ok(`${s.name}.outcome` in s.attrs, `${where}: no ${s.name}.outcome`);
      }
    }
    // The edit in the issue (#67): delta, pack bytes, ttfb and cpu_ms are on the platform spans, as numbers.
    if (route === 'POST /v1/edit') {
      const one = name => ply.find(s => s.name === name);
      assert.equal(one('git.edit').attrs['git.edit.outcome'], 'ok');
      for (const [name, key] of [['git.edit.blob', 'git.edit.blob.delta.bytes'], ['git.edit.blob', 'git.edit.blob.cpu_ms'], ['git.receive-pack', 'git.push.pack.bytes'], ['git.receive-pack', 'http.response.ttfb_ms']]) {
        assert.equal(typeof one(name).attrs[key], 'number', `${name} ${key}`);
      }
    }
  }
});
