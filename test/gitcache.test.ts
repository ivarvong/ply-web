// GitCache (Workers Caching) as pure functions: what is routed to the cache, under which key and policy, that a
// credential always bypasses it, that a key is bound to its request, that a CACHE_VERSION bump misses, and that nothing in
// src/ uses the Cache API or calls the GitCache binding outside src/gitcache.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_VERSION } from '../src/cache-version.ts';
import {
  DISCOVER_V2_CACHE, IMMUTABLE, REFUSAL_CACHE, MAX_ROUTED_BODY, NO_STORE, REFS_CACHE, REFS_MAX_AGE_S, REFS_SWR_S, VIA_HEADER,
  cacheableUpstream, classify, createLoopbackFetch, keyHash, keyPath, serveGitCache, type LoopbackBinding,
} from '../src/gitcache.ts';
import { PUBLIC_GIT_ORIGIN, PUBLIC_NAMESPACE, type TokenSource } from '../src/public.ts';
import { git, makeBareRepo, startGitServer, tmpRoot, commitFiles } from './server.js';
import { mkdirSync } from 'node:fs';

const PUB = `${PUBLIC_GIT_ORIGIN}/git/${PUBLIC_NAMESPACE}/ply.git`;
const GH = 'https://github.com/octocat/Hello-World.git';
const TOKEN = `art_v1_${'c4c4'.repeat(10)}?expires=4102444800`;
const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
const enc = (s: string) => new TextEncoder().encode(s);
const OID = 'a'.repeat(40);
const LSREFS = enc(`${pkt('command=ls-refs\n')}0001${pkt('ref-prefix HEAD\n')}0000`);
const FETCH = enc(`${pkt('command=fetch\n')}0001${pkt(`want ${OID}\n`)}${pkt('filter blob:none\n')}${pkt('deepen 1\n')}${pkt('done\n')}0000`);
const BLOB = enc(`${pkt('command=fetch\n')}0001${pkt(`want ${OID}\n`)}${pkt('done\n')}0000`);
const HAVE = enc(`${pkt('command=fetch\n')}0001${pkt(`want ${OID}\n`)}${pkt(`have ${'b'.repeat(40)}\n`)}${pkt('done\n')}0000`);
const SHALLOW = enc(`${pkt('command=fetch\n')}0001${pkt(`want ${OID}\n`)}${pkt(`shallow ${'b'.repeat(40)}\n`)}0000`);
const SINCE = enc(`${pkt('command=fetch\n')}0001${pkt(`want ${OID}\n`)}${pkt('deepen-since 1700000000\n')}0000`);
const WANTREF = enc(`${pkt('command=fetch\n')}0001${pkt('want-ref refs/heads/main\n')}0000`);

test('classify: wants-only fetch is pack (with or without a filter), ls-refs is refs, info/refs is discover, the rest is not cached', () => {
  assert.equal(classify('POST', `${PUB}/git-upload-pack`, FETCH), 'pack');
  assert.equal(classify('POST', `${PUB}/git-upload-pack`, BLOB), 'pack');
  assert.equal(classify('POST', `${PUB}/git-upload-pack`, LSREFS), 'refs');
  assert.equal(classify('GET', `${PUB}/info/refs?service=git-upload-pack`, null), 'discover');
  for (const b of [HAVE, SHALLOW, SINCE, WANTREF, enc('0000'), enc(`${pkt('command=fetch\n')}0000`)]) assert.equal(classify('POST', `${PUB}/git-upload-pack`, b), null);
  assert.equal(classify('POST', `${PUB}/git-upload-pack`, null), null);
});

