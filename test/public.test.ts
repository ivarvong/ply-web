// The public namespace's credential rules as pure functions: which URLs get the Worker's read token, how the token
// source caches and refreshes, that a caller's credential always wins, and the scrubber. The end-to-end checks against
// real git under workerd are in test/public-worker.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_GIT_HOST, PUBLIC_GIT_ORIGIN, PUBLIC_NAMESPACE, READ_TOKEN_REFRESH_S, READ_TOKEN_TTL_S,
  createTokenSource, isPublicNamespaceRemote, isPublicRepoName, publicRemote, publicRepoOfRemote, publicUploadPackRepo,
  scrubSecrets, withPublicReadCredential, type ArtifactsNamespace,
} from '../src/public.ts';
import { PUBLIC_NAMESPACE as CONFIG_NAMESPACE } from '../src/public-namespace.ts';

const O = PUBLIC_GIT_ORIGIN;
const NS = PUBLIC_NAMESPACE;
const TOKEN = `art_v1_${'ab12'.repeat(10)}?expires=4102444800`;

test('the namespace is one constant, shared by the binding config and the URL rules', () => {
  assert.equal(NS, 'public-v0');
  assert.equal(CONFIG_NAMESPACE, NS);
  assert.equal(publicRemote('ply'), `${O}/git/${NS}/ply.git`);
  assert.equal(PUBLIC_GIT_ORIGIN, `https://${PUBLIC_GIT_HOST}`);
});

