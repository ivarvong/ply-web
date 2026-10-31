// The public namespace end to end: the cf-built Worker under workerd, its outbound fetches routed to a local router that
// plays the account's Artifacts host (the real PUBLIC_GIT_HOST constant, no override hook) in front of git http-backend,
// and an RPC service standing in for the Artifacts binding. The router records every request that leaves the Worker,
// so each test can say exactly which requests carried the Worker's read token and which did not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyCfBundle } from './cf-bundle.js';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';

const WORKERD = [process.env.WORKERD, fileURLToPath(new URL('../node_modules/.bin/workerd', import.meta.url))].filter(Boolean).find(p => existsSync(p));
const skip = !WORKERD && 'workerd not installed';
const HOST = '5ad2236b39de4c8bd8f6270ea63f3ea9.artifacts.cloudflare.net';
const NS = 'public-v0';
const ORIGIN = `https://${HOST}`;
const PORT = 19200 + (process.pid % 40), PORT_TIGHT = PORT + 40, PORT_FAKE = PORT + 80;
const PLY = 'test-ply-token-' + 'p'.repeat(20);
// What the fake binding mints, and what the router demands for /git/public-v0/*. Never sent by any test client.
const TOKEN = `art_v1_${'5eed'.repeat(10)}?expires=4102444800`;
const TOKEN_FORMS = [TOKEN, TOKEN.split('?')[0], Buffer.from(`x-access-token:${TOKEN}`).toString('base64'), encodeURIComponent(TOKEN), '5eed'.repeat(10)];
// A caller's own credential for another namespace.
const OTHER = `art_v1_${'0the'.repeat(10)}`;
const KNOWN = ['ply', 'moved', 'away', 'hop', 'echo', 'wide'];

let root, cleanup, srv, router, proc, logs = '';
let plyRepo, otherRepo;
const hits = [];
const seen = []; // every response status line, header and body a test client received

function startRouter(upstream) {
  const up = new URL(upstream);
  const s = http.createServer((req, res) => {
    const host = String(req.headers.host ?? '');
    const auth = req.headers.authorization ?? null;
    hits.push({ host, method: req.method, path: req.url, auth, via: req.headers['x-ply-via'] ?? null });
    if (host !== HOST) { req.resume(); res.writeHead(404); return void res.end('no such host'); }
    const m = /^\/git\/public-v0\/(moved|away|hop|echo)\.git(\/.*)$/.exec(req.url);
    if (m) {
      req.resume();
      if (m[1] === 'echo') { res.writeHead(500, { 'content-type': 'text/plain' }); return void res.end(`echo ${auth} ${Buffer.from(String(auth).split(' ')[1] ?? '', 'base64').toString()}`); }
      const location = m[1] === 'moved' ? `/git/other/secret.git${m[2]}` : m[1] === 'away' ? `https://github.com/x/y.git${m[2]}` : `/git/${NS}/ply.git${m[2]}`;
      res.writeHead(307, { location }); return void res.end();
    }
    const need = req.url.startsWith(`/git/${NS}/`) ? `Bearer ${TOKEN}` : req.url.startsWith('/git/other/') ? `Bearer ${OTHER}` : null;
    if (!need) { req.resume(); res.writeHead(404); return void res.end('not found'); }
    if (!auth) { req.resume(); res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }); return void res.end('Authentication required'); }
    if (auth !== need) { req.resume(); res.writeHead(403); return void res.end('Forbidden'); }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const filter = /filter ([^\n]+)\n/.exec(body.toString('latin1'))?.[1] ?? null;
      hits.at(-1).filter = filter;
      // Artifacts' answer to every partial-clone filter but blob:none (lab_notebook/ply-artifacts-eval-2026-10-23.md).
      if (filter && filter !== 'blob:none') { res.writeHead(400, { 'content-type': 'text/plain' }); return void res.end('git-upload-pack: Unsupported Git fetch filter; only blob:none is supported.'); }
      const u = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      u.end(body);
    });
  });
  return new Promise(ok => s.listen(0, '127.0.0.1', () => ok({ port: s.address().port, close: () => new Promise(r => { s.closeAllConnections?.(); s.close(r); }) })));
}

