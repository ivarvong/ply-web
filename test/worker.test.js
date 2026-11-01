// The ply Worker (src/index.js), bundled by `cf build` exactly as `cf deploy` uploads it and run under workerd, against git
// http-backend (test/server.js). Every endpoint is judged by git; plus the bearer gate, the remote allowlist, the
// credential forwarding (verbatim and per host), credential non-leakage (responses, traces, error bodies, logs) and the
// writes switch. Skipped if workerd is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyCfBundle } from './cf-bundle.js';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { startProxy } from './proxy.js';

/** Null and a missing value take the fallback. An empty string and 0 stay. */
function fill(value, fallback) {
  return value === null || value === void 0 ? fallback : value;
}

/** One property. A null receiver and a missing key are holes. A stored null stays null. */
function slot(receiver, key) {
  if (receiver === null || receiver === void 0) return void 0;
  if (typeof receiver !== 'object' && typeof receiver !== 'function') return void 0;
  return receiver[key];
}

function closeServer(s, done) {
  const closeAll = s.closeAllConnections;
  if (closeAll != null) closeAll.call(s);
  s.close(done);
}

const WORKERD = [process.env.WORKERD, fileURLToPath(new URL('../node_modules/.bin/workerd', import.meta.url))].filter(Boolean).find(p => existsSync(p));
const skip = !WORKERD && 'workerd not installed';
const PORT = 18900 + (process.pid % 50), PORT_RO = PORT + 50;
const PLY = 'test-ply-token-' + 'x'.repeat(20);
const SECRET = 'gitcred_' + 'S3cr3tT0k3n'.repeat(3);          // the git credential the auth proxy expects
const EXPECT = `Bearer ${SECRET}`;
let root, cleanup, srv, authSrv, echoSrv, artProxy, redirSrv, raySrv, proc, logs = '';
const A = { name: 'w', email: 'w@x' };

// a git host that requires `Authorization: Bearer SECRET` (401 without, 403 with a wrong one) in front of http-backend
function authProxy(upstream) {
  const up = new URL(upstream);
  const s = http.createServer((req, res) => {
    const a = req.headers.authorization;
    if (!a) { res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }); return void res.end('Authentication required'); }
    if (a !== EXPECT && a !== `Basic ${Buffer.from(`x-access-token:${SECRET}`).toString('base64')}`) { res.writeHead(403); return void res.end('Forbidden'); }
    const u = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(u);
  });
  return new Promise(ok => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise(r => { closeServer(s, r); }) })));
}
// a hostile host that echoes the credential back in a 500 body
function echoServer() {
  const s = http.createServer((req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(`echo ${req.headers.authorization} ${Buffer.from(fill(String(req.headers.authorization).split(' ')[1], ''), 'base64').toString()}`); });
  return new Promise(ok => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise(r => { closeServer(s, r); }) })));
}

// A host that has moved repositories: `/moved/<p>` 307s to `/<p>` (same origin, relative Location), `/away/<p>` 307s to
// another allowlisted origin, `/loop/<p>` 307s to itself; anything else is proxied to http-backend. `hits` records each
// request (path, method, whether it carried Authorization) so a test can see what was and was not dialled.
function redirector(upstream) {
  const up = new URL(upstream);
  const hits = [];
  const s = http.createServer((req, res) => {
    hits.push({ path: req.url, method: req.method, auth: !!req.headers.authorization });
    const m = /^\/(moved|away|loop)(\/.*)$/.exec(req.url);
    if (m) {
      const location = m[1] === 'moved' ? m[2] : m[1] === 'away' ? `${upstream}${m[2]}` : req.url;
      req.resume(); res.writeHead(307, { location }); return void res.end();
    }
    const u = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(u);
  });
  return new Promise(ok => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${s.address().port}`, hits, close: () => new Promise(r => { closeServer(s, r); }) })));
}

// git http-backend with a cf-ray on every response. `beforeReceive` runs before a receive-pack POST is forwarded,
// so a test can move the ref and make git itself reject the push.
function rayProxy(upstream) {
  const up = new URL(upstream);
  const seen = [];
  let n = 0;
  let beforeReceive = null;
  const s = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const ray = `${(++n).toString(16).padStart(16, '0')}-IAD`;
      const path = fill(req.url, '');
      const hit = { ray, method: fill(req.method, 'GET'), path, head: body.subarray(0, 64).toString('latin1'), hook: 'skip' };
      seen.push(hit);
      const forward = () => {
        const u = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } }, r => {
          const headers = { ...r.headers, 'cf-ray': ray };
          res.writeHead(fill(r.statusCode, 502), headers);
          r.pipe(res);
        });
        u.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'cf-ray': ray, 'content-type': 'text/plain' }); res.end('upstream'); } });
        u.end(body);
      };
      Promise.resolve().then(() => {
        if (!(beforeReceive && req.method === 'POST' && path.split('?')[0].endsWith('/git-receive-pack'))) return;
        hit.hook = 'run';
        return beforeReceive();
      }).then(forward, err => {
        hit.hook = `err:${err}`;
        if (!res.headersSent) res.writeHead(500, { 'cf-ray': ray, 'content-type': 'text/plain' });
        res.end(`ray hook: ${err}`);
      });
    });
  });
  return new Promise(ok => s.listen(0, '127.0.0.1', () => ok({
    url: `http://127.0.0.1:${s.address().port}`, seen,
    setBeforeReceive(fn) { beforeReceive = fn; },
    close: () => new Promise(r => { closeServer(s, r); }),
  })));
}

