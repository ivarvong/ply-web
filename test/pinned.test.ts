// Whole-response caching of commit-pinned reads (src/pinned.ts): which URLs get a key, that the key is canonical, and
// that Pinned only accepts keys it would issue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_VERSION } from '../src/cache-version.ts';
import { IMMUTABLE, asPinned, isInternal, pinnedViewKey, requestForKey } from '../src/pinned.ts';
import { PUBLIC_GIT_HOST, PUBLIC_GIT_ORIGIN } from '../src/public.ts';

const OID = 'c2ccba2c554e8a18ac438cfbc53725d4b593811b';
const REMOTE = `${PUBLIC_GIT_ORIGIN}/git/public-v0/ply.git`;
const u = (s: string) => new URL(s, 'https://ply.ivar.workers.dev');
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const anyPublic = () => true;

test('pinnedViewKey: raw files at a pinned commit on a public repo only', () => {
  const view = `/view/${PUBLIC_GIT_HOST}/git/public-v0/ply.git`;
  assert.match(pinnedViewKey(u(`${view}?raw=1&ref=${OID}&path=README.md`), 'GET', anyPublic) ?? '', new RegExp(`^/v${CACHE_VERSION}/pinned/view/`));
  assert.ok(pinnedViewKey(u(`${view}?raw=1&at=${OID}&path=README.md`), 'HEAD', anyPublic));
  assert.match(pinnedViewKey(u(`/r/ply?raw=1&ref=${OID}&path=README.md`), 'GET', anyPublic) ?? '', new RegExp(`^/v${CACHE_VERSION}/pinned/r/ply\\?`));
  assert.equal(pinnedViewKey(u(`/r/ply?ref=${OID}&path=README.md`), 'GET', anyPublic), null, 'html is not pinned');
  assert.equal(pinnedViewKey(u(`/r/not a name?raw=1&ref=${OID}&path=README.md`), 'GET', anyPublic), null);
  for (const s of [`${view}?ref=${OID}&path=README.md`, `${view}?raw=1&ref=main&path=README.md`, `${view}?raw=1&ref=${OID}`, `${view}?raw=1&ref=${OID}&path=a&x=1`, `${view}?raw=1&ref=${OID}&at=${'b'.repeat(40)}&path=a`]) {
    assert.equal(pinnedViewKey(u(s), 'GET', anyPublic), null, s);
  }
  assert.equal(pinnedViewKey(u(`${view}?raw=1&ref=${OID}&path=README.md`), 'GET', () => false), null, 'not a public location');
});

test('requestForKey: Pinned accepts only canonical keys it would issue, and marks the request internal', () => {
  const k = pinnedViewKey(u(`/r/ply?${q({ raw: '1', ref: OID, path: 'src/a.js' })}`), 'GET', anyPublic) as string;
  const r = requestForKey(k, anyPublic);
  assert.ok(r);
  assert.equal(isInternal(r as Request), true);
  assert.equal(new URL((r as Request).url).pathname, '/r/ply');
  assert.equal([...(r as Request).headers].length, 0, 'no header, so no credential, reaches the handler');
  assert.equal(isInternal(new Request((r as Request).url)), false, 'a copy is not internal');
  // /v1 is never cached whole (every /v1 response is no-store): a /v1 key, even a canonical full-oid public one, is refused
  const v1 = (path: string) => `/v${CACHE_VERSION}/pinned${path}?${q({ remote: REMOTE, ref: OID, path: 'src' })}`;
  for (const bad of [k.replace(`/v${CACHE_VERSION}/`, `/v${CACHE_VERSION + 1}/`), k + '&x=1', `/v${CACHE_VERSION}/pinned/r/ply?path=src/a.js&raw=1&ref=${OID}`, v1('/v1/tree'), v1('/v1/read'), v1('/v1/commit'), `/v${CACHE_VERSION}/pinned/v1/refs?${q({ remote: REMOTE })}`, '/v1/tree']) {
    assert.equal(requestForKey(bad, anyPublic), null, bad);
  }
});

test('asPinned: a 200 is immutable without the fill\'s per-request headers; anything else is no-store', () => {
  const ok = asPinned(new Response('x', { status: 200, headers: { 'x-ply-request-id': 'r', 'x-ply-trace': 't', 'server-timing': 's', 'content-type': 'text/plain' } }));
  assert.equal(ok.headers.get('cache-control'), IMMUTABLE);
  for (const h of ['x-ply-request-id', 'x-ply-trace', 'server-timing']) assert.equal(ok.headers.get(h), null);
  assert.equal(ok.headers.get('content-type'), 'text/plain');
  assert.equal(asPinned(new Response('no', { status: 404 })).headers.get('cache-control'), 'no-store');
});