const FAKE_ARTIFACTS = `import { WorkerEntrypoint, RpcTarget } from 'cloudflare:workers';
const mints = [];
const KNOWN = ${JSON.stringify(KNOWN)};
class Repo extends RpcTarget {
  constructor(name) { super(); this.name = name; }
  async createToken(scope, ttl) { mints.push({ repo: this.name, scope, ttl }); return { plaintext: ${JSON.stringify(TOKEN)}, expiresAt: '2100-01-01T00:00:00.000Z' }; }
}
export class Ns extends WorkerEntrypoint {
  async get(name) { if (!KNOWN.includes(name)) throw new Error('repo not found: ' + name); return new Repo(name); }
  async list() { return { repos: KNOWN.map(name => ({ name, status: 'ready' })) }; }
}
export default { async fetch() { return Response.json(mints); } };
`;

before(async () => {
  if (!WORKERD) return;
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  router = await startRouter(srv.url);
  mkdirSync(join(root, 'git', NS), { recursive: true });
  mkdirSync(join(root, 'git', 'other'), { recursive: true });
  const seed = (name, files) => {
    const bare = makeBareRepo(root, name);
    const work = join(root, `w-${name.replace(/\//g, '-')}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    return { bare, work, head: commitFiles(work, bare, files, `seed ${name}`) };
  };
  plyRepo = seed(`git/${NS}/ply`, { 'README.md': '# ply\n\npublic mirror\n', 'src/a.js': 'export const a = 1;\n' });
  otherRepo = seed('git/other/secret', { 'SECRET.md': 'other namespace\n' });
  // curl's shape: one directory over the viewer's old 2,000-entry cap, next to a small one three levels down.
  const wideFiles = { 'README.md': 'wide\n', 'docs/lib/opts/A.md': 'a\n', 'docs/lib/opts/B.md': 'b\n' };
  for (let k = 0; k < 2135; k++) wideFiles[`tests/data/test${k}`] = `t${k}\n`;
  seed(`git/${NS}/wide`, wideFiles);
  const out = join(root, 'wk'); mkdirSync(out, { recursive: true });
  copyCfBundle(join(out, 'worker.mjs'));
  writeFileSync(join(out, 'fake-artifacts.mjs'), FAKE_ARTIFACTS);
  const worker = (key, rate) => `(modules = [ (name = "worker.mjs", esModule = embed "worker.mjs") ], compatibilityDate = "2026-10-18", globalOutbound = "router",
    durableObjectNamespaces = [ (className = "ViewerRateLimit", uniqueKey = "${key}", enableSql = true) ], durableObjectStorage = (inMemory = void),
    bindings = [ (name = "PLY_TOKEN", text = "${PLY}"), (name = "WRITES", text = "on"), (name = "PACK_CACHE", text = "on"), (name = "VIEWER_RATE_PER_MIN", text = "${rate}"),
      (name = "VIEWER_RATE", durableObjectNamespace = "ViewerRateLimit"), (name = "PUBLIC_REPOS", service = (name = "artifacts", entrypoint = "Ns")) ])`;
  writeFileSync(join(out, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = ${worker('public-main', 1000)}), (name = "tight", worker = ${worker('public-tight', 3)}),
    (name = "artifacts", worker = (modules = [ (name = "fake-artifacts.mjs", esModule = embed "fake-artifacts.mjs") ], compatibilityDate = "2026-10-18")),
    (name = "router", external = (address = "127.0.0.1:${router.port}", http = ())) ],
  sockets = [ (name = "http", address = "127.0.0.1:${PORT}", http = (), service = "main"), (name = "tight", address = "127.0.0.1:${PORT_TIGHT}", http = (), service = "tight"),
    (name = "fake", address = "127.0.0.1:${PORT_FAKE}", http = (), service = "artifacts") ],
);
`);
  proc = spawn(WORKERD, ['serve', join(out, 'config.capnp'), '--verbose'], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => { logs += d; }); proc.stderr.on('data', d => { logs += d; });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
});
// Each step on its own: a before() that failed half way must still release every server, or node --test never exits.
after(async () => {
  if (!WORKERD) return;
  try { proc?.kill('SIGKILL'); } catch { /* not started */ }
  await Promise.allSettled([srv?.close(), router?.close()]);
  try { cleanup?.(); } catch { /* nothing to remove */ }
});

async function W(path, { method = 'GET', body, headers = {}, port = PORT, ip = '198.51.100.1' } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: 'manual', headers: { 'cf-connecting-ip': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  seen.push(`${res.status} ${path}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${buf.toString('latin1')}`);
  return { status: res.status, headers: res.headers, buf, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) };
}
const bearer = { authorization: `Bearer ${PLY}` };
const remote = name => `${ORIGIN}/git/${NS}/${name}.git`;
const q = o => new URLSearchParams(o).toString();
const mark = () => hits.length;
const since = i => hits.slice(i);
const publicView = (name, query = '') => `/view/${HOST}/git/${NS}/${name}.git${query}`;

test('viewer: public-v0/ply renders (tree, file, raw) with no token; every upstream call is upload-pack and carries the read token', { skip }, async () => {
  const i = mark();
  const tree = await W(publicView('ply'));
  assert.equal(tree.status, 200, tree.text.slice(0, 600));
  assert.match(tree.text, /README\.md/);
  assert.match(tree.text, /public mirror/);
  assert.match(tree.text, /upload-pack/, 'the page shows its git round trips');
  const file = await W(publicView('ply', '?ref=main&path=README.md'));
  assert.equal(file.status, 200);
  assert.match(file.text, /public mirror/);
  const raw = await W(publicView('ply', '?path=README.md&raw=1'));
  assert.equal(raw.status, 200);
  assert.deepEqual(raw.buf, gitBuf(plyRepo.bare, ['show', 'main:README.md']));
  const calls = since(i);
  assert.ok(calls.length >= 3);
  for (const h of calls) {
    assert.equal(h.host, HOST);
    assert.ok(h.path.startsWith(`/git/${NS}/ply.git/`), h.path);
    assert.ok((h.method === 'GET' && h.path.endsWith('/info/refs?service=git-upload-pack')) || (h.method === 'POST' && h.path.endsWith('/git-upload-pack')), `${h.method} ${h.path}`);
    assert.equal(h.auth, `Bearer ${TOKEN}`);
  }
});

test('a server that refuses tree:0: the viewer learns it once per isolate, a 2,135-entry sibling tree is no 413, and its own nested links work', { skip }, async () => {
  const i = mark();
  const root = await W(publicView('wide'));
  assert.equal(root.status, 200, root.text.slice(0, 400));
  // the viewer's own link to a directory three levels down: literal slashes, and it renders
  const dirLink = /href="([^"]*path=docs\/lib\/opts[^"]*)"/.exec((await W(publicView('wide', '?path=docs/lib'))).text)?.[1]?.replace(/&amp;/g, '&');
  assert.ok(dirLink, 'nested link present');
  const dir = await W(dirLink);
  assert.equal(dir.status, 200);
  assert.match(dir.text, /A\.md/);
  assert.equal((await W(publicView('wide', '?path=docs%2Flib%2Fopts'))).status, 200, 'an encoded slash in path is accepted');
  // the cap still applies to the tree that is shown: the 2,135-entry directory itself is over the viewer's 2,000
  assert.equal((await W(publicView('wide', '?path=tests/data'))).status, 413);
  assert.equal((await W(publicView('wide', '?path=docs%2F%2E%2E%2Fsecret'))).status, 400, 'an encoded dot is not');
  const refused = since(i).filter(h => h.filter === 'tree:0');
  assert.ok(refused.length <= 1, `tree:0 was refused ${refused.length} times; the isolate should learn it once`);
  assert.match(dir.text, /learned earlier in this isolate|was rejected/);
});

test('Workers Cache routing: anonymous public reads reach upstream through GitCache; a credentialed read never does', { skip }, async () => {
  let i = mark();
  assert.equal((await W(`/v1/read?${q({ remote: remote('ply'), path: 'README.md' })}`)).status, 200);
  assert.equal((await W(publicView('ply', '?path=README.md'))).status, 200);
  const anon = since(i).filter(h => h.path.startsWith(`/git/${NS}/ply.git/`));
  assert.ok(anon.length > 0);
  for (const h of anon) assert.equal(h.via, 'gitcache', `${h.method} ${h.path}`);
  // the caller's credential (for public-v0 itself, and for another namespace): straight upstream, never through the cache
  i = mark();
  await W(`/v1/read?${q({ remote: remote('ply'), path: 'README.md' })}`, { headers: { ...bearer, 'git-token': OTHER } });
  await W(`/v1/read?${q({ remote: `${ORIGIN}/git/other/secret.git`, path: 'SECRET.md' })}`, { headers: { ...bearer, 'git-token': OTHER } });
  const cred = since(i);
  assert.ok(cred.length > 0);
  for (const h of cred) { assert.equal(h.via, null, `${h.method} ${h.path}`); assert.equal(h.auth, `Bearer ${OTHER}`); }
  // with a bearer but no git credential, a public-v0 read is anonymous upstream-wise: cached path, Worker token
  i = mark();
  assert.equal((await W(`/v1/refs?${q({ remote: remote('ply') })}`, { headers: bearer })).status, 200);
  for (const h of since(i)) { assert.equal(h.via, 'gitcache'); assert.equal(h.auth, `Bearer ${TOKEN}`); }
});

test('/r/<repo> redirects to the canonical viewer URL; bad names are 404 with no fetch; the home page lists the namespace', { skip }, async () => {
  const i = mark();
  const r = await W('/r/ply');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), publicView('ply'));
  const deep = await W('/r/ply?path=README.md&raw=1&evil=1');
  assert.equal(deep.headers.get('location'), publicView('ply', '?path=README.md&raw=1'));
  for (const bad of ['/r/', '/r/a%2fb', '/r/a/b', '/r/.git', '/r/ply.git', '/r/-x', '/r/a%00b']) assert.equal((await W(bad)).status, 404, bad);
  // `..` and `%2e%2e` are dot segments to the URL parser: the request becomes `/` (usage text), never a redirect
  for (const dots of ['/r/%2e%2e', '/r/%2E%2E/ply']) { const r = await W(dots); assert.equal(r.headers.get('location'), null, dots); assert.notEqual(r.status, 302, dots); }
  assert.equal((await W('/r/ply', { method: 'POST' })).status, 405);
  assert.equal(since(i).length, 0, 'a redirect fetches nothing');
  const home = await W('/view');
  assert.equal(home.status, 200);
  assert.match(home.text, /Public repositories/);
  assert.match(home.text, /href="\/r\/ply"/);
});