test('cacheableUpstream: the public namespace and the built-in public forges, upload-pack only', () => {
  for (const [m, u] of [['GET', `${PUB}/info/refs?service=git-upload-pack`], ['POST', `${PUB}/git-upload-pack`], ['GET', `${GH}/info/refs?service=git-upload-pack`], ['POST', `${GH}/git-upload-pack`], ['POST', 'https://gitlab.com/a/b.git/git-upload-pack']]) {
    assert.equal(cacheableUpstream(m as string, u as string), true, u);
  }
  for (const [m, u] of [
    ['POST', `${PUBLIC_GIT_ORIGIN}/git/default/ply.git/git-upload-pack`], ['POST', `${PUB}/git-receive-pack`], ['GET', `${PUB}/info/refs?service=git-receive-pack`],
    ['POST', 'https://evil.example/a/b.git/git-upload-pack'], ['POST', 'http://github.com/a/b.git/git-upload-pack'], ['POST', 'https://github.com:443/a/b.git/git-upload-pack'],
    ['POST', 'https://u@github.com/a/b.git/git-upload-pack'], ['POST', 'https://github.com./a/b.git/git-upload-pack'], ['POST', 'https://github.com/a/../b.git/git-upload-pack'],
    ['POST', 'https://github.com/a/%2e%2e/b.git/git-upload-pack'], ['POST', 'https://other.artifacts.cloudflare.net/git/public-v0/ply.git/git-upload-pack'],
    ['GET', `${GH}/info/refs?service=git-receive-pack`], ['POST', `${GH}/git-upload-pack?x=1`], ['GET', `${GH}/git-upload-pack`],
  ]) assert.equal(cacheableUpstream(m as string, u as string), false, `${m} ${u}`);
});