before(async () => {
  if (!WORKERD) return;
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  authSrv = await authProxy(srv.url);
  echoSrv = await echoServer();
  redirSrv = await redirector(srv.url);
  const filterOf = b => fill(slot(/filter ([^\n]+)\n/.exec(Buffer.from(b).toString('latin1')), '1'), null);
  artProxy = await startProxy(srv.url, ctx => (ctx.stage === 'fetch' && filterOf(ctx.reqBody) && filterOf(ctx.reqBody) !== 'blob:none' ? { type: 'status', status: 400, contentType: 'text/plain', body: 'Unsupported Git fetch filter; only blob:none is supported.' } : { type: 'pass' }));
  raySrv = await rayProxy(srv.url);
  const out = join(root, 'wk'); mkdirSync(out, { recursive: true });
  copyCfBundle(join(out, 'worker.mjs'));
  const allow = [srv.url, authSrv.url, echoSrv.url, artProxy.url, redirSrv.url, raySrv.url].join(',');
  const worker = writes => `(modules = [ (name = "worker.mjs", esModule = embed "worker.mjs") ], compatibilityDate = "2026-10-18", globalOutbound = "internet",
    bindings = [ (name = "PLY_TOKEN", text = "${PLY}"), (name = "WRITES", text = "${writes}"), (name = "ALLOW_REMOTE_ORIGINS", text = "${allow}") ])`;
  writeFileSync(join(out, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "rw", worker = ${worker('on')}), (name = "ro", worker = ${worker('off')}), (name = "internet", network = (allow = ["private", "public", "local"])) ],
  sockets = [ (name = "http", address = "127.0.0.1:${PORT}", http = (), service = "rw"), (name = "http-ro", address = "127.0.0.1:${PORT_RO}", http = (), service = "ro") ],
);
`);
  proc = spawn(WORKERD, ['serve', join(out, 'config.capnp'), '--verbose'], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => { logs += d; }); proc.stderr.on('data', d => { logs += d; });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
});
after(async () => { if (!WORKERD) return; proc.kill(); await Promise.all([srv.close(), authSrv.close(), echoSrv.close(), artProxy.close(), redirSrv.close(), raySrv.close()]); cleanup(); });

const W = (path, { method = 'GET', body, headers = {}, port = PORT, auth = true } = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(auth ? { authorization: `Bearer ${PLY}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : void 0 });
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== void 0)).toString();
let n = 0;
function repo(files, host = () => srv.url) {
  const name = `r${n++}`; const bare = makeBareRepo(root, name); const work = join(root, `w${name}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const head = commitFiles(work, bare, files, 'seed');
  return { name, bare, work, head, remote: `${host()}/${name}.git` };
}

test('GET / is public usage text; everything else needs the PLY bearer (missing or wrong → 401)', { skip }, async () => {
  const u = await W('/', { auth: false }); assert.equal(u.status, 200); const usage = await u.text(); assert.match(usage, /Authorization: Bearer <PLY_TOKEN>/); assert.match(usage, /GET +\/v1\/commit\?remote=&ref=/);
  for (const [m, p] of [['GET', '/v1/refs'], ['GET', '/v1/read'], ['GET', '/v1/tree'], ['GET', '/v1/discover'], ['GET', '/v1/commit'], ['POST', '/v1/edit'], ['POST', '/v1/branch'], ['DELETE', '/v1/branch'], ['POST', '/v1/merge'], ['POST', '/v1/rebase'], ['POST', '/v1/cherry-pick'], ['POST', '/v1/revert'], ['POST', '/v1/tag'], ['DELETE', '/v1/tag'], ['GET', '/nope']]) {
    for (const headers of [{}, { authorization: `Bearer ${PLY}x` }, { authorization: `Bearer ${PLY.slice(0, -1)}` }, { authorization: `Basic ${btoa(`x:${PLY}`)}` }]) {
      const r = await W(`${p}?remote=${encodeURIComponent(srv.url + '/x.git')}`, { method: m, headers, auth: false });
      assert.equal(r.status, 401, `${m} ${p} ${JSON.stringify(headers)}`); assert.equal((await r.json()).code, 'unauthorized');
      assert.match(fill(r.headers.get('www-authenticate'), ''), /Bearer/);
    }
  }
  assert.equal((await W('/nope')).status, 404);
  assert.equal((await W('/v1/read', { method: 'POST' })).status, 405);
});

function assertSecurityHeaders(headers, where) {
  assert.equal(headers.get('x-content-type-options'), 'nosniff', where);
  assert.equal(headers.get('referrer-policy'), 'no-referrer', where);
  const csp = fill(headers.get('content-security-policy'), '');
  assert.match(csp, /frame-ancestors 'none'/, where);
  assert.match(csp, /script-src 'none'/, where);
  assert.equal(csp.includes('unsafe-inline'), false, where);
}

test('security headers are set on every route', { skip }, async () => {
  const routes = [
    ['GET', '/', false],
    ['GET', '/nope', true],
    ['GET', '/v1/refs', false],
    ['GET', `/v1/refs?${qs({ remote: 'https://127.0.0.1.nip.io/x.git' })}`, true],
    ['POST', '/v1/edit', true],
    ['GET', '/view', false],
    ['HEAD', '/view', false],
    ['GET', '/view.css', false],
    ['GET', '/view/evil.example/a/b', false],
    ['GET', '/view/github.com/a/%2f../b', false],
    ['POST', '/view', false],
  ];
  for (const [method, path, auth] of routes) {
    const res = await W(path, { method, auth, body: method === 'POST' && path === '/v1/edit' ? { remote: 'https://127.0.0.1/x.git' } : void 0 });
    assertSecurityHeaders(res.headers, `${method} ${path}`);
    await res.arrayBuffer();
  }
});

test('remote allowlist: https only, no IP literals / private names / userinfo / ports / query; nothing is fetched', { skip }, async () => {
  const bad = ['http://example.com/x.git', 'https://127.0.0.1/x.git', 'https://10.0.0.1/x.git', 'https://169.254.169.254/x.git', 'https://192.168.1.1/x.git', 'https://[::1]/x.git', 'https://[fd00::1]/x.git',
    'https://2130706433/x.git', 'https://0x7f000001/x.git', 'https://localhost/x.git', 'https://foo.localhost/x.git', 'https://git.internal/x.git', 'https://intranet/x.git', 'https://user:pw@github.com/x.git',
    'https://github.com:8443/x.git', 'https://github.com/x.git?a=b', 'ftp://github.com/x.git', 'not a url', '',
    'https://127.0.0.1.nip.io/x.git', 'https://169.254.169.254.nip.io/latest', 'https://foo.localtest.me/x.git',
    'https://127-0-0-1.sslip.io/x.git', 'https://github.com./x.git', 'https://0177.0.0.1/x.git', 'https://[::ffff:127.0.0.1]/x.git'];
  for (const remote of bad) {
    const r = await W(`/v1/refs?${qs({ remote, trace: '1' })}`);
    const b = await r.json();
    assert.equal(r.status, 400, `${remote}: ${JSON.stringify(b)}`); assert.equal(b.code, 'bad_request'); assert.equal(b.retry, 'no');
    assert.deepEqual(b.trace, [], 'refused before any span (no request was made)');
  }
  const w = await W('/v1/edit', { method: 'POST', body: { remote: 'https://127.0.0.1/x.git', path: 'a', find: 'b', replace: 'c', author: A, message: 'm' } });
  assert.equal(w.status, 400);
});

test('read endpoints equal git: refs, discover, tree, read (bytes, headers, content-length, streamed 3 MiB)', { skip }, async () => {
  const big = Buffer.alloc(3 << 20); for (let i = 0; i < big.length; i += 5) big[i] = i & 255;
  const r = repo({ 'README.md': '# hello\n', 'a/b/c.txt': 'nested\n', 'empty': '', 'big.bin': big });
  git(r.work, ['tag', '-a', '-m', 't', 'v1']); git(r.work, ['push', '-q', r.bare, 'refs/tags/v1']);
  const refs = await (await W(`/v1/refs?${qs({ remote: r.remote })}`)).json();
  assert.equal(refs.head, 'refs/heads/main'); assert.equal(refs.refs['refs/heads/main'], r.head);
  assert.equal(refs.refs['refs/tags/v1'], git(r.bare, ['rev-parse', 'v1']).trim()); assert.equal(refs.peeled['refs/tags/v1'], r.head);
  const pre = await (await W(`/v1/refs?${qs({ remote: r.remote, prefix: 'refs/tags/' })}`)).json();
  assert.deepEqual(Object.keys(pre.refs), ['refs/tags/v1']); assert.equal(pre.head, 'refs/heads/main');
  const d = await (await W(`/v1/discover?${qs({ remote: r.remote })}`)).json();
  assert.equal(d.version, 2); assert.match(d.agent, /^git\//); assert.equal(d.objectFormat, 'sha1');
  const tr = await (await W(`/v1/tree?${qs({ remote: r.remote, path: 'a/b' })}`)).json();
  assert.deepEqual(tr.entries, [{ name: 'c.txt', mode: '100644', oid: git(r.bare, ['rev-parse', 'main:a/b/c.txt']).trim(), type: 'blob' }]);
  const top = await (await W(`/v1/tree?${qs({ remote: r.remote, ref: 'v1' })}`)).json();
  assert.equal(top.tree, git(r.bare, ['rev-parse', 'v1^{tree}']).trim()); assert.equal(top.entries.length, 4);
  for (const path of ['README.md', 'a/b/c.txt', 'empty', 'big.bin']) {
    const res = await W(`/v1/read?${qs({ remote: r.remote, path })}`);
    assert.equal(res.status, 200, path);
    const got = Buffer.from(await res.arrayBuffer()), want = gitBuf(r.bare, ['show', `main:${path}`]);
    assert.ok(got.equals(want), `${path} bytes`);
    assert.equal(res.headers.get('content-length'), String(want.length), `${path} content-length`);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('x-ply-commit'), r.head); assert.equal(res.headers.get('x-ply-blob'), git(r.bare, ['rev-parse', `main:${path}`]).trim());
  }
  const tr1 = await W(`/v1/read?${qs({ remote: r.remote, path: 'README.md', trace: '1' })}`);
  assert.match(tr1.headers.get('x-ply-trace'), /ls-refs;dur=\d+/); await tr1.arrayBuffer();
  for (const [path, code, status] of [['nope', 'not_found', 404], ['a/b', 'bad_request', 400], ['README.md/x', 'not_found', 404], ['../x', 'bad_request', 400]]) {
    const res = await W(`/v1/read?${qs({ remote: r.remote, path })}`); const b = await res.json();
    assert.equal(res.status, status, path); assert.equal(b.code, code); assert.equal(b.retry, 'no');
    if (path === 'a/b') assert.match(b.message, /GET \/v1\/tree/);
    assert.equal(res.headers.get('x-ply-trace'), null);
  }
  const nr = await W(`/v1/read?${qs({ remote: r.remote, path: 'README.md', ref: 'nope' })}`); assert.equal(nr.status, 404);
  const trace = await (await W(`/v1/tree?${qs({ remote: r.remote, trace: '1' })}`)).json();
  assert.ok(trace.trace.some(s => s.name === 'git.upload-pack ls-refs') && trace.trace.some(s => s.name === 'git.ls_tree'));
});

test('GET /v1/commit equals git log / cat-file (HEAD, short, full, tag, oid, merge); not_found / bad_request shapes; blob:none fallback', { skip }, async () => {
  const r = repo({ 'f.txt': 'one\n' });
  git(r.work, ['tag', '-a', '-m', 't', 'v1']);
  git(r.work, ['checkout', '-q', '-b', 'side']); writeFileSync(join(r.work, 's.txt'), 's\n'); git(r.work, ['add', '-A']);
  git(r.work, ['commit', '-q', '-m', 'side: Zoë\n\nline two\nline three'], { env: { ...process.env, GIT_AUTHOR_NAME: 'Zoë Ångström', GIT_AUTHOR_EMAIL: 'z@ë.x', GIT_AUTHOR_DATE: '1700000000 +0530', GIT_COMMITTER_NAME: 'C', GIT_COMMITTER_EMAIL: 'c@x', GIT_COMMITTER_DATE: '1700000100 -0800' } });
  git(r.work, ['checkout', '-q', 'main']); writeFileSync(join(r.work, 'm.txt'), 'm\n'); git(r.work, ['add', '-A']);
  git(r.work, ['-c', 'user.name=m', '-c', 'user.email=m@x', 'commit', '-q', '-m', 'main']);
  git(r.work, ['-c', 'user.name=m', '-c', 'user.email=m@x', 'merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
  git(r.work, ['push', '-q', r.bare, 'main', 'side', 'refs/tags/v1']);
  const want = (spec, bare = r.bare) => {
    const [oid, tree, parents, an, ae, ad, cn, ce, cd] = git(bare, ['log', '-1', '--date=raw', `--format=%H%x1f%T%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%cn%x1f%ce%x1f%cd`, spec]).replace(/\n$/, '').split('\x1f');
    const raw = gitBuf(bare, ['cat-file', 'commit', oid]).toString(); const id = (name, email, d) => { const [epoch, tz] = d.split(' '); return { name, email, time: new Date(Number(epoch) * 1000).toISOString().replace('.000Z', 'Z'), epoch: Number(epoch), tz }; };
    return { oid, tree, parents: parents ? parents.split(' ') : [], author: id(an, ae, ad), committer: id(cn, ce, cd), message: raw.slice(raw.indexOf('\n\n') + 2), signed: false };
  };
  const side = git(r.bare, ['rev-parse', 'side']).trim();
  for (const [ref, spec, name] of [[void 0, 'main', 'refs/heads/main'], ['main', 'main', 'refs/heads/main'], ['refs/heads/side', 'side', 'refs/heads/side'], ['v1', 'v1^{commit}', 'refs/tags/v1'], [side, side, side]]) {
    const res = await W(`/v1/commit?${qs({ remote: r.remote, ref })}`);
    const b = await res.json();
    assert.equal(res.status, 200, JSON.stringify(b)); assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(b, { ref: name, ...want(spec) }, String(ref));
  }
  const m = await (await W(`/v1/commit?${qs({ remote: r.remote })}`)).json();
  assert.equal(m.parents.length, 2); assert.equal(m.parents[1], side);
  const shortRes = await W(`/v1/commit?${qs({ remote: r.remote, ref: side.slice(0, 8) })}`);
  const shortBody = await shortRes.json();
  assert.equal(shortRes.status, 200, JSON.stringify(shortBody));
  assert.equal(shortBody.oid, side);
  assert.equal(shortRes.headers.get('cache-control'), 'no-store', 'an abbreviated oid is not a full oid');
  // /v1 is a credentialed API: every response is no-store with no Vary, even tree/read/commit at a full oid (an
  // immutable answer), errors included
  for (const [path, extra] of [['/v1/commit', {}], ['/v1/tree', {}], ['/v1/read', { path: 's.txt' }], ['/v1/read', { path: 's.txt', trace: '1' }], ['/v1/refs', {}], ['/v1/discover', {}], ['/v1/read', { path: 'no-such-file' }], ['/v1/commit', { ref: 'f'.repeat(40) }]]) {
    const res = await W(`${path}?${qs({ remote: r.remote, ref: side, ...extra })}`); await res.arrayBuffer();
    const what = `${path} ${JSON.stringify(extra)} → ${res.status}`;
    if (!extra.ref && extra.path !== 'no-such-file') assert.equal(res.status, 200, what);
    assert.equal(res.headers.get('cache-control'), 'no-store', what); assert.equal(res.headers.get('vary'), null, what);
  }
  const noAuth = await W(`/v1/read?${qs({ remote: r.remote, ref: side, path: 's.txt' })}`, { auth: false }); await noAuth.arrayBuffer();
  assert.equal(noAuth.status, 401); assert.equal(noAuth.headers.get('cache-control'), 'no-store');
  // refs and discover ignore ref=, so an abbreviated oid there does not cost them an abbrev ls-refs
  for (const path of ['/v1/refs', '/v1/discover']) {
    const abbrev = await W(`${path}?${qs({ remote: r.remote, ref: 'abcdef1' })}`); await abbrev.arrayBuffer();
    assert.equal(abbrev.status, 200, `${path} ignores an abbreviated ref`);
  }
  const failRes = await W(`/v1/commit?${qs({ remote: r.remote, ref: 'f'.repeat(40) })}`); await failRes.arrayBuffer();
  assert.equal(failRes.headers.get('cache-control'), 'no-store', 'an error is no-store');
  const noneRes = await W(`/v1/commit?${qs({ remote: r.remote, ref: 'abcdef1' })}`);
  const noneBody = await noneRes.json();
  assert.equal(noneRes.status, 400, JSON.stringify(noneBody));
  assert.equal(noneBody.code, 'bad_request');
  assert.match(noneBody.message, /40-hex/);
  const usage = await W('/');
  assert.equal(usage.status, 200);
  const usageText = await usage.text();
  assert.match(usageText, /entries:\[\{name, mode, oid, type\}\]/);
  assert.match(usageText, /GET \/view/);
  assert.match(usageText, /GET \/r\/<name>/);
  assert.match(fill(usage.headers.get('x-ply-build'), ''), /^ply=[0-9a-f]{40} ply-web=[0-9a-f]{40}$/);
  assert.doesNotMatch(fill(usage.headers.get('x-ply-version'), ''), /ply=/, 'x-ply-version stays the Workers version id');
  const s = await (await W(`/v1/commit?${qs({ remote: r.remote, ref: 'side' })}`)).json();
  assert.deepEqual(s.author, { name: 'Zoë Ångström', email: 'z@ë.x', time: '2023-11-14T22:13:20Z', epoch: 1700000000, tz: '+0530' }); assert.equal(s.message, 'side: Zoë\n\nline two\nline three\n');
  for (const [ref, status, code] of [['nope', 404, 'not_found'], ['f'.repeat(40), 404, 'not_found'], [git(r.bare, ['rev-parse', 'main:f.txt']).trim(), 404, 'not_found'], ['a..b', 400, 'bad_request']]) {
    const res = await W(`/v1/commit?${qs({ remote: r.remote, ref })}`); const b = await res.json();
    assert.equal(res.status, status, `${ref}: ${JSON.stringify(b)}`); assert.equal(b.code, code); assert.equal(b.retry, 'no');
  }
  const missing = await W(`/v1/commit?${qs({ remote: `${srv.url}/does-not-exist.git` })}`); assert.equal(missing.status, 404); assert.equal((await missing.json()).code, 'not_found');
  assert.equal((await W('/v1/commit')).status, 400);
  assert.equal((await W(`/v1/commit?${qs({ remote: r.remote })}`, { method: 'POST' })).status, 405);
  const tr = await (await W(`/v1/commit?${qs({ remote: r.remote, trace: '1' })}`)).json();
  const fetches = tr.trace.filter(x => x.name === 'git.upload-pack fetch');
  assert.equal(fetches.length, 1); assert.equal(fetches[0].attrs['git.fetch.filter'], 'tree:0'); assert.equal(fetches[0].attrs['git.fetch.deepen'], 1);
  // Artifacts mode: tree:0 refused → blob:none, same answer
  const a = repo({ 'x.txt': 'x\n' }, () => artProxy.url);
  const ab = await (await W(`/v1/commit?${qs({ remote: a.remote, trace: '1' })}`)).json();
  const { trace, ...rest } = ab;
  assert.deepEqual(rest, { ref: 'refs/heads/main', ...want('main', a.bare) }); assert.equal(rest.oid, a.head);
  assert.ok(trace.some(x => x.attrs['git.fetch.filter.fallback'] === 'blob:none'));
});

test('a server that refuses tree:0 (Artifacts mode): reads and an edit still match git via the blob:none fallback', { skip }, async () => {
  const r = repo({ 'd/e/f.txt': 'deep MARK\n', 'x.txt': 'x\n' }, () => artProxy.url);
  const res = await W(`/v1/read?${qs({ remote: r.remote, path: 'd/e/f.txt', trace: '1' })}`);
  assert.equal(res.status, 200); assert.equal(await res.text(), 'deep MARK\n');
  const tr = await (await W(`/v1/tree?${qs({ remote: r.remote, path: 'd', trace: '1' })}`)).json();
  assert.equal(tr.tree, git(r.bare, ['rev-parse', 'main:d']).trim());
  const e = await (await W('/v1/edit?trace=1', { method: 'POST', body: { remote: r.remote, path: 'd/e/f.txt', find: 'MARK', replace: 'EDITED', author: A, message: 'm' } })).json();
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), e.newCommit, JSON.stringify(e).slice(0, 400));
  assert.equal(gitBuf(r.bare, ['show', 'main:d/e/f.txt']).toString(), 'deep EDITED\n');
  assert.ok(e.trace.some(s => s.attrs['git.fetch.filter.fallback'] === 'blob:none'));
});

test('empty repo lifecycle: first commit through history, with no git seeding', { skip }, async () => {
  const name = `e${n++}`;
  const bare = makeBareRepo(root, name);
  // srv's origin was already discovered by the missing-repo commit read above. raySrv is a different origin
  // (it proxies the same http-backend) and this isolate has not asked it for ls-refs=unborn yet.
  const remote = `${raySrv.url}/${name}.git`;
  const post = (p, body, method = 'POST') => W(p + (p.includes('?') ? '' : ''), { method, body: { remote, ...body } }).then(async res => ({ status: res.status, body: await res.json() }));
  const ZERO = '0'.repeat(40);
  assert.equal(git(bare, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/main');
  assert.throws(() => git(bare, ['rev-parse', '--verify', 'HEAD']));
  const emptyRes = await W(`/v1/commit?${qs({ remote, trace: '1' })}`);
  const emptyBody = await emptyRes.json();
  const { trace: coldTrace, ...empty } = emptyBody;
  assert.deepEqual(empty, { empty: true, ref: 'refs/heads/main', oid: null, tree: null, parents: [], author: null, committer: null, message: null, signed: false });
  // ply's readCommit resolves an unborn HEAD itself: one discover, then the unborn ls-refs. No git.head span (that is the Worker's own HEAD read).
  assert.equal(coldTrace.filter(s => s.name === 'git.upload-pack discover').length, 1, JSON.stringify(coldTrace.map(s => s.name)));
  assert.equal(coldTrace.some(s => s.name === 'git.head'), false);
  const coldLs = (fill(emptyRes.headers.get('x-artifacts-ray'), '')).split(', ').filter(part => part.startsWith('ls-refs=')).length;
  assert.match(fill(emptyRes.headers.get('x-ply-request-id'), ''), /\S/);
  assert.match(fill(emptyRes.headers.get('x-ply-build'), ''), /^ply=[0-9a-f]{40} ply-web=[0-9a-f]{40}$/);
  assert.match(fill(emptyRes.headers.get('server-timing'), ''), /ls-refs;dur=\d+/);
  assert.match(fill(emptyRes.headers.get('server-timing'), ''), /total;dur=\d+/);
  const warmRes = await W(`/v1/commit?${qs({ remote, ref: 'main', trace: '1' })}`);
  const warmBody = await warmRes.json();
  const { trace: warmTrace, ...warm } = warmBody;
  assert.deepEqual(warm, empty);
  // ply does not share the Worker's advertisement cache, so this read discovers again. The Worker records the bit for later HEAD reads.
  assert.equal(warmTrace.filter(s => s.name === 'git.upload-pack discover').length, 1, JSON.stringify(warmTrace.map(s => s.name)));
  assert.equal(warmTrace.some(s => s.name === 'git.head'), false);
  const warmLs = (fill(warmRes.headers.get('x-artifacts-ray'), '')).split(', ').filter(part => part.startsWith('ls-refs=')).length;
  assert.equal(coldLs, warmLs, `cold ${emptyRes.headers.get('x-artifacts-ray')} warm ${warmRes.headers.get('x-artifacts-ray')}`);
  assert.notEqual(warmRes.headers.get('x-ply-request-id'), emptyRes.headers.get('x-ply-request-id'));
  assert.match(fill(warmRes.headers.get('server-timing'), ''), /total;dur=\d+/);
  assert.equal((await W(`/v1/commit?${qs({ remote, ref: 'nope' })}`)).status, 404);
  const refs = await (await W(`/v1/refs?${qs({ remote })}`)).json();
  assert.equal(refs.head, null); assert.equal(refs.empty, true); assert.equal(refs.unborn, 'refs/heads/main');
  let x = await post('/v1/branch', { ref: 'tmp' });
  assert.equal(x.status, 400, JSON.stringify(x.body)); assert.match(x.body.message, /from is required when the remote HEAD is unborn \(refs\/heads\/main\)/);
  x = await post('/v1/branch', { ref: 'tmp', from: ZERO });
  assert.equal(x.status, 400, JSON.stringify(x.body)); assert.match(x.body.message, /zero oid/);
  assert.throws(() => git(bare, ['rev-parse', '--verify', '-q', 'refs/heads/tmp']));
  x = await post('/v1/merge', { from: 'main' });
  assert.equal(x.status, 400, JSON.stringify(x.body)); assert.match(x.body.message, /ref is required when the remote HEAD is unborn \(refs\/heads\/main\)/);
  x = await post('/v1/edit', { base: ZERO, path: 'a.txt', content: 'a\n', author: A, message: 'no' });
  assert.equal(x.status, 400, JSON.stringify(x.body)); assert.match(x.body.message, /zero oid/);
  const author = { ...A, tz: '+0530', time: 1700000000 };
  x = await post('/v1/edit?trace=1', { message: 'init', author, changes: [
    { op: 'create', path: 'README.md', content: 'hello\n' },
    { op: 'create', path: 'src/a.txt', content: 'v1\n' },
    { op: 'create', path: 'src/keep.txt', content: 'keep\n' },
    { op: 'create', path: 'old.txt', content: 'x\n' },
    { op: 'create', path: 'bin/run', content: '#!/bin/sh\n', mode: '100755' },
    { op: 'create', path: 'link', content: 'README.md', mode: '120000' },
  ] });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  assert.equal(x.body.outcome, 'commit'); assert.equal(x.body.ref, 'refs/heads/main'); assert.equal(x.body.oldOid, null); assert.equal(x.body.oldCommit, null); assert.equal(x.body.noop, false);
  const c0 = x.body.oid;
  assert.equal(x.body.newCommit, c0);
  assert.equal(git(bare, ['rev-parse', 'main']).trim(), c0);
  assert.ok(x.body.trace.some(s => s.name === 'git.commit' || s.name === 'git.head'), JSON.stringify(x.body.trace == null ? void 0 : x.body.trace.map(s => s.name)));
  assert.equal(x.body.trace.filter(s => s.name === 'git.upload-pack discover').length, 0, 'HEAD capability was cached by the commit reads');
  const raw0 = gitBuf(bare, ['cat-file', 'commit', c0]).toString();
  assert.equal(raw0.split('\n').some(l => l.startsWith('parent ')), false);
  assert.match(raw0, /author w <w@x> 1700000000 \+0530\n/);
  assert.match(raw0, /committer w <w@x> 1700000000 \+0530\n/);
  assert.match(git(bare, ['ls-tree', '-r', c0]), /100755 blob [0-9a-f]{40}\tbin\/run/);
  assert.match(git(bare, ['ls-tree', '-r', c0]), /120000 blob [0-9a-f]{40}\tlink/);
  assert.equal(gitBuf(bare, ['cat-file', '-p', `${c0}:link`]).toString(), 'README.md');
  const born = await (await W(`/v1/commit?${qs({ remote })}`)).json();
  assert.equal(born.oid, c0); assert.equal(born.parents.length, 0); assert.equal(born.author.tz, '+0530'); assert.equal(born.author.epoch, 1700000000); assert.equal(born.empty, void 0);
  const bornRefs = await (await W(`/v1/refs?${qs({ remote })}`)).json();
  assert.equal(bornRefs.head, 'refs/heads/main'); assert.equal(bornRefs.refs['refs/heads/main'], c0); assert.equal(bornRefs.empty, void 0);
  x = await post('/v1/edit', { message: 'second', author: { ...A, time: 1700000100 }, committer: { name: 'c', email: 'c@x', tz: '-0800', time: 1700000100 }, changes: [
    { op: 'edit', path: 'src/a.txt', find: 'v1', replace: 'v2' },
    { op: 'delete', path: 'src/keep.txt' },
    { op: 'create', path: 'ADDED.txt', content: 'added\n' },
    { op: 'rename', path: 'old.txt', to: 'new.txt' },
  ] });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  const c1 = x.body.oid;
  assert.equal(x.body.oldOid, c0); assert.equal(git(bare, ['rev-parse', 'main']).trim(), c1);
  const raw1 = gitBuf(bare, ['cat-file', 'commit', c1]).toString();
  assert.match(raw1, new RegExp(`parent ${c0}\\n`));
  assert.match(raw1, /author w <w@x> 1700000100 \+0000\n/);
  assert.match(raw1, /committer c <c@x> 1700000100 -0800\n/);
  assert.equal(gitBuf(bare, ['show', 'main:src/a.txt']).toString(), 'v2\n');
  assert.equal(gitBuf(bare, ['show', 'main:ADDED.txt']).toString(), 'added\n');
  assert.equal(gitBuf(bare, ['show', 'main:new.txt']).toString(), 'x\n');
  assert.throws(() => git(bare, ['cat-file', '-e', 'main:src/keep.txt']));
  assert.throws(() => git(bare, ['cat-file', '-e', 'main:old.txt']));
  x = await post('/v1/branch', { ref: 'other', from: c0 });
  assert.equal(x.status, 201, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'created'); assert.equal(x.body.oid, c0); assert.equal(x.body.oldOid, null);
  x = await post('/v1/edit', { ref: 'other', message: 'other same', author: A, changes: [
    { op: 'edit', path: 'src/a.txt', find: 'v1', replace: 'v2' },
    { op: 'delete', path: 'src/keep.txt' },
    { op: 'create', path: 'ADDED.txt', content: 'added\n' },
    { op: 'rename', path: 'old.txt', to: 'new.txt' },
  ] });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  const otherTip = x.body.oid;
  assert.equal(git(bare, ['rev-parse', 'other^{tree}']).trim(), git(bare, ['rev-parse', `${c1}^{tree}`]).trim());
  x = await post('/v1/cherry-pick', { ref: 'other', commit: c1, committer: A });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'empty'); assert.equal(x.body.noop, true); assert.equal(x.body.oid, otherTip);
  assert.equal(git(bare, ['rev-parse', 'other']).trim(), otherTip);
  x = await post('/v1/cherry-pick', { ref: 'other', commit: c1, committer: A, allowEmpty: true });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'cherry_pick'); assert.equal(x.body.noop, false);
  const emptyPick = x.body.oid;
  assert.notEqual(emptyPick, otherTip);
  assert.equal(git(bare, ['rev-parse', 'other']).trim(), emptyPick);
  assert.equal(git(bare, ['rev-parse', 'other^{tree}']).trim(), git(bare, ['rev-parse', `${otherTip}^{tree}`]).trim());
  assert.equal(git(bare, ['rev-parse', 'other^']).trim(), otherTip);
  // The same patch, plus an add that exists only on the target. ply keeps the rename guard, so this is 409, not empty.
  x = await post('/v1/branch', { ref: 'wider', from: c0 });
  assert.equal(x.status, 201, JSON.stringify(x.body));
  x = await post('/v1/edit', { ref: 'wider', message: 'wider', author: A, changes: [
    { op: 'edit', path: 'src/a.txt', find: 'v1', replace: 'v2' },
    { op: 'delete', path: 'src/keep.txt' },
    { op: 'create', path: 'ADDED.txt', content: 'added\n' },
    { op: 'rename', path: 'old.txt', to: 'new.txt' },
    { op: 'create', path: 'extra.txt', content: 'only here\n' },
  ] });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  const widerTip = x.body.oid;
  x = await post('/v1/cherry-pick', { ref: 'wider', commit: c1, committer: A });
  assert.equal(x.status, 409, JSON.stringify(x.body));
  assert.equal(x.body.code, 'merge_conflict');
  assert.equal(x.body.retry, 'no');
  assert.equal(git(bare, ['rev-parse', 'wider']).trim(), widerTip);
  x = await post('/v1/cherry-pick', { ref: 'wider', commit: c1, committer: A, allowEmpty: true });
  assert.equal(x.status, 409, JSON.stringify(x.body));
  assert.equal(x.body.code, 'merge_conflict');
  assert.equal(git(bare, ['rev-parse', 'wider']).trim(), widerTip);
  x = await post('/v1/branch', { ref: 'feat', from: c1 });
  assert.equal(x.status, 201); assert.equal(x.body.oid, c1);
  x = await post('/v1/edit', { ref: 'feat', message: 'feat file', author: A, changes: [{ op: 'create', path: 'feat.txt', content: 'feat\n' }] });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  const feat = x.body.oid;
  x = await post('/v1/cherry-pick', { commit: feat, committer: A });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'cherry_pick');
  assert.equal(gitBuf(bare, ['show', 'main:feat.txt']).toString(), 'feat\n');
  const picked = x.body.oid;
  x = await post('/v1/revert', { commit: picked, committer: A });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'revert');
  assert.throws(() => git(bare, ['cat-file', '-e', 'main:feat.txt']));
  const mainNow = x.body.oid;
  x = await post('/v1/branch', { ref: 'side', from: mainNow });
  assert.equal(x.status, 201); assert.equal(x.body.oid, mainNow);
  x = await post('/v1/edit', { ref: 'side', path: 'README.md', find: 'hello', replace: 'hello side', author: A, message: 'side readme' });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  const side = x.body.oid;
  x = await post('/v1/edit', { path: 'ADDED.txt', find: 'added', replace: 'added main', author: A, message: 'main added' });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  const mainMoved = x.body.oid;
  assert.equal(git(bare, ['rev-parse', 'side']).trim(), side);
  assert.equal(git(bare, ['rev-parse', 'main']).trim(), mainMoved);
  x = await post('/v1/merge', { from: side, author: { ...A, tz: '+0530', time: 1700000200 }, committer: { name: 'c', email: 'c@x', tz: '-0800', time: 1700000300 }, message: 'merge side' });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'merge');
  assert.equal(git(bare, ['rev-parse', 'main']).trim(), x.body.oid);
  assert.equal(gitBuf(bare, ['show', 'main:README.md']).toString(), 'hello side\n');
  assert.equal(gitBuf(bare, ['show', 'main:ADDED.txt']).toString(), 'added main\n');
  const merged = gitBuf(bare, ['cat-file', 'commit', x.body.oid]).toString();
  assert.match(merged, /author w <w@x> 1700000200 \+0530\n/);
  assert.match(merged, /committer c <c@x> 1700000300 -0800\n/);
  x = await post('/v1/branch', { ref: 'reb', from: c0 });
  assert.equal(x.status, 201);
  x = await post('/v1/edit', { ref: 'reb', message: 'reb file', author: A, changes: [{ op: 'create', path: 'reb.txt', content: 'reb\n' }] });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  const rebBefore = git(bare, ['rev-parse', 'reb']).trim();
  x = await post('/v1/rebase', { ref: 'reb', onto: ZERO, committer: A });
  assert.equal(x.status, 400, JSON.stringify(x.body)); assert.match(x.body.message, /zero oid/);
  assert.equal(git(bare, ['rev-parse', 'reb']).trim(), rebBefore);
  x = await post('/v1/rebase', { ref: 'reb', onto: 'main', committer: { name: 'c', email: 'c@x', tz: '-0800', time: 1700000400 }, author: { ...A, tz: '+0530', time: 1700000500 } });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'rebase');
  assert.equal(gitBuf(bare, ['show', 'reb:reb.txt']).toString(), 'reb\n');
  assert.equal(git(bare, ['merge-base', 'reb', 'main']).trim(), git(bare, ['rev-parse', 'main']).trim());
  assert.match(gitBuf(bare, ['cat-file', 'commit', x.body.oid]).toString(), /committer c <c@x> 1700000400 -0800\n/);
  x = await post('/v1/edit', { ref: 'from-oid', base: c0, message: 'from oid', author: A, changes: [{ op: 'create', path: 'from-oid.txt', content: 'p\n' }] });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  const fromOid = x.body.oid;
  assert.equal(x.body.oldOid, null);
  assert.match(gitBuf(bare, ['cat-file', 'commit', fromOid]).toString(), new RegExp(`parent ${c0}\\n`));
  const mainAt = git(bare, ['rev-parse', 'main']).trim();
  x = await post('/v1/merge', { from: c0, author: A });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'up_to_date');
  assert.equal(git(bare, ['rev-parse', 'main']).trim(), mainAt);
  x = await post('/v1/branch', { ref: 'sq', from: c0 });
  assert.equal(x.status, 201, JSON.stringify(x.body));
  x = await post('/v1/edit', { ref: 'sq', message: 'sq one', author: A, changes: [{ op: 'create', path: 'sq.txt', content: 'one\n' }] });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  x = await post('/v1/edit', { ref: 'sq', message: 'sq two', author: A, changes: [{ op: 'edit', path: 'sq.txt', find: 'one', replace: 'two' }] });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  x = await post('/v1/rebase', {
    ref: 'sq', onto: mainAt, squash: true, message: 'squashed\n',
    committer: { name: 'c', email: 'c@x', tz: '-0800', time: 1700000600 },
    author: { name: 'a', email: 'a@x', tz: '+0530', time: 1700000700 },
  });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'squash');
  assert.equal(git(bare, ['rev-parse', 'sq^']).trim(), mainAt);
  assert.equal(gitBuf(bare, ['show', 'sq:sq.txt']).toString(), 'two\n');
  const squashed = gitBuf(bare, ['cat-file', 'commit', x.body.oid]).toString();
  assert.match(squashed, /author a <a@x> 1700000700 \+0530\n/);
  assert.match(squashed, /committer c <c@x> 1700000600 -0800\n/);
  assert.match(squashed, /\nsquashed\n$/);
  x = await post('/v1/cherry-pick', { commit: ZERO, committer: A });
  assert.equal(x.status, 400, JSON.stringify(x.body));
  x = await post('/v1/tag', { name: 'v1', target: c0 });
  assert.equal(x.status, 201, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'tag'); assert.equal(x.body.oid, c0);
  assert.equal(git(bare, ['rev-parse', 'refs/tags/v1']).trim(), c0);
  x = await post('/v1/tag', { name: 'v2', target: c1, annotated: true, message: 'version two\n', tagger: author });
  assert.equal(x.status, 201, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'tag'); assert.equal(x.body.commit, c1);
  assert.equal(git(bare, ['cat-file', '-t', x.body.oid]).trim(), 'tag');
  assert.equal(git(bare, ['rev-parse', 'v2^{}']).trim(), c1);
  x = await post('/v1/tag', { name: 'v1', target: c0 });
  assert.equal(x.status, 409); assert.equal(x.body.code, 'ref_exists'); assert.equal(x.body.retry, 'no'); assert.equal(x.body.oid, c0);
  x = await post('/v1/branch', { ref: 'tmp', from: c0 });
  assert.equal(x.status, 201); assert.equal(x.body.oid, c0);
  x = await post('/v1/branch', { ref: 'tmp', from: c0 });
  assert.equal(x.status, 409); assert.equal(x.body.code, 'ref_exists'); assert.equal(x.body.retry, 'no'); assert.equal(x.body.oid, c0);
  x = await post('/v1/branch', { ref: 'tmp', oid: c1 }, 'DELETE');
  assert.equal(x.status, 409); assert.equal(x.body.code, 'stale_expected'); assert.equal(x.body.retry, 'fresh'); assert.equal(x.body.expected, c1); assert.equal(x.body.actual, c0); assert.equal(x.body.oid, c0);
  assert.equal(git(bare, ['rev-parse', 'tmp']).trim(), c0);
  x = await post('/v1/branch', { ref: 'tmp', oid: c0 }, 'DELETE');
  assert.equal(x.status, 200); assert.equal(x.body.outcome, 'deleted'); assert.equal(x.body.deleted, c0);
  assert.throws(() => git(bare, ['rev-parse', '--verify', '-q', 'refs/heads/tmp']));
  x = await post('/v1/tag', { name: 'v1', oid: c1 }, 'DELETE');
  assert.equal(x.status, 409); assert.equal(x.body.code, 'stale_expected'); assert.equal(x.body.actual, c0);
  x = await post('/v1/tag', { name: 'v1', oid: c0 }, 'DELETE');
  assert.equal(x.status, 200); assert.equal(x.body.deleted, c0);
  assert.equal(git(bare, ['fsck', '--strict', '--no-dangling']).trim(), '');
});

test('writes equal git: edit, branch create/delete, merge, rebase, cherry-pick, revert; CAS → 409; conflicts → 409/422', { skip }, async () => {
  const r = repo({ 'f.txt': 'one MARK\n', 'x.txt': 'x1\nx2\nx3\n', 'y.txt': 'y\n' });
  const post = (p, body, method = 'POST') => W(p, { method, body: { remote: r.remote, ...body } }).then(async res => ({ status: res.status, body: await res.json() }));
  // edit (HEAD branch by default), then a stale head → 409 and nothing pushed
  let x = await post('/v1/edit', { path: 'f.txt', find: 'MARK', replace: 'EDIT', author: A, message: 'edit' });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.ref, 'refs/heads/main'); assert.equal(x.body.noop, false);
  const c1 = x.body.newCommit; assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), c1); assert.equal(gitBuf(r.bare, ['show', 'main:f.txt']).toString(), 'one EDIT\n');
  x = await post('/v1/edit', { path: 'f.txt', find: 'EDIT', replace: 'AGAIN', author: A, message: 'stale', head: r.head });
  assert.equal(x.status, 409); assert.equal(x.body.code, 'cas_conflict'); assert.equal(x.body.retry, 'fresh'); assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), c1);
  x = await post('/v1/edit', { path: 'f.txt', find: 'EDIT', replace: 'AGAIN', author: A, message: 'fresh', head: c1 });
  assert.equal(x.status, 200); const c2 = x.body.newCommit;
  x = await post('/v1/edit', { path: 'f.txt', find: 'nothere', replace: 'z', author: A, message: 'm' });
  assert.equal(x.status, 422); assert.equal(x.body.code, 'match_count'); assert.equal(x.body.matches, 0);
  x = await post('/v1/edit', { path: 'f.txt', find: 'AGAIN', replace: 'AGAIN', author: A, message: 'noop' });
  assert.equal(x.status, 200); assert.equal(x.body.noop, true); assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), c2);
  // edit creating a branch from main
  x = await post('/v1/edit', { ref: 'feat', base: 'main', path: 'x.txt', find: 'x2', replace: 'x2 feat', author: A, message: 'feat' });
  assert.equal(x.status, 200); const f1 = x.body.newCommit; assert.equal(git(r.bare, ['rev-parse', 'feat']).trim(), f1);
  // branch create (409 if it exists), delete with CAS (stale → 409), delete current
  x = await post('/v1/branch', { ref: 'tmp', from: 'main' }); assert.equal(x.status, 201); assert.equal(x.body.oid, c2); assert.equal(git(r.bare, ['rev-parse', 'tmp']).trim(), c2);
  x = await post('/v1/branch', { ref: 'tmp', from: 'main' }); assert.equal(x.status, 409); assert.equal(x.body.code, 'ref_exists'); assert.equal(x.body.retry, 'no'); assert.equal(x.body.oid, c2);
  x = await post('/v1/branch', { ref: 'tmp', oid: r.head }, 'DELETE'); assert.equal(x.status, 409); assert.equal(x.body.code, 'stale_expected'); assert.equal(x.body.retry, 'fresh'); assert.equal(x.body.expected, r.head); assert.equal(x.body.actual, c2); assert.equal(x.body.oid, c2);
  x = await post('/v1/branch', { ref: 'tmp', oid: c2 }, 'DELETE'); assert.equal(x.status, 200); assert.equal(x.body.deleted, c2);
  assert.throws(() => git(r.bare, ['rev-parse', '--verify', '-q', 'refs/heads/tmp']));
  x = await post('/v1/branch', { ref: 'tmp' }, 'DELETE'); assert.equal(x.status, 404);
  // main moves on y.txt; merge feat → a merge commit whose tree is git merge-tree's
  x = await post('/v1/edit', { path: 'y.txt', find: 'y', replace: 'y main', author: A, message: 'main y' }); const m1 = x.body.newCommit;
  x = await post('/v1/merge', { from: 'feat', author: A, message: 'merge feat' });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'merge');
  assert.equal(x.body.tree, git(r.bare, ['merge-tree', '--write-tree', m1, f1]).trim().split('\n')[0]);
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), x.body.oid); const mg = x.body.oid;
  // feat2 from the pre-merge main, rebased onto main
  x = await post('/v1/edit', { ref: 'feat2', base: 'main', path: 'f.txt', find: 'AGAIN', replace: 'AGAIN2', author: A, message: 'feat2' });
  const f2 = x.body.newCommit;
  x = await post('/v1/edit', { path: 'y.txt', find: 'y main', replace: 'y main2', author: A, message: 'main moves' }); const m2 = x.body.newCommit;
  x = await post('/v1/rebase', { ref: 'feat2', committer: A });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'rebase'); assert.equal(x.body.commits, 1);
  assert.equal(git(r.bare, ['rev-parse', 'feat2^{tree}']).trim(), git(r.bare, ['merge-tree', '--write-tree', `--merge-base=${mg}`, m2, f2]).trim().split('\n')[0]);
  assert.equal(git(r.bare, ['rev-parse', 'feat2^']).trim(), m2);
  // cherry-pick the rebased commit onto main, then revert it
  const picked = git(r.bare, ['rev-parse', 'feat2']).trim();
  x = await post('/v1/cherry-pick', { commit: picked, committer: A }); assert.equal(x.status, 200, JSON.stringify(x.body));
  assert.equal(x.body.tree, git(r.bare, ['rev-parse', 'feat2^{tree}']).trim());
  x = await post('/v1/revert', { commit: x.body.oid, committer: A }); assert.equal(x.status, 200);
  assert.equal(x.body.tree, git(r.bare, ['rev-parse', `${m2}^{tree}`]).trim());
  // a content conflict → 409 merge_conflict with the paths
  await post('/v1/edit', { ref: 'c1', base: 'main', path: 'x.txt', find: 'x1', replace: 'x1 left', author: A, message: 'l' });
  await post('/v1/edit', { path: 'x.txt', find: 'x1', replace: 'x1 right', author: A, message: 'r' });
  x = await post('/v1/merge', { from: 'c1', author: A }); assert.equal(x.status, 409); assert.equal(x.body.code, 'merge_conflict'); assert.deepEqual(x.body.conflicts, ['x.txt']);
  // bad input
  x = await post('/v1/edit', { path: 'f.txt', find: 'a', replace: 'b', message: 'no author' }); assert.equal(x.status, 400);
  x = await post('/v1/cherry-pick', { commit: 'nothex', committer: A }); assert.equal(x.status, 400);
  const raw = await W('/v1/edit', { method: 'POST', body: void 0, headers: { 'content-type': 'application/json' } }); assert.equal(raw.status, 400);
  // an oversized declared body is refused from its Content-Length, before it is read
  const huge = await new Promise((ok, no) => { const q = http.request({ host: '127.0.0.1', port: PORT, path: '/v1/edit', method: 'POST', headers: { authorization: `Bearer ${PLY}`, 'content-length': String((1 << 20) + 10) } }, res => { res.resume(); ok(res.statusCode); }); q.on('error', no); q.write('{'); });
  assert.equal(huge, 413);
  assert.equal(git(r.bare, ['fsck', '--strict', '--no-dangling']).trim(), '');
});

test('writes switch: WRITES=off → 501 on every write endpoint, reads still served', { skip }, async () => {
  const r = repo({ 'f.txt': 'MARK\n' });
  for (const [m, p] of [['POST', '/v1/edit'], ['POST', '/v1/branch'], ['DELETE', '/v1/branch'], ['POST', '/v1/merge'], ['POST', '/v1/rebase'], ['POST', '/v1/cherry-pick'], ['POST', '/v1/revert'], ['POST', '/v1/tag'], ['DELETE', '/v1/tag']]) {
    const res = await W(p, { method: m, port: PORT_RO, body: { remote: r.remote, path: 'f.txt', find: 'MARK', replace: 'X', author: A, message: 'm' } });
    assert.equal(res.status, 501, `${m} ${p}`); assert.equal((await res.json()).code, 'unsupported');
  }
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), r.head);
  const rd = await W(`/v1/read?${qs({ remote: r.remote, path: 'f.txt' })}`, { port: PORT_RO }); assert.equal(await rd.text(), 'MARK\n');
});

test('git credentials: Git-Authorization verbatim, Git-Token mapped; upstream 401/403 mirrored; never in responses, traces, errors or logs', { skip }, async () => {
  const r = repo({ 'f.txt': 'secret MARK\n' }, () => authSrv.url);
  const ok = await W(`/v1/read?${qs({ remote: r.remote, path: 'f.txt' })}`, { headers: { 'git-authorization': EXPECT } });
  assert.equal(ok.status, 200); assert.equal(await ok.text(), 'secret MARK\n');
  const tok = await W(`/v1/tree?${qs({ remote: r.remote, trace: '1' })}`, { headers: { 'git-token': SECRET } }); // non-GitHub host → Bearer
  assert.equal(tok.status, 200); const tokBody = await tok.text();
  const none = await W(`/v1/refs?${qs({ remote: r.remote })}`); const noneB = await none.json();
  assert.equal(none.status, 401); assert.equal(noneB.code, 'auth'); assert.equal(noneB.upstreamStatus, 401);
  const wrong = await W(`/v1/refs?${qs({ remote: r.remote, trace: '1' })}`, { headers: { 'git-authorization': `Bearer ${SECRET}x` } });
  assert.equal(wrong.status, 403); const wrongB = await wrong.text();
  const both = await W(`/v1/refs?${qs({ remote: r.remote })}`, { headers: { 'git-authorization': EXPECT, 'git-token': SECRET } }); assert.equal(both.status, 400);
  const e = await W('/v1/edit?trace=1', { method: 'POST', headers: { 'git-authorization': EXPECT }, body: { remote: r.remote, path: 'f.txt', find: 'MARK', replace: 'EDIT', author: A, message: 'm' } });
  assert.equal(e.status, 200); const eB = await e.text();
  assert.equal(gitBuf(r.bare, ['show', 'main:f.txt']).toString(), 'secret EDIT\n');
  // a hostile upstream echoing the credential in its error body, under every credential form
  const echoes = [];
  for (const headers of [{ 'git-authorization': EXPECT }, { 'git-token': SECRET }, { 'git-authorization': `Basic ${btoa(`oauth2:${SECRET}`)}` }]) {
    const res = await W(`/v1/read?${qs({ remote: `${echoSrv.url}/x.git`, path: 'f', trace: '1' })}`, { headers });
    const b = await res.text(); echoes.push(b);
    assert.equal(res.status, 502, b); assert.match(b, /upstream_5xx/); assert.match(b, /\[redacted\]/);
  }
  await new Promise(r => setTimeout(r, 300)); // let workerd flush its log lines
  const forms = [SECRET, btoa(`x-access-token:${SECRET}`), btoa(`oauth2:${SECRET}`), SECRET.slice(0, 16)];
  const haystack = { tokBody, wrongB, eB, echoes: echoes.join('\n'), logs };
  for (const [where, text] of Object.entries(haystack)) for (const f of forms) assert.ok(!text.includes(f), `credential form ${f.slice(0, 6)}… found in ${where}`);
  assert.match(logs, /"msg":"ply.request"/, 'the structured request log lines were captured (the grep is not vacuous)');
  assert.ok(!logs.includes(PLY), 'the PLY token is not logged');
});

// ply (since #26) refuses every 3xx with a typed `http` error. The README promises /v1 follows redirects manually, at most
// three hops, same origin only: createGuardedFetch (src/remote.ts) does that before ply sees a response. Under workerd, end
// to end, with the credential attached: reads and a push through a moved path equal git; another origin and a loop are 400.
test('redirects: same-origin hops followed by the Worker (reads and a push), cross-origin and loops refused before ply', { skip }, async () => {
  const r = repo({ 'f.txt': 'one MARK\n' });
  const moved = `${redirSrv.url}/moved/${r.name}.git`;
  const token = 'redirtoken_' + 'Z9'.repeat(10);
  const H = { 'git-token': token };
  redirSrv.hits.length = 0;
  let res = await W(`/v1/refs?${qs({ remote: moved })}`, { headers: H });
  let body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body)); assert.equal(body.refs['refs/heads/main'], r.head);
  assert.deepEqual(redirSrv.hits.map(h => [h.method, h.path.split('?')[0]]), [['POST', `/moved/${r.name}.git/git-upload-pack`], ['POST', `/${r.name}.git/git-upload-pack`]]);
  assert.ok(redirSrv.hits.every(h => h.auth), 'the same-origin hop keeps the credential');
  res = await W(`/v1/read?${qs({ remote: moved, path: 'f.txt' })}`, { headers: H });
  assert.equal(res.status, 200); assert.equal(await res.text(), 'one MARK\n');
  res = await W('/v1/edit', { method: 'POST', headers: H, body: { remote: moved, path: 'f.txt', find: 'MARK', replace: 'MOVED', author: A, message: 'via redirect' } });
  body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body)); assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), body.newCommit);
  assert.equal(gitBuf(r.bare, ['show', 'main:f.txt']).toString(), 'one MOVED\n');
  assert.ok(redirSrv.hits.some(h => h.method === 'POST' && h.path === `/${r.name}.git/git-receive-pack`), 'the push followed the redirect');

  for (const [kind, msg, dials] of [['away', /redirect host is not an allowlisted host/, 1], ['loop', /too many redirects/, 4]]) {
    redirSrv.hits.length = 0;
    res = await W(`/v1/refs?${qs({ remote: `${redirSrv.url}/${kind}/${r.name}.git`, trace: '1' })}`, { headers: H });
    body = await res.json();
    assert.equal(res.status, 400, `${kind}: ${JSON.stringify(body)}`); assert.equal(body.code, 'bad_request'); assert.match(body.message, msg);
    assert.equal(redirSrv.hits.length, dials, `${kind}: hops dialled`);
    assert.equal(JSON.stringify(body).includes(token), false);
  }
  assert.equal(logs.includes(token), false);
});

const RAY_ENTRY = /^([a-z-]+)=([0-9a-f]{16}-[A-Z]{3}|-|no-response);dur=(\d+)$/;
const RAY_SPAN = {
  'git.upload-pack ls-refs': 'ls-refs',
  'git.upload-pack discover': 'ls-refs',
  'git.upload-pack fetch': 'fetch',
  'git.receive-pack': 'receive-pack',
  'git.receive-pack advertise': 'receive-pack',
};

function phaseOfHit(hit) {
  const path = hit.path.split('?')[0];
  if (path.endsWith('/info/refs')) {
    const service = new URL(hit.path, 'http://ray.invalid').searchParams.get('service');
    if (service === 'git-upload-pack') return 'ls-refs';
    if (service === 'git-receive-pack') return 'receive-pack';
    return null;
  }
  if (hit.method === 'POST' && path.endsWith('/git-receive-pack')) return 'receive-pack';
  if (hit.method === 'POST' && path.endsWith('/git-upload-pack')) {
    if (hit.head.includes('command=ls-refs')) return 'ls-refs';
    if (hit.head.includes('command=fetch')) return 'fetch';
  }
  return null;
}

function parseRayHeader(header) {
  assert.ok(header, 'x-artifacts-ray');
  const entries = [];
  let overflow = null;
  for (const part of header.split(', ')) {
    const over = /^overflow=(\d+)$/.exec(part);
    if (over) { overflow = Number(over[1]); continue; }
    const m = RAY_ENTRY.exec(part);
    assert.ok(m, part);
    entries.push({ phase: m[1], ray: m[2], dur: Number(m[3]) });
  }
  return { entries, overflow };
}

function assertRaysMatch(header, hits, timing) {
  const parsed = parseRayHeader(header);
  const want = hits.flatMap(hit => {
    const phase = phaseOfHit(hit);
    return phase ? [{ phase, ray: hit.ray }] : [];
  });
  assert.deepEqual(parsed.entries.map(e => ({ phase: e.phase, ray: e.ray })), want, header);
  assert.equal(parsed.overflow, null);
  assert.equal(header.includes('/'), false, header);
  const st = fill(timing, '');
  for (const phase of new Set(parsed.entries.map(e => e.phase))) assert.match(st, new RegExp(`${phase};dur=\\d+`));
  assert.match(st, /total;dur=\d+/);
  return parsed;
}

function assertSpanRays(trace, entries) {
  const spans = trace.filter(s => RAY_SPAN[s.name]);
  assert.deepEqual(spans.map(s => RAY_SPAN[s.name]), entries.map(e => e.phase), JSON.stringify(spans.map(s => s.name)));
  spans.forEach((s, i) => {
    assert.equal(s.attrs['git.upstream.phase'], entries[i].phase);
    assert.equal(s.attrs['git.upstream.cf_ray'], entries[i].ray);
    assert.equal(s.attrs['git.upstream.dur_ms'], entries[i].dur);
  });
}

test('x-artifacts-ray: a read, an empty-repo first commit, a delta push, and a CAS 409', { skip }, async () => {
  const r = repo({ 'README.md': 'one\n' }, () => raySrv.url);
  const noauth = await W(`/v1/read?${qs({ remote: r.remote, path: 'README.md' })}`, { auth: false });
  assert.equal(noauth.status, 401);
  assert.equal(noauth.headers.get('x-artifacts-ray'), null);
  await noauth.arrayBuffer();

  const fromRead = raySrv.seen.length;
  const read = await W(`/v1/read?${qs({ remote: r.remote, path: 'README.md' })}`);
  assert.equal(read.status, 200);
  assert.equal(Buffer.from(await read.arrayBuffer()).toString(), 'one\n');
  const readRays = assertRaysMatch(read.headers.get('x-artifacts-ray'), raySrv.seen.slice(fromRead), read.headers.get('server-timing'));
  assert.ok(readRays.entries.some(e => e.phase === 'ls-refs'));
  assert.ok(readRays.entries.some(e => e.phase === 'fetch'));

  const fromTree = raySrv.seen.length;
  const treeRes = await W(`/v1/tree?${qs({ remote: r.remote, trace: '1' })}`);
  const tree = await treeRes.json();
  assert.equal(treeRes.status, 200, JSON.stringify(tree));
  const treeRays = assertRaysMatch(treeRes.headers.get('x-artifacts-ray'), raySrv.seen.slice(fromTree), treeRes.headers.get('server-timing'));
  assertSpanRays(tree.trace, treeRays.entries);

  const fromMiss = raySrv.seen.length;
  const miss = await W(`/v1/read?${qs({ remote: r.remote, path: 'nope' })}`);
  const missBody = await miss.json();
  assert.equal(miss.status, 404);
  assert.equal(missBody.code, 'not_found');
  const missRays = assertRaysMatch(miss.headers.get('x-artifacts-ray'), raySrv.seen.slice(fromMiss), miss.headers.get('server-timing'));
  assert.ok(missRays.entries.some(e => e.phase === 'ls-refs' || e.phase === 'fetch'));

  const name = `ray${n++}`;
  const bare = makeBareRepo(root, name);
  const remote = `${raySrv.url}/${name}.git`;
  const author = { name: 'w', email: 'w@x', tz: '+0000', time: 1700000000 };
  const post = async body => {
    const from = raySrv.seen.length;
    const res = await W('/v1/edit?trace=1', { method: 'POST', body: { remote, ...body } });
    const json = await res.json();
    return { res, json, hits: raySrv.seen.slice(from) };
  };

  const first = await post({ message: 'init', author, changes: [{ op: 'create', path: 'a.txt', content: 'v1\n' }] });
  assert.equal(first.res.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.outcome, 'commit');
  assert.equal(first.json.oldOid, null);
  assert.equal(gitBuf(bare, ['cat-file', 'commit', first.json.oid]).toString().split('\n').some(l => l.startsWith('parent ')), false);
  const firstRays = assertRaysMatch(first.res.headers.get('x-artifacts-ray'), first.hits, first.res.headers.get('server-timing'));
  assert.ok(firstRays.entries.some(e => e.phase === 'receive-pack'));
  assertSpanRays(first.json.trace, firstRays.entries);

  const delta = await post({ message: 'second', author, changes: [{ op: 'edit', path: 'a.txt', find: 'v1', replace: 'v2' }] });
  assert.equal(delta.res.status, 200, JSON.stringify(delta.json));
  assert.match(gitBuf(bare, ['cat-file', 'commit', delta.json.oid]).toString(), new RegExp(`parent ${first.json.oid}\\n`));
  const deltaRays = assertRaysMatch(delta.res.headers.get('x-artifacts-ray'), delta.hits, delta.res.headers.get('server-timing'));
  assert.ok(deltaRays.entries.some(e => e.phase === 'receive-pack'));
  assertSpanRays(delta.json.trace, deltaRays.entries);

  raySrv.setBeforeReceive(() => {
    const parent = git(bare, ['rev-parse', 'HEAD']).trim();
    const tree = git(bare, ['rev-parse', 'HEAD^{tree}']).trim();
    const neu = git(bare, ['commit-tree', tree, '-p', parent, '-m', 'raced'], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x' },
    }).trim();
    git(bare, ['update-ref', 'refs/heads/main', neu, parent]);
  });
  try {
    const cas = await post({ message: 'conflict', author, changes: [{ op: 'edit', path: 'a.txt', find: 'v2', replace: 'v3' }] });
    assert.equal(cas.res.status, 409, JSON.stringify({ code: cas.json.code, message: cas.json.message, hooks: cas.hits.filter(h => h.path.includes('receive-pack')).map(h => ({ path: h.path, method: h.method, hook: h.hook, ray: h.ray })) }));
    assert.ok(cas.json.code === 'cas_conflict' || cas.json.code === 'not_fast_forward', cas.json.code);
    const casRays = assertRaysMatch(cas.res.headers.get('x-artifacts-ray'), cas.hits, cas.res.headers.get('server-timing'));
    const pushed = casRays.entries.filter(e => e.phase === 'receive-pack');
    assert.ok(pushed.length >= 1, cas.res.headers.get('x-artifacts-ray'));
    assert.notEqual(pushed.at(-1).ray, '-');
    assert.notEqual(pushed.at(-1).ray, 'no-response');
    assertSpanRays(cas.json.trace, casRays.entries);
    assert.equal(gitBuf(bare, ['show', 'main:a.txt']).toString(), 'v2\n');
  } finally {
    raySrv.setBeforeReceive(null);
  }
});