test('viewer refuses other namespaces, nested paths, traversal and encoded variants on the Artifacts host before any fetch', { skip }, async () => {
  const i = mark();
  const bad = [
    `/view/${HOST}/git/other/secret.git`,
    `/view/${HOST}/git/default/ply.git`,
    `/view/${HOST}/git/${NS}x/ply.git`,
    `/view/${HOST}/git/${NS}/a/ply.git`,
    `/view/${HOST}/git/${NS}/../other/secret.git`,
    `/view/${HOST}/git/${NS}/%2e%2e/other/secret.git`,
    `/view/${HOST}/git/${NS}/%2E%2E%2Fother%2Fsecret.git`,
    `/view/${HOST}/git/${NS}%2f..%2fother/secret.git`,
    `/view/${HOST}/git/${NS}/ply.git%2f..%2f..%2fother%2fsecret.git`,
    `/view/${HOST}/git/${NS}/..%252fother/secret.git`,
    `/view/${HOST}./git/${NS}/ply.git`,
    `/view/x@${HOST}/git/${NS}/ply.git`,
    `/view?remote=${encodeURIComponent(`${ORIGIN}/git/other/secret.git`)}`,
    `/view?remote=${encodeURIComponent(`${ORIGIN}/git/${NS}/../other/secret.git`)}`,
  ];
  for (const path of bad) {
    const r = await W(path);
    assert.equal(r.status, 400, `${path} → ${r.status}`);
  }
  assert.deepEqual(since(i), [], 'nothing was fetched');
  // the paste form accepts the public URL and redirects to the canonical path
  const pasted = await W(`/view?remote=${encodeURIComponent(remote('ply'))}`);
  assert.equal(pasted.status, 302);
  assert.equal(pasted.headers.get('location'), publicView('ply'));
});