type Call = { url: string; via: string | null; carried: Record<string, string> };
function fakeLoopback() {
  const calls: Call[] = [];
  const binding: LoopbackBinding = {
    async fetch(req) {
      calls.push({ url: req.url, via: null, carried: Object.fromEntries(req.headers) });
      assert.equal(req.redirect, 'manual', 'a 3xx must come back to the redirect guard');
      return new Response('pack', { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result', 'cf-cache-status': 'HIT' } });
    },
  };
  return { calls, binding };
}

test('createLoopbackFetch: anonymous public exchanges go to GitCache under /v<CACHE_VERSION>/<kind>/<sha256>; a credential never does', async () => {
  const { calls, binding } = fakeLoopback();
  const direct: { url: string; auth: string | null }[] = [];
  const f = createLoopbackFetch(async (input, init) => { direct.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') }); return new Response('direct'); }, () => binding);
  const r = await f(`${PUB}/git-upload-pack`, { method: 'POST', body: FETCH, headers: { 'git-protocol': 'version=2' } });
  assert.equal(r.headers.get('x-ply-pack-cache'), 'HIT', 'the tier reaches ply as x-ply-pack-cache');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]!.url).pathname, keyPath('pack', await keyHash('pack', `${PUB}/git-upload-pack`, 'version=2', FETCH)));
  assert.match(new URL(calls[0]!.url).pathname, new RegExp(`^/v${CACHE_VERSION}/pack/[0-9a-f]{64}$`));
  await f(`${GH}/git-upload-pack`, { method: 'POST', body: LSREFS });
  assert.match(calls[1]!.url, /\/refs\//);
  await f(`${PUB}/info/refs?service=git-upload-pack`);
  assert.match(calls[2]!.url, /\/discover\//);
  // credentialed: Authorization (what ply sends for a caller's Git-Token / Git-Authorization) always goes direct
  for (const auth of ['Bearer caller-token', 'Basic eDp5']) {
    await f(`${PUB}/git-upload-pack`, { method: 'POST', body: FETCH, headers: { authorization: auth } });
    await f(`${GH}/git-upload-pack`, { method: 'POST', body: LSREFS, headers: { Authorization: auth } });
  }
  assert.equal(calls.length, 3, 'a credentialed exchange never reaches the cache, so it can never populate a key');
  assert.deepEqual(direct.map(d => d.auth), ['Bearer caller-token', 'Bearer caller-token', 'Basic eDp5', 'Basic eDp5']);
  // not cacheable: haves, another namespace, receive-pack, a large body, no binding
  await f(`${PUB}/git-upload-pack`, { method: 'POST', body: HAVE });
  await f(`${PUBLIC_GIT_ORIGIN}/git/default/ply.git/git-upload-pack`, { method: 'POST', body: FETCH });
  await f(`${PUB}/git-receive-pack`, { method: 'POST', body: FETCH });
  await f(`${PUB}/git-upload-pack`, { method: 'POST', body: new Uint8Array(MAX_ROUTED_BODY + 1).fill(0x30) });
  await createLoopbackFetch(async () => new Response('d'), () => null)(`${PUB}/git-upload-pack`, { method: 'POST', body: FETCH });
  await createLoopbackFetch(async () => new Response('d'), null)(`${PUB}/git-upload-pack`, { method: 'POST', body: FETCH });
  assert.equal(calls.length, 3);
  // ply's retry after a corrupt cached pack: purge that key, then fetch it again
  await f(`${PUB}/git-upload-pack`, { method: 'POST', body: FETCH, headers: { 'x-ply-cache': 'bust', 'git-protocol': 'version=2' } });
  assert.match(calls[3]!.url, new RegExp(`/v${CACHE_VERSION}/bust/pack/`));
  assert.equal(new URL(calls[4]!.url).pathname, new URL(calls[0]!.url).pathname);
});

function tokens(): TokenSource {
  return { readToken: async () => TOKEN, secrets: () => [TOKEN, TOKEN.split('?')[0] as string] };
}

async function gcRequest(kind: 'pack' | 'refs' | 'discover', url: string, body: Uint8Array | null, opts: { version?: number; tamperUrl?: string; bust?: boolean } = {}) {
  const hash = await keyHash(kind, url, 'version=2', body);
  const path = opts.bust ? `/v${opts.version ?? CACHE_VERSION}/bust/${kind}/${hash}` : keyPath(kind, hash, opts.version);
  const headers = new Headers({ 'x-ply-gc-url': opts.tamperUrl ?? url, 'x-ply-gc-proto': 'version=2', 'x-ply-gc-ua': 'ply-test' });
  if (body) headers.set('x-ply-gc-body', btoa(String.fromCharCode(...body)));
  return new Request(`https://gitcache.internal${path}`, { headers });
}

test('serveGitCache: policy per kind, the key is bound to the request, the token goes only to the public namespace, errors are scrubbed and not stored', async () => {
  const seen: { url: string; auth: string | null; via: string | null; method: string }[] = [];
  let answer: () => Response = () => new Response('PACK', { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  const up = async (input: RequestInfo | URL, init?: RequestInit) => { const h = new Headers(init?.headers); seen.push({ url: String(input), auth: h.get('authorization'), via: h.get(VIA_HEADER), method: init?.method ?? 'GET' }); return answer(); };
  const purged: string[][] = [];
  const ctx = { cache: { purge: async (o: { pathPrefixes: string[] }) => { purged.push(o.pathPrefixes); } } };
  const pack = await serveGitCache(await gcRequest('pack', `${PUB}/git-upload-pack`, FETCH), tokens(), ctx, up);
  assert.equal(pack.status, 200);
  assert.equal(pack.headers.get('cache-control'), NO_STORE, 'bytes that are not a verifiable pack are passed on but never stored');
  assert.match(pack.headers.get('x-ply-gc-verified') ?? '', /^failed/);
  assert.equal(await pack.text(), 'PACK');
  assert.equal(seen[0]!.auth, `Bearer ${TOKEN}`, 'the public namespace gets the Worker read token');
  assert.equal(seen[0]!.via, 'gitcache');
  const refs = await serveGitCache(await gcRequest('refs', `${GH}/git-upload-pack`, LSREFS), tokens(), ctx, up);
  assert.equal(refs.headers.get('cache-control'), REFS_CACHE);
  assert.equal(seen[1]!.auth, null, 'a forge gets no credential');
  answer = () => new Response(`${pkt('version 2\n')}${pkt('ls-refs\n')}0000`, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
  assert.equal((await serveGitCache(await gcRequest('discover', `${PUB}/info/refs?service=git-upload-pack`, null), tokens(), ctx, up)).headers.get('cache-control'), DISCOVER_V2_CACHE);
  answer = () => new Response(`${pkt('# service=git-upload-pack\n')}0000${pkt(`${OID} HEAD\0side-band\n`)}0000`, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
  assert.equal((await serveGitCache(await gcRequest('discover', `${GH}/info/refs?service=git-upload-pack`, null), tokens(), ctx, up)).headers.get('cache-control'), REFS_CACHE, 'a v0 advertisement carries refs');
  // errors: not stored, and an echoed token is scrubbed here (the caller may be another isolate)
  answer = () => new Response(`echo Bearer ${TOKEN}`, { status: 500, headers: { 'content-type': 'text/plain' } });
  const err = await serveGitCache(await gcRequest('pack', `${PUB}/git-upload-pack`, BLOB), tokens(), ctx, up);
  assert.equal(err.status, 500);
  assert.equal(err.headers.get('cache-control'), NO_STORE);
  assert.equal((await err.text()).includes('art_v1_'), false);
  answer = () => new Response(null, { status: 307, headers: { location: '/elsewhere' } });
  const redir = await serveGitCache(await gcRequest('pack', `${PUB}/git-upload-pack`, BLOB), tokens(), ctx, up);
  assert.equal(redir.status, 307);
  assert.equal(redir.headers.get('cache-control'), NO_STORE);
  assert.equal(redir.headers.get('location'), '/elsewhere');
  const before = seen.length;
  // a key carrying another request's url: refused before any fetch
  assert.equal((await serveGitCache(await gcRequest('pack', `${PUB}/git-upload-pack`, FETCH, { tamperUrl: `${PUBLIC_GIT_ORIGIN}/git/${PUBLIC_NAMESPACE}/other.git/git-upload-pack` }), tokens(), ctx, up)).status, 400);
  // not public: another namespace, receive-pack, a non-forge host
  assert.equal((await serveGitCache(await gcRequest('pack', `${PUBLIC_GIT_ORIGIN}/git/default/ply.git/git-upload-pack`, FETCH), tokens(), ctx, up)).status, 403);
  assert.equal((await serveGitCache(await gcRequest('pack', 'https://evil.example/a.git/git-upload-pack', FETCH), tokens(), ctx, up)).status, 403);
  // a body that is not what the kind says (haves under a pack key)
  assert.equal((await serveGitCache(await gcRequest('pack', `${PUB}/git-upload-pack`, HAVE), tokens(), ctx, up)).status, 403);
  // a CACHE_VERSION bump: the old key is a different path, and an old-version path is not served
  const old = await gcRequest('pack', `${PUB}/git-upload-pack`, FETCH, { version: CACHE_VERSION + 1 });
  assert.notEqual(new URL(old.url).pathname, keyPath('pack', await keyHash('pack', `${PUB}/git-upload-pack`, 'version=2', FETCH)));
  assert.equal((await serveGitCache(old, tokens(), ctx, up)).status, 404);
  assert.equal(seen.length, before, 'none of the refused keys reached upstream');
  // bust purges exactly that key, from GitCache itself
  const b = await serveGitCache(await gcRequest('pack', `${PUB}/git-upload-pack`, FETCH, { bust: true }), tokens(), ctx, up);
  assert.equal(b.status, 204);
  assert.deepEqual(purged, [[keyPath('pack', await keyHash('pack', `${PUB}/git-upload-pack`, 'version=2', FETCH))]]);
  assert.equal(seen.length, before);
});

test('mutable TTLs: a ref change is visible within max-age + stale-while-revalidate', () => {
  assert.equal(REFS_CACHE, `public, max-age=${REFS_MAX_AGE_S}, stale-while-revalidate=${REFS_SWR_S}`);
  assert.ok(REFS_MAX_AGE_S + REFS_SWR_S <= 30, 'worst-case staleness of a ref is at most 30 s');
  assert.ok(!REFS_CACHE.includes('immutable'));
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
}

test('guardrails: no Cache API in src/, and only src/gitcache.ts calls the GitCache binding', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  for (const f of files(src).filter(f => /\.(ts|tsx|js|mjs)$/.test(f))) {
    const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(/\bcaches\s*\.|cachingFetch|caches\.default/.test(text), false, `${f} uses the Cache API`);
    if (!f.endsWith('gitcache.ts')) assert.equal(/GitCache\??\.fetch\s*\(|binding\.fetch\s*\(/.test(text), false, `${f} calls the GitCache binding directly`);
    if (/\.exports\??\.GitCache/.test(text)) assert.ok(/createLoopbackFetch/.test(text), `${f} reads ctx.exports.GitCache but not through createLoopbackFetch`);
  }
});

test('pack verification against real git: a genuine pack is immutable; a corrupted or wrong one is passed on, never stored', async () => {
  const { root, cleanup } = tmpRoot();
  const srv = await startGitServer(root);
  try {
    const bare = makeBareRepo(root, 'v');
    const work = join(root, 'w-v');
    mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    const head = commitFiles(work, bare, { 'README.md': 'verified\n', 'd/e.txt': 'x'.repeat(5000) }, 'seed');
    const blob = git(bare, ['rev-parse', 'main:README.md']).trim();
    const local = (input: RequestInfo | URL, init?: RequestInit) => fetch(String(input).replace(PUBLIC_GIT_ORIGIN, srv.url).replace(`/git/${PUBLIC_NAMESPACE}/ply.git`, '/v.git'), init);
    let mangle: ((b: Uint8Array) => Uint8Array) | null = null;
    const up = async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = await local(input, init);
      if (!mangle) return r;
      return new Response(mangle(new Uint8Array(await r.arrayBuffer())) as BodyInit, { status: r.status, headers: r.headers });
    };
    const body = (w: string, extra = '') => enc(`${pkt('command=fetch\n')}0001${pkt(`want ${w}\n`)}${extra}${pkt('ofs-delta\n')}${pkt('done\n')}0000`);
    const ask = async (b: Uint8Array) => serveGitCache(await gcRequest('pack', `${PUB}/git-upload-pack`, b), tokens(), {}, up);
    // a commit with its trees (blob:none, deepen 1) and a single blob: both verified, both immutable
    for (const b of [body(head, `${pkt('filter blob:none\n')}${pkt('deepen 1\n')}`), body(blob)]) {
      const r = await ask(b);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), IMMUTABLE, r.headers.get('x-ply-gc-verified') ?? '');
      assert.match(r.headers.get('x-ply-gc-verified') ?? '', /^ok;objects=\d+/);
    }
    // flip one byte of the compressed object data (just after the 12-byte PACK header and the object header): same
    // length, must no longer verify. (Bytes in band-2 progress text or the trailer would not change any object.)
    mangle = b => { const c = b.slice(); const i = Buffer.from(c).indexOf('PACK') + 16; c[i] = (c[i] as number) ^ 0xff; return c; };
    const bad = await ask(body(blob));
    assert.equal(bad.headers.get('cache-control'), NO_STORE);
    assert.match(bad.headers.get('x-ply-gc-verified') ?? '', /^failed/);
    // a valid pack that is not what was asked for (served for another want): not stored
    mangle = null;
    const other = git(bare, ['rev-parse', 'main:d/e.txt']).trim();
    const swapped = async (input: RequestInfo | URL, init?: RequestInit) => local(input, { ...init, body: body(other) });
    const wrong = await serveGitCache(await gcRequest('pack', `${PUB}/git-upload-pack`, body(blob)), tokens(), {}, swapped);
    assert.equal(wrong.headers.get('cache-control'), NO_STORE);
    assert.match(wrong.headers.get('x-ply-gc-verified') ?? '', /not in the pack/);
  } finally {
    await srv.close();
    cleanup();
  }
});

test('serveGitCache: a token mint that fails maps to the status ply turns back into the same code (no such repo → 404)', async () => {
  const mint = (code: string): TokenSource => ({ readToken: async () => { throw Object.assign(new Error(code), { code }); }, secrets: () => [] });
  const up = async () => new Response('never');
  const missing = await serveGitCache(await gcRequest('refs', `${PUB}/git-upload-pack`, LSREFS), mint('not_found'), {}, up);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), NO_STORE);
  const down = await serveGitCache(await gcRequest('refs', `${PUB}/git-upload-pack`, LSREFS), mint('upstream_5xx'), {}, up);
  assert.equal(down.status, 502);
  assert.equal(down.headers.get('cache-control'), NO_STORE);
});

test('a filter refusal (400 only blob:none is supported) is cached for an hour; any other 400 is not', async () => {
  const filterBody = enc(`${pkt('command=fetch\n')}0001${pkt(`want ${OID}\n`)}${pkt('filter tree:0\n')}${pkt('deepen 1\n')}${pkt('done\n')}0000`);
  let text = 'git-upload-pack: Unsupported Git fetch filter; only blob:none is supported.';
  const up = async () => new Response(text, { status: 400, headers: { 'content-type': 'text/plain' } });
  const refused = await serveGitCache(await gcRequest('pack', `${PUB}/git-upload-pack`, filterBody), tokens(), {}, up);
  assert.equal(refused.status, 400);
  assert.equal(refused.headers.get('cache-control'), REFUSAL_CACHE);
  assert.match(await refused.text(), /only blob:none is supported/, 'the body reaches ply, which learns the quirk from it');
  text = 'bad request';
  assert.equal((await serveGitCache(await gcRequest('pack', `${PUB}/git-upload-pack`, filterBody), tokens(), {}, up)).headers.get('cache-control'), NO_STORE);
  text = 'only blob:none is supported';
  assert.equal((await serveGitCache(await gcRequest('refs', `${PUB}/git-upload-pack`, LSREFS), tokens(), {}, up)).headers.get('cache-control'), NO_STORE, 'only a pack fetch refusal');
});