test('the read token is attached only to upload-pack on exactly /git/<namespace>/<repo>', () => {
  const ok: [string, string, string][] = [
    ['GET', `${O}/git/${NS}/ply.git/info/refs?service=git-upload-pack`, 'ply'],
    ['GET', `${O}/git/${NS}/ply/info/refs?service=git-upload-pack`, 'ply'],
    ['POST', `${O}/git/${NS}/ply.git/git-upload-pack`, 'ply'],
    ['post', `${O}/git/${NS}/my_repo-1.x.git/git-upload-pack`, 'my_repo-1.x'],
  ];
  for (const [m, u, repo] of ok) assert.equal(publicUploadPackRepo(m, u), repo, `${m} ${u}`);
  const denied: [string, string][] = [
    // receive-pack, in every form
    ['GET', `${O}/git/${NS}/ply.git/info/refs?service=git-receive-pack`],
    ['POST', `${O}/git/${NS}/ply.git/git-receive-pack`],
    ['GET', `${O}/git/${NS}/ply.git/info/refs?service=git-upload-pack&service=git-receive-pack`],
    // wrong verb, query, or endpoint
    ['POST', `${O}/git/${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/ply.git/git-upload-pack`],
    ['POST', `${O}/git/${NS}/ply.git/git-upload-pack?x=1`],
    ['GET', `${O}/git/${NS}/ply.git/info/refs`],
    ['GET', `${O}/git/${NS}/ply.git/info/refs?service=git-upload-pack#f`],
    ['GET', `${O}/git/${NS}/ply.git/HEAD`],
    ['GET', `${O}/git/${NS}/ply.git/objects/info/packs`],
    // another namespace, a prefix or suffix of the namespace, a nested path, the namespace itself
    ['GET', `${O}/git/default/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}x/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/x${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS.toUpperCase()}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/a/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/info/refs?service=git-upload-pack`],
    ['GET', `${O}/${NS}/ply.git/info/refs?service=git-upload-pack`],
    // traversal and encodings
    ['GET', `${O}/git/${NS}/../default/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/./ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/%2e%2e/default/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/%2E%2E/default/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}%2fply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/ply.git%2finfo%2frefs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/ply%252egit/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/ply.git\\..\\x/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}//ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/..ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/.ply.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/ply.git.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/p ly.git/info/refs?service=git-upload-pack`],
    ['GET', `${O}/git/${NS}/ply\u0000.git/info/refs?service=git-upload-pack`],
    // another host, scheme, port, userinfo, case, trailing dot, lookalikes
    ['GET', `https://github.com/git/${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `http://${PUBLIC_GIT_HOST}/git/${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `https://${PUBLIC_GIT_HOST}:443/git/${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `https://${PUBLIC_GIT_HOST}:8443/git/${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `https://${PUBLIC_GIT_HOST}./git/${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `https://${PUBLIC_GIT_HOST.toUpperCase()}/git/${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `https://${PUBLIC_GIT_HOST}.evil.example/git/${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `https://evil.example/${PUBLIC_GIT_HOST}/git/${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `https://x@${PUBLIC_GIT_HOST}/git/${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `https://other.artifacts.cloudflare.net/git/${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', `/git/${NS}/ply.git/info/refs?service=git-upload-pack`],
    ['GET', ''],
  ];
  for (const [m, u] of denied) assert.equal(publicUploadPackRepo(m, u), null, `${m} ${u}`);
});

test('repo names and remotes: the viewer and /v1 accept one repo directly under the namespace', () => {
  for (const n of ['ply', 'a', 'A9', 'x.y_z-1']) assert.equal(isPublicRepoName(n), true, n);
  for (const n of ['', '.x', '-x', '_x', 'a..b', 'a/b', 'a.git', 'a%2f', 'a b', 'x'.repeat(101)]) assert.equal(isPublicRepoName(n), false, n);
  assert.equal(publicRepoOfRemote(`${O}/git/${NS}/ply.git`), 'ply');
  assert.equal(publicRepoOfRemote(`${O}/git/${NS}/ply`), 'ply');
  for (const u of [`${O}/git/${NS}/a/ply.git`, `${O}/git/other/ply.git`, `${O}/git/${NS}/ply.git/info/refs`, `${O}/git/${NS}/..%2fx.git`, `https://github.com/git/${NS}/ply.git`]) {
    assert.equal(publicRepoOfRemote(u), null, u);
  }
  // write refusal is broad on purpose: any case, any depth under the namespace
  for (const u of [`${O}/git/${NS}/ply.git`, `${O}/git/${NS.toUpperCase()}/ply.git`, `${O}/git/${NS}/a/b.git`, `https://${PUBLIC_GIT_HOST.toUpperCase()}/git/${NS}/ply`]) {
    assert.equal(isPublicNamespaceRemote(u), true, u);
  }
  for (const u of [`${O}/git/default/ply.git`, `${O}/git/${NS}x/ply.git`, `https://github.com/git/${NS}/ply.git`, 'not a url']) {
    assert.equal(isPublicNamespaceRemote(u), false, u);
  }
});

type Mint = { repo: string; scope: string; ttl: number };

function fakeBinding(opts: { known?: string[]; ttlS?: number; now: () => number; fail?: Error } = { now: Date.now }) {
  const mints: Mint[] = [];
  let disposed = 0;
  let n = 0;
  const binding: ArtifactsNamespace = {
    async get(name) {
      if (opts.fail) throw opts.fail;
      if (!(opts.known ?? ['ply']).includes(name)) throw new Error(`repo not found: ${name}`);
      return {
        async createToken(scope, ttl) {
          mints.push({ repo: name, scope, ttl });
          n += 1;
          const exp = Math.floor(opts.now() / 1000) + (opts.ttlS ?? ttl);
          return { plaintext: `art_v1_${String(n).padStart(40, '0')}?expires=${exp}`, expiresAt: new Date(exp * 1000).toISOString() };
        },
        [Symbol.dispose]() { disposed += 1; },
      };
    },
  };
  return { binding, mints, disposed: () => disposed };
}

test('token source: read scope only, one mint per repo while fresh, shared by concurrent callers, refreshed near expiry', async () => {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const fake = fakeBinding({ known: ['ply', 'b'], now });
  const src = createTokenSource(fake.binding, now);
  const [a, b, c] = await Promise.all([src.readToken('ply'), src.readToken('ply'), src.readToken('ply')]);
  assert.equal(a, b); assert.equal(b, c);
  assert.equal(fake.mints.length, 1, 'concurrent callers share one mint');
  assert.deepEqual(fake.mints[0], { repo: 'ply', scope: 'read', ttl: READ_TOKEN_TTL_S });
  assert.equal(fake.disposed(), 1, 'the repo handle is released');
  clock += (READ_TOKEN_TTL_S - READ_TOKEN_REFRESH_S - 1) * 1000;
  assert.equal(await src.readToken('ply'), a, 'still fresh: cached');
  assert.equal(fake.mints.length, 1);
  clock += 2000;
  const fresh = await src.readToken('ply');
  assert.notEqual(fresh, a, 'inside the refresh window: re-minted');
  assert.equal(fake.mints.length, 2);
  await src.readToken('b');
  assert.equal(fake.mints.length, 3);
  assert.ok(fake.mints.every(m => m.scope === 'read'));
  // the retired token is still scrubbed
  const secrets = src.secrets();
  for (const t of [a, fresh]) { assert.ok(secrets.includes(t)); assert.ok(secrets.includes(t.split('?')[0] as string)); }
  await assert.rejects(src.readToken('../x'), { code: 'bad_request' });
  await assert.rejects(src.readToken('nope'), { code: 'not_found' });
  await assert.rejects(createTokenSource(fakeBinding({ now, fail: new Error('boom') }).binding, now).readToken('ply'), { code: 'upstream_5xx' });
});

test('withPublicReadCredential: adds Bearer only on a public upload-pack URL with no Authorization; a caller credential wins', async () => {
  const fake = fakeBinding({ now: Date.now });
  const src = createTokenSource(fake.binding);
  const seen: { url: string; method: string; auth: string | null }[] = [];
  const inner = async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
    return new Response('ok');
  };
  const f = withPublicReadCredential(inner, src);
  await f(`${O}/git/${NS}/ply.git/info/refs?service=git-upload-pack`, { headers: { 'git-protocol': 'version=2' } });
  await f(`${O}/git/${NS}/ply.git/git-upload-pack`, { method: 'POST', body: new Uint8Array([1]) });
  await f(`${O}/git/${NS}/ply.git/git-receive-pack`, { method: 'POST', body: new Uint8Array([1]) });
  await f(`${O}/git/default/ply.git/info/refs?service=git-upload-pack`);
  await f(`https://github.com/git/${NS}/ply.git/info/refs?service=git-upload-pack`);
  await f(`${O}/git/${NS}/ply.git/info/refs?service=git-upload-pack`, { headers: { Authorization: 'Bearer caller' } });
  const token = await src.readToken('ply');
  assert.deepEqual(seen.map(s => s.auth), [`Bearer ${token}`, `Bearer ${token}`, null, null, null, 'Bearer caller']);
  assert.equal(new Headers({ 'git-protocol': 'version=2' }).get('git-protocol'), 'version=2');
  // no token source (no binding): pass-through
  const plain = withPublicReadCredential(inner, null);
  await plain(`${O}/git/${NS}/ply.git/info/refs?service=git-upload-pack`);
  assert.equal(seen.at(-1)?.auth, null);
});

test('scrubSecrets removes every form, longest first', () => {
  const scrub = scrubSecrets([TOKEN, TOKEN.split('?')[0] as string, btoa(`x-access-token:${TOKEN}`), 'short']);
  const text = `a ${TOKEN} b ${TOKEN.split('?')[0]} c ${btoa(`x-access-token:${TOKEN}`)} short`;
  const out = scrub(text);
  assert.equal(out.includes('art_v1_'), false);
  assert.equal(out.includes(btoa(`x-access-token:${TOKEN}`)), false);
  assert.match(out, /short$/, 'strings under 8 chars are not treated as secrets');
});