test('viewer: a redirect out of the repo (another namespace, another host) is not followed, so no token goes there', { skip }, async () => {
  for (const name of ['moved', 'away']) {
    const i = mark();
    const r = await W(publicView(name));
    assert.ok(r.status >= 400, `${name} → ${r.status}`);
    const calls = since(i);
    assert.equal(calls.some(h => h.host !== HOST || !h.path.startsWith(`/git/${NS}/${name}.git/`)), false, JSON.stringify(calls));
  }
});

test('/v1 reads of public-v0 need no bearer and equal git: refs, discover, tree, read, commit', { skip }, async () => {
  const i = mark();
  const refs = await W(`/v1/refs?${q({ remote: remote('ply') })}`);
  assert.equal(refs.status, 200, refs.text);
  assert.equal(refs.json().refs['refs/heads/main'], git(plyRepo.bare, ['rev-parse', 'main']).trim());
  assert.equal(refs.json().head, 'refs/heads/main');
  const disc = await W(`/v1/discover?${q({ remote: remote('ply') })}`);
  assert.equal(disc.status, 200);
  assert.equal(disc.json().version, 2);
  const tree = await W(`/v1/tree?${q({ remote: remote('ply'), path: 'src' })}`);
  assert.equal(tree.status, 200);
  assert.deepEqual(tree.json().entries.map(e => e.name), ['a.js']);
  const read = await W(`/v1/read?${q({ remote: remote('ply'), path: 'README.md', trace: '1' })}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.buf, gitBuf(plyRepo.bare, ['show', 'main:README.md']));
  assert.ok(read.headers.get('x-ply-trace'));
  const commit = await W(`/v1/commit?${q({ remote: `${ORIGIN}/git/${NS}/ply`, trace: '1' })}`);
  assert.equal(commit.status, 200);
  assert.equal(commit.json().oid, plyRepo.head);
  assert.ok(Array.isArray(commit.json().trace) && commit.json().trace.length > 0);
  const calls = since(i);
  assert.ok(calls.length >= 5);
  for (const h of calls) assert.equal(h.auth, `Bearer ${TOKEN}`, `${h.method} ${h.path}`);
  // a wrong bearer is still a 401: the public path is only for requests with no Authorization at all
  const wrong = await W(`/v1/refs?${q({ remote: remote('ply') })}`, { headers: { authorization: `Bearer ${PLY}x` } });
  assert.equal(wrong.status, 401);
  // a valid bearer works too, and the Worker's token is still the one used
  const j = mark();
  assert.equal((await W(`/v1/refs?${q({ remote: remote('ply') })}`, { headers: bearer })).status, 200);
  assert.ok(since(j).every(h => h.auth === `Bearer ${TOKEN}`));
});

test('/v1 without a bearer: another namespace, another host, traversal, unknown repo, or a caller credential are refused', { skip }, async () => {
  const i = mark();
  for (const r of [`${ORIGIN}/git/other/secret.git`, `${ORIGIN}/git/default/ply.git`, `${ORIGIN}/git/${NS}/a/ply.git`, `${ORIGIN}/git/${NS}/../other/secret.git`, `${ORIGIN}/git/${NS}/%2e%2e/other/secret.git`, `https://github.com/git/${NS}/ply.git`]) {
    const res = await W(`/v1/refs?${q({ remote: r })}`);
    assert.equal(res.status, 401, `${r} → ${res.status}`);
    assert.equal(res.json().code, 'unauthorized');
  }
  for (const [m, p] of [['POST', '/v1/edit'], ['POST', '/v1/branch'], ['DELETE', '/v1/branch'], ['POST', '/v1/merge'], ['POST', '/v1/rebase'], ['POST', '/v1/cherry-pick'], ['POST', '/v1/revert']]) {
    assert.equal((await W(p, { method: m, body: { remote: remote('ply'), ref: 'main', path: 'README.md', find: 'ply', replace: 'x', from: 'main', commit: plyRepo.head, author: { name: 'a', email: 'a@x' }, committer: { name: 'a', email: 'a@x' }, message: 'm' } })).status, 401, `${m} ${p}`);
  }
  assert.deepEqual(since(i), [], 'nothing was fetched');
  const withCred = await W(`/v1/refs?${q({ remote: remote('ply') })}`, { headers: { 'git-token': OTHER } });
  assert.equal(withCred.status, 400);
  assert.deepEqual(since(i), []);
  const missing = await W(`/v1/refs?${q({ remote: remote('nope') })}`);
  assert.equal(missing.status, 404, missing.text);
  assert.equal(missing.json().code, 'not_found');
});

test('/v1 with a bearer: another namespace gets no Worker token; a caller Git-Token is used as given (caller wins), never the Worker token', { skip }, async () => {
  let i = mark();
  const bare = await W(`/v1/refs?${q({ remote: `${ORIGIN}/git/other/secret.git` })}`, { headers: bearer });
  assert.equal(bare.status, 401);
  assert.equal(bare.json().code, 'auth');
  assert.ok(since(i).length > 0);
  assert.ok(since(i).every(h => h.auth === null), JSON.stringify(since(i)));
  i = mark();
  const other = await W(`/v1/read?${q({ remote: `${ORIGIN}/git/other/secret.git`, path: 'SECRET.md' })}`, { headers: { ...bearer, 'git-token': OTHER } });
  assert.equal(other.status, 200, other.text);
  assert.deepEqual(other.buf, gitBuf(otherRepo.bare, ['show', 'main:SECRET.md']));
  assert.ok(since(i).every(h => h.auth === `Bearer ${OTHER}`));
  i = mark();
  // the caller's credential for public-v0 replaces the Worker's: the router demands TOKEN, so this is a 403
  const mine = await W(`/v1/refs?${q({ remote: remote('ply') })}`, { headers: { ...bearer, 'git-token': OTHER } });
  assert.equal(mine.status, 403);
  assert.ok(since(i).length > 0 && since(i).every(h => h.auth === `Bearer ${OTHER}`));
});

test('/v1 redirects: the token is re-decided on every hop (another namespace: none; same namespace: yes; another host: not followed)', { skip }, async () => {
  let i = mark();
  const moved = await W(`/v1/refs?${q({ remote: remote('moved') })}`);
  assert.equal(moved.status, 401, moved.text);
  const movedHits = since(i);
  assert.ok(movedHits.some(h => h.path.startsWith('/git/other/secret.git/')), JSON.stringify(movedHits));
  for (const h of movedHits) assert.equal(h.auth, h.path.startsWith(`/git/${NS}/`) ? `Bearer ${TOKEN}` : null, `${h.method} ${h.path}`);
  i = mark();
  const away = await W(`/v1/refs?${q({ remote: remote('away') })}`);
  assert.equal(away.status, 400);
  assert.equal(since(i).some(h => h.host !== HOST), false, 'a cross-host hop is never dialled');
  i = mark();
  const hop = await W(`/v1/refs?${q({ remote: remote('hop') })}`);
  assert.equal(hop.status, 200, hop.text);
  assert.ok(since(i).some(h => h.path.startsWith(`/git/${NS}/ply.git/`) && h.auth === `Bearer ${TOKEN}`));
});

test('writes to public-v0 are 403 read_only with a bearer, with a caller git credential, and in any case variant; nothing is pushed', { skip }, async () => {
  const before = git(plyRepo.bare, ['for-each-ref']);
  const i = mark();
  const body = { ref: 'main', path: 'README.md', find: 'ply', replace: 'x', from: 'main', commit: plyRepo.head, author: { name: 'a', email: 'a@x' }, committer: { name: 'a', email: 'a@x' }, message: 'm' };
  for (const r of [remote('ply'), `${ORIGIN}/git/${NS}/ply`, `${ORIGIN}/git/${NS.toUpperCase()}/ply.git`, `${ORIGIN}/git/${NS}/new.git`, `${ORIGIN}/git/${NS}/a/b.git`]) {
    for (const [m, p] of [['POST', '/v1/edit'], ['POST', '/v1/branch'], ['DELETE', '/v1/branch'], ['POST', '/v1/merge'], ['POST', '/v1/rebase'], ['POST', '/v1/cherry-pick'], ['POST', '/v1/revert']]) {
      for (const headers of [bearer, { ...bearer, 'git-token': OTHER }, { ...bearer, 'git-authorization': `Bearer ${OTHER}` }]) {
        const res = await W(p, { method: m, body: { ...body, remote: r }, headers });
        assert.equal(res.status, 403, `${m} ${p} ${r}`);
        assert.equal(res.json().code, 'read_only');
      }
    }
  }
  assert.deepEqual(since(i), [], 'no write reached the host');
  assert.equal(git(plyRepo.bare, ['for-each-ref']), before);
  // another namespace is still writable with the caller's own credential (the policy is only for public-v0)
  const ok = await W('/v1/branch', { method: 'POST', body: { remote: `${ORIGIN}/git/other/secret.git`, ref: 'tmp' }, headers: { ...bearer, 'git-token': OTHER } });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(hits.some(h => /receive-pack/.test(h.path) && h.auth === `Bearer ${TOKEN}`), false, 'receive-pack never carries the Worker token');
});

test('rate limit: public /v1 reads and viewer pages share the per-client page bucket', { skip }, async () => {
  const ip = '203.0.113.77';
  assert.equal((await W(`/v1/refs?${q({ remote: remote('ply') })}`, { port: PORT_TIGHT, ip })).status, 200);
  assert.equal((await W(publicView('ply'), { port: PORT_TIGHT, ip })).status, 200);
  assert.equal((await W(`/v1/refs?${q({ remote: remote('ply') })}`, { port: PORT_TIGHT, ip })).status, 200);
  const limited = await W(`/v1/refs?${q({ remote: remote('ply') })}`, { port: PORT_TIGHT, ip });
  assert.equal(limited.status, 429);
  assert.equal(limited.json().code, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await W(publicView('ply'), { port: PORT_TIGHT, ip })).status, 429);
  assert.equal((await W(`/v1/refs?${q({ remote: remote('ply') })}`, { port: PORT_TIGHT, ip: '203.0.113.78' })).status, 200, 'another client is unaffected');
  // a bearer request is not limited
  assert.equal((await W(`/v1/refs?${q({ remote: remote('ply') })}`, { port: PORT_TIGHT, ip, headers: bearer })).status, 200);
});

test('a hostile upstream echoing the token is scrubbed from /v1 errors, viewer pages, and logs', { skip }, async () => {
  const v1 = await W(`/v1/refs?${q({ remote: remote('echo'), trace: '1' })}`);
  assert.ok(v1.status >= 500, v1.text);
  const page = await W(publicView('echo'));
  assert.ok(page.status >= 500);
  assert.ok(hits.some(h => h.path.startsWith(`/git/${NS}/echo.git/`) && h.auth === `Bearer ${TOKEN}`), 'the echo host did receive the token, so there was something to leak');
});

test('the binding: only read tokens are minted, and one per repo per isolate', { skip }, async () => {
  const mints = await (await fetch(`http://127.0.0.1:${PORT_FAKE}/`)).json();
  assert.ok(mints.length > 0);
  for (const m of mints) { assert.equal(m.scope, 'read'); assert.equal(m.ttl, 3600); }
  const perRepo = {};
  for (const m of mints) perRepo[m.repo] = (perRepo[m.repo] ?? 0) + 1;
  // two isolates (main, tight) at most one mint each per repo; the fake's token never expires
  for (const [repo, n] of Object.entries(perRepo)) assert.ok(n <= 2, `${repo} minted ${n} times`);
});

test('leak grep: the Worker token, in every form, is in no response, header, or log line', { skip }, async () => {
  await new Promise(r => setTimeout(r, 300));
  assert.ok(seen.length > 100, `${seen.length} responses checked`);
  for (const form of TOKEN_FORMS) {
    const at = seen.findIndex(s => s.includes(form));
    assert.equal(at, -1, `response leaked ${form.slice(0, 12)}…: ${seen[at]?.slice(0, 300)}`);
    assert.equal(logs.includes(form), false, `logs leaked ${form.slice(0, 12)}…`);
  }
  assert.match(logs, /ply\.request/);
  assert.match(logs, /"public":1/);
});
