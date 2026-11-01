// Public viewer: URL/SSRF rules, caps, escaping, a real pack fixture, the credential-stripping fetch,
// a local git http-backend, the SQLite rate-limit object under workerd, and (when reachable) GitHub.
import { beforeEach, test } from 'node:test';
import { resetQuirks } from '../src/quirks.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyCfBundle } from './cf-bundle.js';
import { concat } from 'ply';
import { Sha1 } from 'ply';
import { TYPE } from 'ply';
import { encodeObjHeader, spliceDelta, zlibDeflate } from 'ply';
import { parsePack } from 'ply';
import { createTransport, lsRefs, Tracer } from 'ply';
import { git, makeBareRepo, startGitServer, tmpRoot, commitFiles } from './server.js';
import { startProxy } from './proxy.js';
import { createBudget } from '../src/viewer/budget.ts';
import { escapeHtml } from '../src/viewer/escape.ts';
import { credentialFreeHeaders, createViewerFetch } from '../src/viewer/fetchguard.ts';
import { handleViewer } from '../src/viewer/handle.ts';
import { renderError, renderHome, renderLoaded, renderNamespace } from '../src/viewer/html.ts';
import { nearbyRefs } from '../src/viewer/hint.ts';
import { KUMO_USED, VIEWER_CSS, cssNodes, selectorClasses } from '../src/viewer/styles.ts';
import { commitProse } from '../src/viewer/format.ts';
import { repoIdentity } from '../src/viewer/identity.ts';
import { PUBLIC_GIT_HOST } from '../src/public.ts';
import { matchAbbreviatedOid, MIN_ABBREV_HEX } from '../src/abbrev.ts';
import { describeFailure } from '../src/viewer/failure.ts';
import { compareTagNames, tagsFromRefs } from '../src/viewer/tags.ts';
import { plyBuildValue } from '../src/version.ts';
import { LAYOUT } from '../src/viewer/layout.ts';
import { none, some } from '../src/option.ts';
import { VIEWER_CAPS, VIEWER_GIT_LIMITS, VIEWER_UA, rateLimitFor } from '../src/viewer/limits.ts';
import type { Loaded, RateNamespace, TraceModel } from '../src/viewer/model.ts';
import { renderMarkdown } from '../src/viewer/markdown.ts';
import { mapPack } from '../src/viewer/packmap.ts';
import { interpretRemote } from '../src/viewer/paste.ts';
import { parseViewerRoute, routeOptsFromEnv } from '../src/viewer/route.ts';
import { VIEWER_CSP } from '../src/viewer/script.ts';
import { ALLOWED_HOSTS, allowlistFromEnv, assertUpstreamUrl, validatePublicRepoUrl, type AllowedHost, type RepoLocation } from '../src/viewer/url.ts';


// Every test dials a local server under the github.com origin; the isolate-wide quirks map must not carry over.
beforeEach(() => resetQuirks());
const FIXTURE = fileURLToPath(new URL('./fixtures/viewer/small.pack', import.meta.url));
const FIXTURE_SHA = 'a86b269e52e69445e10d4c1dd7c5a89b323c0988f1d73b1f0b0c7c1d112f846a';

function treeFixture(over: { message?: string; host?: string; repoPath?: string }): Extract<Loaded, { kind: "tree" }> {
  const host = over.host ?? 'github.com'
  const repoPath = over.repoPath ?? 'o/r'
  return {
    kind: 'tree',
    header: {
      host, repoPath, ref: 'refs/heads/main', commit: 'a'.repeat(40), treeHref: `/view/${host}/${repoPath}`,
      server: { agent: 'git/2', protocol: 2, objectFormat: 'sha1', caps: ['agent'], fetchFeatures: ['filter'], filterAdvertised: true },
    },
    path: '',
    commit: { oid: 'a'.repeat(40), tree: 'b'.repeat(40), parents: [], authorName: 'Ada', authorEmail: 'a@b', authorTime: '2020-01-02T03:04:05Z', authorTz: '+0000', message: over.message ?? 'subject', signed: false },
    log: [], logStopped: false,
    branches: [{ name: 'refs/heads/main', oid: 'a'.repeat(40), head: true }], branchesTruncated: 0,
    tags: [{ name: 'refs/tags/v1.0.0', oid: 'd'.repeat(40) }], tagsTruncated: 0,
    entries: [{ name: 'a.txt', mode: '100644', oid: 'c'.repeat(40), type: 'blob' }], entriesTruncated: 0,
    readme: null,
  }
}

function loc(raw: string, allowed: readonly AllowedHost[] = ALLOWED_HOSTS): RepoLocation {
  return validatePublicRepoUrl(raw, { allowedHosts: allowed });
}

test('public repo URLs: exact allowlist, case, trailing dot, lookalikes, credentials', () => {
  const supported = 'Supported hosts: github.com, gitlab.com, codeberg.org, bitbucket.org, git.sr.ht.';
  assert.equal(loc('https://github.com/octocat/Hello-World.git').repoPath, 'octocat/Hello-World.git');
  assert.equal(loc('https://GitHub.com/octocat/Hello-World').host, 'github.com');
  assert.equal(loc('https://GitHub.com/octocat/Hello-World').url, 'https://github.com/octocat/Hello-World');
  assert.equal(loc('https://gitlab.com/a/b').host, 'gitlab.com');
  assert.equal(loc('https://codeberg.org/a/b').host, 'codeberg.org');
  assert.equal(loc('https://bitbucket.org/a/b').host, 'bitbucket.org');
  assert.equal(loc('https://git.sr.ht/~user/repo').host, 'git.sr.ht');
  assert.equal(loc('https://git.sr.ht/~user/repo').repoPath, '~user/repo');
  const bad = [
    'http://github.com/a/b', 'https://github.com:8443/a/b', 'https://user:pw@github.com/a/b', 'https://github.com/a/b?x=1',
    'https://github.com/a/b#f', 'https://github.com./octocat/Hello-World', 'https://github.com.evil.com/a/b',
    'https://evilgithub.com/a/b', 'https://githüb.com/a/b', 'https://xn--githb-nva.com/a/b',
    'https://127.0.0.1/a/b', 'https://10.0.0.1/a/b', 'https://192.168.1.1/a/b',
    'https://169.254.169.254/a/b', 'https://0.0.0.0/a/b', 'https://[::1]/a/b', 'https://[::ffff:7f00:1]/a/b',
    'https://2130706433/a/b', 'https://0x7f000001/a/b', 'https://0177.0.0.1/a/b', 'https://127.1/a/b',
    'https://localhost/a/b', 'https://foo.localhost/a/b', 'https://git.internal/a/b', 'https://evil.github.com/a/b',
    'https://notgithub.com/a/b', 'https://127.0.0.1.nip.io/a/b', 'https://acct.artifacts.cloudflare.net/git/repo.git',
    'https://ply.ivar.workers.dev/a/b', 'https://other.workers.dev/a/b', 'ftp://github.com/a/b', 'not a url', '',
  ];
  for (const raw of bad) {
    assert.throws(() => loc(raw), (err: { message?: string }) => {
      const message = String(err?.message ?? err);
      return message.includes(supported) && !message.includes('super-secret-token') && !message.includes('pw@');
    }, raw);
  }
  assert.throws(() => loc('https://user:super-secret-token@github.com/octocat/Hello-World'), (err: { message?: string }) => {
    const message = String(err?.message ?? '');
    return /credentials/.test(message) && message.includes(supported) && !message.includes('super-secret-token');
  });
  const extra = allowlistFromEnv('acct.artifacts.cloudflare.net, *.artifacts.cloudflare.net, https://evil.example, github.com:443, , not a host');
  assert.equal(extra.some(host => host === 'github.com'), true);
  assert.equal(extra.some(host => host === 'acct.artifacts.cloudflare.net'), true);
  assert.equal(extra.some(host => host.includes('*') || host.includes('/') || host.includes(':')), false);
  assert.equal(allowlistFromEnv(undefined).length, ALLOWED_HOSTS.length);
  assert.equal(allowlistFromEnv('').length, ALLOWED_HOSTS.length);
  assert.equal(allowlistFromEnv('*.artifacts.cloudflare.net').length, ALLOWED_HOSTS.length);
  const art = loc('https://acct.artifacts.cloudflare.net/git/ns/repo.git', extra);
  assert.equal(art.host, 'acct.artifacts.cloudflare.net');
  assert.throws(() => loc('https://other.artifacts.cloudflare.net/a/b.git', extra), (err: { message?: string }) => /not an allowlisted host/.test(String(err?.message)) && String(err?.message).includes('acct.artifacts.cloudflare.net'));
  assert.throws(() => loc('https://acct.artifacts.cloudflare.net/a/b.git'), /not an allowlisted host/);
  const repo = loc('https://github.com/octocat/Hello-World');
  assert.equal(assertUpstreamUrl('https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), 'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack');
  assert.throws(() => assertUpstreamUrl('https://evil.example/octocat/Hello-World/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /not an allowlisted host/);
  assert.throws(() => assertUpstreamUrl('https://github.com.evil.com/octocat/Hello-World.git/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /not an allowlisted host/);
  assert.throws(() => assertUpstreamUrl('https://gitlab.com/octocat/Hello-World/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /cross-host/);
  assert.throws(() => assertUpstreamUrl('http://github.com/octocat/Hello-World/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /upstream URL rejected/);
  assert.throws(() => assertUpstreamUrl('https://github.com:8443/octocat/Hello-World/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /upstream URL rejected/);
  assert.throws(() => assertUpstreamUrl('https://github.com./octocat/Hello-World/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /not an allowlisted host/);
  assert.throws(() => assertUpstreamUrl('https://github.com/other/Hello/info/refs?service=git-upload-pack', repo.url, repo.allowedHosts), /smart-HTTP/);
  assert.throws(() => assertUpstreamUrl('https://github.com/octocat/Hello-World/git-upload-pack?x=1', repo.url, repo.allowedHosts), /query/);
});

test('paste parsing stays inside the allowlist', () => {
  assert.equal(interpretRemote('octocat/Hello-World').remote, 'https://github.com/octocat/Hello-World');
  assert.equal(interpretRemote('github.com/sindresorhus/is').remote, 'https://github.com/sindresorhus/is');
  assert.equal(interpretRemote('git@github.com:tj/commander.js.git').remote, 'https://github.com/tj/commander.js.git');
  const web = interpretRemote('https://github.com/octocat/Hello-World/blob/master/README');
  assert.equal(web.remote, 'https://github.com/octocat/Hello-World');
  assert.equal(web.ref, 'master');
  assert.equal(web.path, 'README');
  const route = parseViewerRoute(new URL('https://ply.example/view?remote=octocat/Hello-World'), routeOptsFromEnv({}));
  assert.equal(route.kind, 'redirect');
  if (route.kind === 'redirect') assert.equal(route.location, '/view/github.com/octocat/Hello-World');
  const tagged = parseViewerRoute(new URL('https://ply.example/view/github.com/octocat/Hello-World?ref=refs/heads/main&at=v1.0.0'), routeOptsFromEnv({}));
  assert.equal(tagged.kind, 'redirect');
  if (tagged.kind === 'redirect') assert.equal(tagged.location, '/view/github.com/octocat/Hello-World?ref=v1.0.0');
  const namespaced = parseViewerRoute(new URL('https://ply.example/r/'), routeOptsFromEnv({}));
  assert.equal(namespaced.kind, 'namespace');
  const shortRepo = parseViewerRoute(new URL(`https://ply.example/r/ply?path=README.md`), routeOptsFromEnv({}));
  assert.equal(shortRepo.kind, 'repo');
  if (shortRepo.kind === 'repo') assert.equal(shortRepo.loc.repoPath, 'git/public-v0/ply.git');
  const longPublic = parseViewerRoute(new URL(`https://ply.example/view/${PUBLIC_GIT_HOST}/git/public-v0/ply.git?path=README.md`), routeOptsFromEnv({}));
  assert.equal(longPublic.kind, 'redirect');
  if (longPublic.kind === 'redirect') assert.equal(longPublic.location, '/r/ply?path=README.md');
  assert.throws(() => parseViewerRoute(new URL('https://ply.example/view?remote=evil.example/a/b'), routeOptsFromEnv({})), /Supported hosts/);
  assert.throws(() => parseViewerRoute(new URL('https://ply.example/view?remote=' + encodeURIComponent('https://user:super-secret-token@github.com/a/b')), routeOptsFromEnv({})), (err: { message?: string }) => /credentials/.test(String(err?.message)) && !String(err?.message).includes('super-secret-token'));
  const md = renderMarkdown('# Hi\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n[ok](https://github.com/octocat/Hello-World)\n');
  assert.equal(md.includes('<script'), false);
  assert.match(md, /&lt;script&gt;/);
  assert.equal(md.includes('javascript:'), true);
  assert.equal(/href="javascript:/.test(md), false);
  assert.match(md, /href="https:\/\/github.com\/octocat\/Hello-World"/);
  assert.equal(VIEWER_CSP.includes('unsafe-inline'), false);
  assert.match(VIEWER_CSP, /script-src 'none'/);
  assert.match(VIEWER_CSP, /style-src 'self'/);
});

test('abbreviated oids, failure copy, tag order, cache headers, and version text', () => {
  const oid = '705bd639' + 'a'.repeat(32);
  const other = '705bd639' + 'b'.repeat(32);
  const refs = new Map<string, { oid: string; peeled?: string }>([
    ['refs/heads/main', { oid }],
    ['refs/heads/other', { oid: other }],
    ['refs/tags/v1', { oid: 'c'.repeat(40), peeled: oid }],
  ]);
  assert.equal(MIN_ABBREV_HEX, 7);
  assert.deepEqual(matchAbbreviatedOid('705bd639a', refs), { kind: 'unique', oid });
  const ambiguous = matchAbbreviatedOid('705bd639', refs);
  assert.equal(ambiguous.kind, 'ambiguous');
  assert.match(ambiguous.message, /40-hex/);
  assert.equal(matchAbbreviatedOid('deadbee', refs).kind, 'none');
  assert.equal(matchAbbreviatedOid(other.slice(0, 12), refs).kind, 'unique');
  const missing = describeFailure({ code: 'auth', status: 401, message: 'authentication failed', host: 'github.com', repoPath: 'ivarvong/ply', ref: null, path: '' });
  assert.equal(missing.status, 404);
  assert.equal(missing.part, 'repo');
  assert.equal(missing.summary, 'Repository ivarvong/ply not found, or private');
  const badRef = describeFailure({ code: 'not_found', status: 404, message: 'ref v99.0.0 not found', host: 'github.com', repoPath: 'ivarvong/ply', ref: 'v99.0.0', path: '' });
  assert.equal(badRef.part, 'ref');
  assert.equal(badRef.summary, 'No ref v99.0.0 in ivarvong/ply');
  const badPath = describeFailure({ code: 'not_found', status: 404, message: 'path component missing not found', host: 'github.com', repoPath: 'o/r', ref: 'main', path: 'src/missing' });
  assert.equal(badPath.part, 'path');
  assert.match(badPath.summary, /No path src\/missing in o\/r/);
  // A /r/<name> the public namespace lacks: sentence case like every other headline.
  assert.equal(describeFailure({ code: 'not_found', status: 404, message: 'no repository nope in the public namespace', host: 'h.example', repoPath: 'git/public-v0/nope.git', ref: null, path: '' }).summary, 'No repository nope in the public namespace');
  assert.ok(compareTagNames('refs/tags/v2.0.0', 'refs/tags/v1.9.0') < 0);
  assert.deepEqual(tagsFromRefs(refs, 10).tags.map(tag => tag.name), ['refs/tags/v1']);
  assert.match(plyBuildValue('a'.repeat(40), 'b'.repeat(40)), /^ply=[0-9a-f]{40} ply-web=[0-9a-f]{40}$/);
  assert.match(VIEWER_CSS, new RegExp(`\\.files \\.oid \\{[^}]*color: var\\(--text-color-kumo-default\\)`));
  assert.match(VIEWER_CSS, new RegExp(`font-size: ${LAYOUT.codeFontPx}px`));
  assert.match(VIEWER_CSS, new RegExp(`font-size: ${LAYOUT.monoFontPx}px`));
  assert.match(VIEWER_CSS, /scrollbar-width: thin/);
  assert.match(VIEWER_CSS, /\.refbox \{ position: static; \} \.ref-pop \{ left: 0; right: 0; width: auto; \}/);
  const trace: TraceModel = { bars: [], totalMs: 0, cfRay: '', requestId: '' };
  const page = renderLoaded(treeFixture({ message: 'Subject line\n\nBody that should span the card.\n' }), trace);
  assert.match(String(page), /refs\/tags\/v1\.0\.0/);
  assert.match(String(page), /ply=/);
  const tree = treeFixture({});
  const file: Loaded = {
    kind: 'file', header: tree.header, path: 'README.md', branches: tree.branches, branchesTruncated: 0,
    tags: tree.tags, tagsTruncated: 0, mode: '100644', blob: 'c'.repeat(40), size: 6, note: 'text', text: 'hello\n',
  };
  assert.match(String(renderLoaded(file, trace)), /Wrap lines/);
  const refused = renderError(401, 'auth', 'authentication failed', trace, 'github.com', 'nope/missing', null, 1, '');
  assert.match(String(refused), /not found, or private/);
  assert.match(String(refused), /GitHub answers 401/);
  assert.match(String(refused), /HTTP 404/);
  assert.match(String(refused), /href="\/view\/github\.com\/nope\/missing"/);
  assert.equal(String(refused).includes('Check the owner'), false);
  assert.equal(String(refused).includes('No ref'), false);
  const refPage = String(renderError(404, 'not_found', 'ref v99.0.0 not found', trace, 'github.com', 'shot/shot', 'v99.0.0', 1, '', {
    nearby: [{ label: 'main', ref: 'refs/heads/main' }, { label: 'v1.10.0', ref: 'refs/tags/v1.10.0' }],
    path: null,
  }));
  assert.match(refPage, /No ref v99\.0\.0 in shot\/shot/);
  assert.match(refPage, /<p class="banner[^"]*"><span>That name is not a branch or tag/);
  assert.match(refPage, /ref picker/);
  assert.match(refPage, /href="\/view\/github\.com\/shot\/shot\?ref=refs\/heads\/main"/);
  assert.match(refPage, />v1\.10\.0</);
  assert.equal(refPage.includes('Check the owner'), false);
  assert.doesNotMatch(refPage, /HTTP 401|answers 401/); // not a bare '401': request ids and timings on the page can contain it
  const pathPage = String(renderError(404, 'not_found', 'path component missing not found', trace, 'github.com', 'o/r', 'main', 1, 'src/missing', {
    nearby: [],
    path: { missing: 'missing', existingPath: 'src', notDirectory: false },
  }));
  assert.match(pathPage, /No path src\/missing in o\/r/);
  assert.match(pathPage, /No entry named missing/);
  assert.match(pathPage, /href="\/view\/github\.com\/o\/r\?ref=main&amp;path=src"/);
  assert.doesNotMatch(pathPage, /HTTP 401|answers 401/); // not a bare '401': request ids and timings on the page can contain it
  assert.equal(pathPage.includes('Check the owner'), false);
  // Names from the URL (ref, path) and from the remote (nearby refs, path cue) are text, never markup.
  const evil = '"><img src=x onerror=alert(1)>'
  const hostile = [
    String(renderError(404, 'not_found', `ref ${evil} not found`, trace, 'github.com', 'o/r', evil, 1, '', { nearby: [{ label: evil, ref: `refs/tags/${evil}` }], path: null })),
    String(renderError(404, 'not_found', `path component ${evil} not found`, trace, 'github.com', 'o/r', 'main', 1, `src/${evil}`, { nearby: [], path: { missing: evil, existingPath: `src/${evil}`, notDirectory: false } })),
  ]
  for (const page of hostile) {
    assert.equal(page.includes('<img'), false, 'a reflected name became markup')
    assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/)
  }
  const repos = { names: ['curl', 'deepfile', 'ply', 'ply-web'], unavailable: false };
  const listedHome = String(renderHome(null, 1, repos));
  const listedNamespace = String(renderNamespace(repos, 1));
  const listMarkup = (html: string) => /<ul class="repo-list">[\s\S]*?<\/ul>/.exec(html)?.[0] ?? '';
  assert.equal(listMarkup(listedHome), listMarkup(listedNamespace));
  assert.match(listMarkup(listedNamespace), /href="\/r\/ply"/);
  assert.equal(listedNamespace.includes('unavailable'), false);
  assert.match(String(renderNamespace({ names: [], unavailable: true }, 1)), /unavailable right now/);
  assert.equal(String(renderNamespace({ names: [], unavailable: false }, 1)).includes('unavailable'), false);
  assert.deepEqual(nearbyRefs('v99.0.0', [
    { name: 'refs/heads/main', head: true },
    { name: 'refs/heads/feature', head: false },
  ], [
    { name: 'refs/tags/v1.10.0' },
    { name: 'refs/tags/v1.2.0' },
  ]).map(item => item.label), ['v1.10.0', 'v1.2.0', 'main', 'feature']);
});

test('ssr markup uses Kumo classes, prose commits, and a strict CSP', () => {
  const home = renderHome(null, 1_700_000_000_000)
  assert.match(home, /name="remote"/)
  assert.match(home, /href="\/view\.[0-9a-f]{12}\.css"/)
  assert.match(home, /bg-kumo-contrast/)
  assert.equal(home.includes('<script'), false)
  assert.equal(home.includes('style='), false)
  const trace: TraceModel = { bars: [], totalMs: 12, cfRay: 'ray-ssr', requestId: 'req-ssr' }
  const when = Date.parse('2020-01-02T03:04:05Z')
  const loaded: Loaded = {
    kind: 'tree',
    header: {
      host: 'github.com', repoPath: 'octocat/Hello-World', ref: 'refs/heads/main', commit: 'a'.repeat(40),
      treeHref: '/view/github.com/octocat/Hello-World',
      server: { agent: 'git/2', protocol: 2, objectFormat: 'sha1', caps: ['agent'], fetchFeatures: ['filter'], filterAdvertised: true },
    },
    path: '',
    commit: {
      oid: 'a'.repeat(40), tree: 'b'.repeat(40), parents: [], authorName: 'Ada', authorEmail: 'a@b',
      authorTime: '2020-01-02T03:04:05Z', authorTz: '-0700',
      message: 'Subject line\n\nThis is a wrapped\nparagraph that should flow.\n\nSecond paragraph.',
      signed: false,
    },
    log: [], logStopped: false,
    branches: [{ name: 'refs/heads/main', oid: 'a'.repeat(40), head: true }], branchesTruncated: 0,
    tags: [{ name: 'refs/tags/v1.0.0', oid: 'd'.repeat(40) }], tagsTruncated: 0,
    entries: [], entriesTruncated: 0,
    readme: null,
  }
  const html = renderLoaded(loaded, trace, when + 5 * 86_400_000)
  // Commit bodies keep their line structure (pre-wrap), paragraph by paragraph.
  assert.match(html, /<p class="msg-p">This is a wrapped\nparagraph that should flow\.<\/p><p class="msg-p">Second paragraph\.<\/p>/)
  assert.match(html, /5 days ago/)
  assert.match(html, /title="02 Jan 2020, 03:04:05 UTC \(-0700\)"/)
  assert.equal(html.includes('<pre class="msg"'), false)
  assert.equal(html.includes('style='), false)
  const error = renderError(400, 'bad_request', 'remote host is not allowed. Supported hosts: github.com, gitlab.com, codeberg.org, bitbucket.org, git.sr.ht.', trace)
  assert.match(error, /That URL is not supported/)
  assert.match(error, /Supported hosts: github.com, gitlab.com, codeberg.org, bitbucket.org, git.sr.ht/)
  assert.equal(error.includes('<script'), false)
  // The way back up: a missing repo never links to its own (missing) root; a public-namespace name links to /r.
  const notInNs = String(renderError(404, 'not_found', 'no repository nope in the public namespace', trace, 'h.example', 'git/public-v0/nope.git'))
  assert.match(notInNs, /<h1 class="display">No repository nope in the public namespace<\/h1>/)
  assert.match(notInNs, /<a href="\/r">Repository index<\/a>/)
  assert.equal(notInNs.includes('Repository root'), false)
  const ghMissing = String(renderError(401, 'auth', 'authentication failed', trace, 'github.com', 'o/missing'))
  assert.equal(ghMissing.includes('Repository root'), false)
  assert.match(ghMissing, /<a href="\/view">Back to the viewer<\/a>/)
  assert.match(String(renderError(404, 'not_found', 'ref nope not found', trace, 'github.com', 'o/r', 'nope')), /<a href="\/view\/github\.com\/o\/r">Repository root<\/a>/)
  // The footer's build line is two unbreakable tokens (a 375 px footer wraps between them, never inside "ply-web=").
  assert.match(String(error), /<span class="mono build" title="ply=\S+ ply-web=\S+ [^"]*"><span>ply=[0-9a-z]{1,12}<\/span> <span>ply-web=[0-9a-z]{1,12}<\/span><\/span>/)
  assert.match(VIEWER_CSS, /\.site-footer \.build > span \{ white-space: nowrap; \}/)
  const limited = renderError(429, 'rate_limited', 'Too many viewer requests. Retry after 1s.', trace)
  assert.match(limited, /Too many requests/)
  assert.match(VIEWER_CSS, /--color-kumo-canvas/)
  assert.match(VIEWER_CSS, /--text-color-kumo-brand/)
  assert.match(VIEWER_CSS, /@media \(prefers-color-scheme: dark\)/)
  assert.match(VIEWER_CSS, /color-scheme: light dark/)
  assert.match(VIEWER_CSP, /script-src 'none'/)
  assert.equal(VIEWER_CSP.includes('unsafe-inline'), false)
  // /view.css carries Kumo's theme and base whole, plus only the utilities kumo-classes.ts can emit.
  const shipped = readFileSync(fileURLToPath(new URL('../node_modules/@cloudflare/kumo/dist/styles/kumo-standalone.css', import.meta.url)), 'utf8')
  const layers = cssNodes(shipped)
  const theme = layers.find(node => node.prelude === '@layer theme')
  assert.ok(theme?.body && VIEWER_CSS.includes(theme.body))
  const shippedUtilities = new Set<string>()
  const collect = (body: string) => { for (const node of cssNodes(body)) { if (node.body === null) continue; if (node.prelude.startsWith('@')) collect(node.body); else for (const name of selectorClasses(node.prelude)) shippedUtilities.add(name) } }
  collect(layers.find(node => node.prelude === '@layer utilities')?.body ?? '')
  for (const name of KUMO_USED) if (name !== 'kumo-input-placeholder') assert.equal(shippedUtilities.has(name), true, `Kumo has no utility ${name}`)
  const keptUtilities = new Set<string>()
  const keptCollect = (body: string) => { for (const node of cssNodes(body)) { if (node.body === null) continue; if (node.prelude.startsWith('@')) keptCollect(node.body); else for (const name of selectorClasses(node.prelude)) keptUtilities.add(name) } }
  keptCollect(cssNodes(VIEWER_CSS).find(node => node.prelude === '@layer utilities')?.body ?? '')
  for (const name of KUMO_USED) if (name !== 'kumo-input-placeholder') assert.equal(keptUtilities.has(name), true, `subset dropped ${name}`)
  assert.equal(keptUtilities.has('bg-kumo-badge-teal'), false)
  assert.ok(VIEWER_CSS.length < 80_000, `view.css is ${VIEWER_CSS.length} bytes`)
})

test('README markdown: GFM table, task list, fenced code label, headings, relative links', () => {
  const md = String(renderMarkdown([
    '# ply', '', 'Intro with `code` and **bold**.', '',
    '## Wire sequence', '', '| # | Request | Why |', '|---|:---:|--:|', '| 1 | v2 `ls-refs` with `ref-prefix` | head oid |', '| 2 | pipe \\| inside | x |', '',
    '- [ ] todo', '- [x] done', '', '```js', "const a = '<b>'", '```', '', 'See [docs](docs/a.md#usage) and ![logo](img/l.png).',
  ].join('\n'), { base: '', resolve: (path, kind) => `/view/github.com/o/r?path=${encodeURIComponent(path)}${kind === 'image' ? '&raw=1' : ''}` }))
  assert.match(md, /<h2 id="ply">ply<\/h2>/)
  assert.match(md, /<h3 id="wire-sequence">Wire sequence<\/h3>/)
  assert.equal(md.includes('| # |'), false)
  assert.match(md, /<div class="md-table"><table><thead><tr><th>#<\/th><th class="al-c">Request<\/th><th class="al-r">Why<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td class="al-c">v2 <code>ls-refs<\/code> with <code>ref-prefix<\/code><\/td><td class="al-r">head oid<\/td><\/tr><tr><td>2<\/td><td class="al-c">pipe \| inside<\/td><td class="al-r">x<\/td><\/tr><\/tbody><\/table><\/div>/)
  assert.match(md, /<li class="task-item"><span class="task"><\/span>todo<\/li><li class="task-item"><span class="task done">✓<\/span>done<\/li>/)
  assert.match(md, /<div class="md-code"><div class="md-code-lang">js<\/div><pre><code>const a = &#39;&lt;b&gt;&#39;<\/code><\/pre><\/div>/)
  assert.match(md, /href="\/view\/github\.com\/o\/r\?path=docs%2Fa\.md#usage"/)
  assert.match(md, /href="\/view\/github\.com\/o\/r\?path=img%2Fl\.png&amp;raw=1" rel="noopener noreferrer nofollow"><span class="md-img">logo<\/span>/)
  assert.equal(md.includes('<img'), false)
})

test('commit bodies keep their lines; trailers are split out and shown quietly', () => {
  const prose = commitProse('subject\n\nline one\nline two\n\n- bullet a\n- bullet b\n\nCloses #33\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_x\n')
  assert.deepEqual(prose.paragraphs, ['line one\nline two', '- bullet a\n- bullet b'])
  assert.deepEqual(prose.trailers, [
    { key: 'Closes', value: '#33' },
    { key: 'Co-Authored-By', value: 'Claude <noreply@anthropic.com>' },
    { key: 'Claude-Session', value: 'https://claude.ai/code/session_x' },
  ])
  // "Key: value" prose with no recognised trailer stays prose.
  assert.deepEqual(commitProse('s\n\nBefore: 12 ms\nAfter: 5 ms').trailers, [])
  const trace: TraceModel = { bars: [], totalMs: 0, cfRay: 'r', requestId: 'q' }
  const html = String(renderLoaded(treeFixture({ message: 'subject\n\nline one\nline two\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n' }), trace))
  assert.match(html, /<p class="msg-p">line one\nline two<\/p><dl class="trailers"><div><dt>Co-Authored-By<\/dt><dd><span title="Claude &lt;noreply@anthropic.com&gt;">Claude<\/span><\/dd><\/div><\/dl>/)
})

test('header identity: public-v0 leads with namespace / repo; GitHub with owner / repo; hosts live in Diagnostics', () => {
  const pub = repoIdentity(PUBLIC_GIT_HOST, 'git/public-v0/ply.git')
  assert.deepEqual({ scope: pub.scope, name: pub.name, hostLabel: pub.hostLabel, scopeHref: pub.scopeHref }, { scope: 'public-v0', name: 'ply', hostLabel: 'Artifacts', scopeHref: '/r' })
  const gh = repoIdentity('github.com', 'octocat/Hello-World')
  assert.deepEqual({ scope: gh.scope, name: gh.name, hostLabel: gh.hostLabel }, { scope: 'octocat', name: 'Hello-World', hostLabel: 'GitHub' })
  const trace: TraceModel = { bars: [], totalMs: 0, cfRay: 'r', requestId: 'q' }
  const html = String(renderLoaded(treeFixture({ host: PUBLIC_GIT_HOST, repoPath: 'git/public-v0/ply.git' }), trace))
  assert.match(html, /<title>public-v0\/ply<\/title>/)
  assert.match(html, /<p class="repo-scope"><span class="repo-host" title="https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\/public-v0\/ply\.git">Artifacts<\/span><a href="\/r">public-v0<\/a><span class="repo-slash" aria-hidden="true">\/<\/span><\/p><h1 class="repo-name"><a href="\/r\/ply\?ref=refs\/heads\/main">ply<\/a><\/h1>/)
  // The raw host appears only in hrefs, the title attribute, and the collapsed Diagnostics section.
  const visible = html.replace(/<section class="diag"[\s\S]*$/, '').replace(/<[^>]+>/g, ' ')
  assert.equal(visible.includes(PUBLIC_GIT_HOST), false)
  assert.equal(html.includes('git/public-v0/ply<'), false)
  const open = String(renderLoaded(treeFixture({}), { ...trace, expanded: true }))
  assert.match(open, /<details class="diag-box" open="">/)
})

test('rate and byte caps clamp and fail closed', () => {
  assert.equal(rateLimitFor('page', none()), 60);
  assert.equal(rateLimitFor('pack', some('')), 20);
  assert.equal(rateLimitFor('page', some('99999')), VIEWER_CAPS.rateCeiling);
  assert.equal(rateLimitFor('page', some('0')), 1);
  assert.equal(rateLimitFor('page', some('nope')), 60);
  assert.equal(rateLimitFor('pack', some('3')), 3);
  const budget = createBudget(100, 2);
  budget.countSubrequest();
  budget.countSubrequest();
  assert.equal(budget.canSpend(1), false);
  assert.throws(() => budget.countSubrequest(), (err: { code?: string }) => err.code === 'limit_exceeded');
  const bytes = createBudget(4, 16);
  bytes.addBytes(4);
  assert.throws(() => bytes.addBytes(1), (err: { code?: string }) => err.code === 'limit_exceeded');
});

test('escapeHtml and the page renderer keep repository text out of HTML', () => {
  assert.equal(escapeHtml(`<script>alert(1)</script>"'`), '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;');
  const trace: TraceModel = { bars: [], totalMs: 0, cfRay: 'ray', requestId: 'id' };
  const loaded: Loaded = {
    kind: 'tree',
    header: {
      host: 'github.com', repoPath: 'o/r', ref: 'refs/heads/main', commit: 'a'.repeat(40),
      treeHref: '/view/github.com/o/r',
      server: { agent: 'gitty/1.0', protocol: 2, objectFormat: 'sha1', caps: ['agent'], fetchFeatures: ['filter'], filterAdvertised: true },
    },
    path: '',
    commit: { oid: 'a'.repeat(40), tree: 'b'.repeat(40), parents: [], authorName: '<b>', authorEmail: 'a@b', authorTime: 't', authorTz: '+0000', message: '<script>alert(1)</script>', signed: false },
    log: [], logStopped: false,
    branches: [{ name: 'refs/heads/main', oid: 'a'.repeat(40), head: true }], branchesTruncated: 0,
    tags: [{ name: 'refs/tags/v1.0.0', oid: 'd'.repeat(40) }], tagsTruncated: 0,
    entries: [{ name: '<script>.txt', mode: '100644', oid: 'c'.repeat(40), type: 'blob' }], entriesTruncated: 0,
    readme: null,
  };
  const html = renderLoaded(loaded, trace);
  assert.equal(html.includes('<script>alert'), false);
  assert.equal(html.includes('style='), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;\.txt/);
  assert.match(html, /gitty\/1\.0/);
});

function encodeOfs(distance: number): Uint8Array {
  const out = [distance & 0x7f];
  let n = Math.floor(distance / 128);
  while (n > 0) {
    n -= 1;
    out.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return Uint8Array.from(out);
}

async function ofsChain(deltaCount: number): Promise<Uint8Array> {
  const payload = new TextEncoder().encode('x');
  const baseZ = await zlibDeflate(payload);
  const delta = spliceDelta({ baseLen: payload.length, off: 0, oldLen: 0, insert: new Uint8Array() }).delta;
  const deltaZ = await zlibDeflate(delta);
  const header = new Uint8Array(12);
  header.set([0x50, 0x41, 0x43, 0x4b]);
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, deltaCount + 1);
  const parts: Uint8Array[] = [header];
  const baseHeader = encodeObjHeader(TYPE.BLOB, payload.length);
  parts.push(baseHeader, baseZ);
  let offset = 12;
  let prev = offset;
  offset += baseHeader.length + baseZ.length;
  const dHeader = encodeObjHeader(TYPE.OFS_DELTA, delta.length);
  for (let i = 0; i < deltaCount; i++) {
    const ofs = encodeOfs(offset - prev);
    parts.push(dHeader, ofs, deltaZ);
    prev = offset;
    offset += dHeader.length + ofs.length + deltaZ.length;
  }
  const body = concat(parts);
  return concat([body, new Sha1().update(body).digest()]);
}

test('pack fixture matches git verify-pack; bombs and long chains fail closed', async () => {
  const pack = new Uint8Array(readFileSync(FIXTURE));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pack));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  assert.equal(hex, FIXTURE_SHA);
  const map = mapPack(pack);
  assert.equal(map.count, 9);
  assert.equal(map.bytes, 930);
  assert.equal(map.ofsDelta, 0);
  assert.equal(map.refDelta, 1);
  assert.equal(map.thin, false);
  assert.equal(map.maxChain, 1);
  assert.equal(map.trailer, 'a470ee9652a659aa2aea5ad58df2a80594c8cfff');
  assert.equal(map.objects[0]?.oid, '4ce20682b4778f9086b59216533e2ccff8dbb191');
  assert.equal(map.objects[1]?.wireType, 'ref_delta');
  assert.equal(map.objects[1]?.resolvedType, 'commit');
  assert.equal(map.objects[1]?.baseOffset, null);
  assert.equal(map.objects[1]?.baseOid, '4ce20682b4778f9086b59216533e2ccff8dbb191');
  assert.equal(map.objects[1]?.chain, 1);
  assert.equal(map.objects[1]?.oid, 'f2db53ea00f5d51ab58e1392c78bb99760defebd');
  let cursor = 12;
  for (const obj of map.objects) {
    assert.equal(obj.offset, cursor);
    cursor += obj.length;
  }
  assert.equal(cursor + 20, pack.length);
  const dir = mkdtempSync(join(tmpdir(), 'ply-pack-'));
  try {
    copyFileSync(FIXTURE, join(dir, 'small.pack'));
    git(dir, ['index-pack', 'small.pack']);
    const verified = git(dir, ['verify-pack', '-v', 'small.pack']);
    assert.match(verified, /non delta: 8 objects/);
    assert.match(verified, /chain length = 1: 1 object/);
    assert.match(verified, /small\.pack: ok/);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const bomb = new Uint8Array(64);
  bomb.set([0x50, 0x41, 0x43, 0x4b]);
  new DataView(bomb.buffer).setUint32(4, 2);
  new DataView(bomb.buffer).setUint32(8, 1);
  bomb.set(encodeObjHeader(TYPE.BLOB, 50_000_000), 12);
  assert.throws(() => parsePack(bomb, { limits: VIEWER_GIT_LIMITS, maxObjects: VIEWER_CAPS.maxPackObjects, maxInflatedTotal: VIEWER_CAPS.maxInflatedTotal }), (err: { code?: string; message?: string }) => err.code === 'limit_exceeded' && /pack object size/.test(err.message ?? ''));

  const tooMany = new Uint8Array(32);
  tooMany.set([0x50, 0x41, 0x43, 0x4b]);
  new DataView(tooMany.buffer).setUint32(4, 2);
  new DataView(tooMany.buffer).setUint32(8, 401);
  assert.throws(() => parsePack(tooMany, { limits: VIEWER_GIT_LIMITS, maxObjects: VIEWER_CAPS.maxPackObjects, maxInflatedTotal: VIEWER_CAPS.maxInflatedTotal }), (err: { code?: string }) => err.code === 'limit_exceeded');

  const short = mapPack(await ofsChain(1));
  assert.equal(short.ofsDelta, 1);
  assert.equal(short.maxChain, 1);
  assert.equal(short.objects[1]?.resolvedType, 'blob');
  await assert.rejects(async () => mapPack(await ofsChain(33)), (err: { code?: string; message?: string }) => err.code === 'limit_exceeded' && /delta chain depth/.test(err.message ?? ''));
});

test('viewer fetch drops credentials, forces the user agent, and refuses a cross-host redirect', async () => {
  const headers = credentialFreeHeaders({ Authorization: 'Bearer no', Cookie: 'a=b', 'Git-Token': 't', 'Git-Protocol': 'version=2', 'User-Agent': 'python-requests/2' });
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('cookie'), null);
  assert.equal(headers.get('git-token'), null);
  assert.equal(headers.get('user-agent'), VIEWER_UA);
  assert.equal(headers.get('git-protocol'), 'version=2');
  const repo = loc('https://github.com/octocat/Hello-World');
  const seen: { url: string; authorization: string | null; cookie: string | null; ua: string | null }[] = [];
  const budget = createBudget();
  const fetchImpl = createViewerFetch(async (input, init) => {
    const h = new Headers(init?.headers);
    seen.push({ url: String(input), authorization: h.get('authorization'), cookie: h.get('cookie'), ua: h.get('user-agent') });
    const url = String(input);
    if (url.endsWith('/info/refs?service=git-upload-pack') && !url.includes('.git/')) {
      return new Response(null, { status: 301, headers: { location: 'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack' } });
    }
    if (url.includes('evil.example')) return new Response('no');
    return new Response('ok', { status: 200 });
  }, repo.url, repo.allowedHosts, budget, AbortSignal.timeout(1000));
  const ok = await fetchImpl('https://github.com/octocat/Hello-World/info/refs?service=git-upload-pack', { headers: { Authorization: 'Bearer leaked', Cookie: 'session=1' } });
  assert.equal(await ok.text(), 'ok');
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.url, 'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack');
  for (const hop of seen) {
    assert.equal(hop.authorization, null);
    assert.equal(hop.cookie, null);
    assert.equal(hop.ua, VIEWER_UA);
  }
  await assert.rejects(fetchImpl('https://github.com/octocat/Hello-World/info/refs?service=git-upload-pack&x=1'), (err: { code?: string }) => err.code === 'bad_request');
  const cross = createViewerFetch(async (input) => {
    if (String(input).includes('evil.example')) throw new Error('forwarded cross-host');
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/octocat/Hello-World/info/refs?service=git-upload-pack' } });
  }, repo.url, repo.allowedHosts, createBudget(), AbortSignal.timeout(1000));
  await assert.rejects(cross('https://github.com/octocat/Hello-World/info/refs?service=git-upload-pack'), (err: { code?: string; message?: string }) => err.code === 'bad_request' && /not an allowlisted host/.test(err.message ?? ''));
  const otherForge = createViewerFetch(async (input) => {
    if (!String(input).includes('github.com/')) throw new Error(`followed redirect to ${String(input)}`);
    return new Response(null, { status: 302, headers: { location: 'https://gitlab.com/octocat/Hello-World/info/refs?service=git-upload-pack' } });
  }, repo.url, repo.allowedHosts, createBudget(), AbortSignal.timeout(1000));
  await assert.rejects(otherForge('https://github.com/octocat/Hello-World/info/refs?service=git-upload-pack'), (err: { code?: string; message?: string }) => err.code === 'bad_request' && /cross-host/.test(err.message ?? ''));
  const lookalike = createViewerFetch(async (input) => {
    if (String(input).includes('evil.com')) throw new Error('followed lookalike redirect');
    return new Response(null, { status: 302, headers: { location: 'https://github.com.evil.com/octocat/Hello-World/info/refs?service=git-upload-pack' } });
  }, repo.url, repo.allowedHosts, createBudget(), AbortSignal.timeout(1000));
  await assert.rejects(lookalike('https://github.com/octocat/Hello-World/info/refs?service=git-upload-pack'), (err: { code?: string; message?: string }) => err.code === 'bad_request' && /not an allowlisted host/.test(err.message ?? ''));
});

function fakeRate(): RateNamespace {
  const buckets = new Map<string, number[]>();
  return {
    idFromName: name => name,
    get: id => ({
      admit(bucket, now, lim, windowMs) {
        const key = `${String(id)}:${bucket}`;
        const list = (buckets.get(key) ?? []).filter(ts => ts > now - windowMs);
        if (list.length >= lim) return { ok: false, remaining: 0, retryAfterMs: 1000 };
        list.push(now);
        buckets.set(key, list);
        return { ok: true, remaining: lim - list.length, retryAfterMs: 0 };
      },
    }),
  };
}

function viewerEnv(extra: Record<string, string> = {}) {
  return { VIEWER_RATE: fakeRate(), PACK_CACHE: 'off', ...extra };
}

/** Dial a local git http-backend while the viewer only ever validates an allowlisted https URL. */
function rewriteAllowlisted(localBase: string, publicHost = 'github.com'): typeof fetch {
  const local = new URL(localBase);
  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw);
    if (u.hostname !== publicHost) throw new Error(`refusing to dial ${u.hostname}`);
    u.protocol = local.protocol;
    u.hostname = local.hostname;
    u.port = local.port;
    const res = await fetch(u, init);
    const location = res.headers.get('location');
    if (!location) return res;
    const next = new URL(location, u);
    if (next.hostname === local.hostname && next.port === local.port) {
      next.protocol = 'https:';
      next.hostname = publicHost;
      next.port = '';
      const headers = new Headers(res.headers);
      headers.set('location', next.href);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    return res;
  };
}

test('viewer reads a local public repo, escapes hostile names, and never forwards credentials', async () => {
  const { root, cleanup } = tmpRoot();
  const srv = await startGitServer(root);
  try {
    const name = 'demo';
    const bare = makeBareRepo(root, name);
    const work = join(root, 'work');
    mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    const head = commitFiles(work, bare, { 'README.md': 'hello viewer\n', 'pic.bin': Uint8Array.from([0, 1, 2, 255]), '<script>.txt': 'nope\n' }, 'seed <script>alert(1)</script>');
    git(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '--allow-empty', '-q', '-m', 'second']);
    git(work, ['push', '-q', bare, 'HEAD:refs/heads/main']);
    const seen: { authorization: string | null; cookie: string | null; gitToken: string | null; ua: string | null }[] = [];
    const dial = rewriteAllowlisted(srv.url);
    let rayN = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const h = new Headers(init?.headers);
      seen.push({ authorization: h.get('authorization'), cookie: h.get('cookie'), gitToken: h.get('git-token'), ua: h.get('user-agent') });
      const res = await dial(input, init);
      const headers = new Headers(res.headers);
      headers.set('cf-ray', `${(++rayN).toString(16).padStart(16, '0')}-IAD`);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    };
    const env = viewerEnv();
    const repoPath = `/view/github.com/${name}.git`;
    const page = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}`, {
      headers: { authorization: 'Bearer viewer-should-ignore', cookie: 'session=secret', 'git-token': 'git-secret', 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'ray-test' },
    }), env, {}, { fetchImpl });
    assert.equal(page.status, 200, await page.clone().text());
    const html = await page.text();
    assert.match(html, /README\.md/);
    assert.match(html, /hello viewer/);
    assert.equal(html.includes('127.0.0.1'), false);
    assert.match(html, /refs\/heads\/main/);
    assert.match(html, /upload-pack/);
    assert.match(html, /ray-test/);
    assert.equal(html.includes('<script>alert'), false);
    assert.match(html, /&lt;script&gt;/);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'none'/);
    assert.equal((page.headers.get('content-security-policy') ?? '').includes('unsafe-inline'), false);
    assert.match(page.headers.get('content-security-policy') ?? '', /style-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const rayHeader = page.headers.get('x-artifacts-ray') ?? '';
    assert.match(rayHeader, /ls-refs=[0-9a-f]{16}-IAD;dur=\d+/);
    assert.match(page.headers.get('server-timing') ?? '', /ls-refs;dur=\d+/);
    assert.match(page.headers.get('server-timing') ?? '', /total;dur=\d+/);
    for (const secret of ['127.0.0.1', 'viewer-should-ignore', 'git-secret', 'github.com', 'session=secret']) assert.equal(rayHeader.includes(secret), false, secret);
    assert.equal(html.includes('viewer-should-ignore'), false);
    assert.equal(html.includes('git-secret'), false);
    assert.ok(seen.length > 0);
    for (const hop of seen) {
      assert.equal(hop.authorization, null);
      assert.equal(hop.cookie, null);
      assert.equal(hop.gitToken, null);
      assert.equal(hop.ua, VIEWER_UA);
    }
    const alias = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?at=v99.0.0`), env, {}, { fetchImpl });
    assert.equal(alias.status, 302);
    assert.equal(alias.headers.get('location'), `${repoPath}?ref=v99.0.0`);
    const missingRef = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?ref=v99.0.0`), env, {}, { fetchImpl });
    assert.equal(missingRef.status, 404);
    const missingHtml = await missingRef.text();
    assert.match(missingHtml, /No ref v99\.0\.0 in demo/);
    assert.match(missingHtml, /ref picker/);
    assert.match(missingHtml, /href="\/view\/github\.com\/demo\.git\?ref=refs\/heads\/main"/);
    assert.equal(missingHtml.includes('Check the owner'), false);
    assert.doesNotMatch(missingHtml, /HTTP 401|answers 401/); // not a bare '401': request ids and timings on the page can contain it
    assert.match(missingHtml, /href="\/view\/github\.com\/demo\.git"/);
    const missingPath = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?path=missing`), env, {}, { fetchImpl });
    assert.equal(missingPath.status, 404);
    const missingPathHtml = await missingPath.text();
    assert.match(missingPathHtml, /No path missing in demo/);
    assert.match(missingPathHtml, /No entry named missing/);
    assert.match(missingPathHtml, /the repository root/);
    assert.doesNotMatch(missingPathHtml, /HTTP 401|answers 401/); // not a bare '401': request ids and timings on the page can contain it
    const fileAsDir = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?path=README.md/extra`), env, {}, { fetchImpl });
    assert.equal(fileAsDir.status, 404);
    const fileAsDirHtml = await fileAsDir.text();
    assert.match(fileAsDirHtml, /README\.md is a file, not a directory/);
    assert.match(fileAsDirHtml, /the repository root/);
    const tip = git(bare, ['rev-parse', 'refs/heads/main']).trim();
    const short = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?ref=${tip.slice(0, 8)}`), env, {}, { fetchImpl });
    assert.equal(short.status, 200, await short.clone().text());
    const file = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?ref=main&path=README.md`), env, {}, { fetchImpl });
    assert.equal(file.status, 200);
    const fileHtml = await file.text();
    assert.match(fileHtml, /class="ln"/);
    assert.match(fileHtml, /id="L1"/);
    assert.match(fileHtml, /hello viewer/);
    assert.match(fileHtml, /Wrap lines/);
    assert.match(fileHtml, /class="code"/);
    const raw = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?path=README.md&raw=1`), env, {}, { fetchImpl });
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(await raw.text(), 'hello viewer\n');
    const bin = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?path=pic.bin&raw=1`), env, {}, { fetchImpl });
    assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(new Uint8Array(await bin.arrayBuffer()), new Uint8Array([0, 1, 2, 255]));
    const pack = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?want=${head}&filter=tree:0`), env, {}, { fetchImpl });
    assert.equal(pack.status, 200);
    const packHtml = await pack.text();
    assert.match(packHtml, /Pack map/);
    assert.match(packHtml, /ofs-delta/);
    assert.equal(packHtml.includes('style='), false);
    const css = await handleViewer(new Request('https://ply.ivar.workers.dev/view.css'), env, {});
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    const home = await handleViewer(new Request('https://ply.ivar.workers.dev/view'), env, {});
    assert.equal(home.headers.get('x-ply-trace'), null);
    assert.match(home.headers.get('x-ply-build') ?? '', /^ply=/);
    const homeHtml = await home.text();
    assert.match(homeHtml, /octocat\/Hello-World/);
    assert.match(homeHtml, /bitbucket\.org/);
    assert.match(homeHtml, /git\.sr\.ht/);
    assert.equal(homeHtml.includes('artifacts.cloudflare.net'), false);
    const redir = await handleViewer(new Request(`https://ply.ivar.workers.dev/view?remote=${encodeURIComponent(`https://github.com/${name}.git`)}`), env, {});
    assert.equal(redir.status, 302);
    assert.equal(redir.headers.get('location'), `/view/github.com/${name}.git`);
    const localRemote = await handleViewer(new Request(`https://ply.ivar.workers.dev/view?remote=${encodeURIComponent(`${srv.url}/${name}.git`)}`), env, {});
    assert.equal(localRemote.status, 400);
    const localHtml = await localRemote.text();
    assert.match(localHtml, /Supported hosts/);
    assert.equal(localHtml.includes('127.0.0.1'), false);
    const extra = await handleViewer(new Request(`https://ply.ivar.workers.dev/view?remote=${encodeURIComponent('https://acct.artifacts.cloudflare.net/git/ns/repo.git')}`), viewerEnv({ VIEWER_EXTRA_HOSTS: 'acct.artifacts.cloudflare.net' }), {});
    assert.equal(extra.status, 302);
    assert.equal(extra.headers.get('location'), '/view/acct.artifacts.cloudflare.net/git/ns/repo.git');
    const wildcard = await handleViewer(new Request(`https://ply.ivar.workers.dev/view?remote=${encodeURIComponent('https://acct.artifacts.cloudflare.net/git/ns/repo.git')}`), viewerEnv({ VIEWER_EXTRA_HOSTS: '*.artifacts.cloudflare.net' }), {});
    assert.equal(wildcard.status, 400);
    const secret = await handleViewer(new Request('https://ply.ivar.workers.dev/view?remote=https://github.com/a/b&token=super-secret-token'), env, {});
    assert.equal(secret.status, 400);
    assert.equal((await secret.text()).includes('super-secret-token'), false);
    const ssrf = await handleViewer(new Request('https://ply.ivar.workers.dev/view/169.254.169.254/latest'), env, {}, { fetchImpl: async () => { throw new Error('ssrf fetched'); } });
    assert.equal(ssrf.status, 400);
    assert.match(await ssrf.text(), /Supported hosts: github.com, gitlab.com, codeberg.org, bitbucket.org, git.sr.ht/);
    const hostile = await handleViewer(new Request(`https://ply.ivar.workers.dev${repoPath}?path=${encodeURIComponent('<script>alert(1)<script>')}`), env, {}, { fetchImpl });
    assert.equal(hostile.status, 404);
    const hostileHtml = await hostile.text();
    assert.equal(hostileHtml.includes('<script>alert'), false);
    assert.match(hostileHtml, /&lt;script&gt;/);
  } finally {
    await srv.close();
    cleanup();
  }
});

test('a tree:0 rejection is visible, then the blob:none retry, and a denied rate limit does no fetch', async () => {
  const { root, cleanup } = tmpRoot();
  const upstream = await startGitServer(root);
  const filterOf = (body: Uint8Array) => /filter ([^\n]+)\n/.exec(Buffer.from(body).toString('latin1'))?.[1] ?? null;
  const proxy = await startProxy(upstream.url, (ctx: { stage: string; reqBody: Uint8Array }) => (
    ctx.stage === 'fetch' && filterOf(ctx.reqBody) && filterOf(ctx.reqBody) !== 'blob:none'
      ? { type: 'status', status: 400, contentType: 'text/plain', body: 'Unsupported Git fetch filter; only blob:none is supported.' }
      : { type: 'pass' }
  ));
  try {
    const bare = makeBareRepo(root, 'art');
    const work = join(root, 'art-work');
    mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { 'README.md': 'artifacts-shaped\n' }, 'one');
    // Twelve commits, each touching its own directory, so a blob:none window carries trees as well as commits.
    const subjects = ['one'];
    for (let n = 2; n <= 12; n++) { subjects.push(`commit ${n}`); commitFiles(work, bare, { [`d${n}/f.txt`]: `${n}\n` }, `commit ${n}`); }
    let fetches = 0;
    const bodies: string[] = [];
    const dial = rewriteAllowlisted(proxy.url);
    const fetchImpl: typeof fetch = async (input, init) => {
      fetches++;
      if (init?.body) bodies.push(Buffer.from(init.body as Uint8Array).toString('latin1'));
      return dial(input, init);
    };
    const env = viewerEnv();
    const res = await handleViewer(new Request('https://ply.ivar.workers.dev/view/github.com/art.git', { headers: { 'cf-connecting-ip': '203.0.113.10' } }), env, {}, { fetchImpl });
    assert.equal(res.status, 200, await res.clone().text());
    const html = await res.text();
    assert.match(html, /filter tree:0 was rejected/);
    assert.match(html, /<span class="num wf-status" role="cell">400<\/span>/);
    assert.match(html, /blob:none/);
    // The log fix: on a server that refuses tree:0, Recent commits used to stop after one commit ("Log stopped").
    // One fetch (want HEAD, deepen 10, blob:none after the 400) now carries the whole first-parent window.
    const shown = [...html.matchAll(/<span class="log-subject">([^<]*)<\/span>/g)].map(m => m[1]);
    assert.deepEqual(shown, subjects.slice().reverse().slice(0, VIEWER_CAPS.maxLogCommits));
    assert.equal(html.includes('Log stopped'), false);
    const fetchBodies = bodies.filter(body => body.includes('command=fetch'));
    // tree:0 window (400) + blob:none window + README blob. No per-commit fetches.
    assert.equal(fetchBodies.length, 3, fetchBodies.join('\n---\n'));
    assert.equal(fetchBodies.filter(body => body.includes(`deepen ${VIEWER_CAPS.maxLogCommits}`)).length, 2);
    assert.ok(fetches <= 5, `fetches ${fetches}`);
    const limited = fakeRate();
    let called = 0;
    const denyEnv = { VIEWER_RATE: limited, PACK_CACHE: 'off', VIEWER_RATE_PER_MIN: '1' };
    const first = await handleViewer(new Request('https://ply.ivar.workers.dev/view', { headers: { 'cf-connecting-ip': '203.0.113.11' } }), denyEnv, {}, { fetchImpl: async () => { called++; throw new Error('no'); }, now: 1_000 });
    assert.equal(first.status, 200);
    const second = await handleViewer(new Request('https://ply.ivar.workers.dev/view/github.com/art.git', { headers: { 'cf-connecting-ip': '203.0.113.11' } }), denyEnv, {}, { fetchImpl: async () => { called++; throw new Error('fetched while limited'); }, now: 1_500 });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '1');
    assert.match(await second.text(), /Too many requests/);
    assert.equal(called, 0);
    assert.ok(fetches > 0);
    const missing = await handleViewer(new Request('https://ply.ivar.workers.dev/view'), {}, {});
    assert.equal(missing.status, 503);
  } finally {
    await proxy.close();
    await upstream.close();
    cleanup();
  }
});

const WORKERD = [process.env.WORKERD, fileURLToPath(new URL('../node_modules/.bin/workerd', import.meta.url))].filter((p): p is string => !!p && existsSync(p));

test('workerd: sqlite rate limit, and /v1 still requires the bearer', { skip: WORKERD.length === 0 && 'workerd not installed' }, async () => {
  const { root, cleanup } = tmpRoot();
  const out = join(root, 'wk');
  mkdirSync(out);
  copyCfBundle(join(out, 'worker.mjs'));
  const port = 19100 + (process.pid % 40);
  const ply = 'test-ply-token-' + 'x'.repeat(20);
  writeFileSync(join(out, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = (
    modules = [ (name = "worker.mjs", esModule = embed "worker.mjs") ],
    compatibilityDate = "2026-10-18",
    durableObjectNamespaces = [ (className = "ViewerRateLimit", uniqueKey = "viewer-rate-test", enableSql = true) ],
    durableObjectStorage = (inMemory = void),
    bindings = [
      (name = "PLY_TOKEN", text = "${ply}"),
      (name = "WRITES", text = "off"),
      (name = "PACK_CACHE", text = "off"),
      (name = "VIEWER_RATE_PER_MIN", text = "2"),
      (name = "VIEWER_RATE", durableObjectNamespace = "ViewerRateLimit")
    ]
  )), (name = "internet", network = (allow = ["private", "public", "local"])) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ]
);
`);
  let logs = '';
  const proc = spawn(WORKERD[0] as string, ['serve', join(out, 'config.capnp'), '--verbose'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => { logs += d; });
  proc.stderr.on('data', d => { logs += d; });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.equal(up, true, logs.slice(-1500));
    const hit = (ip: string) => fetch(`http://127.0.0.1:${port}/view`, { headers: { 'cf-connecting-ip': ip } });
    assert.equal((await hit('198.51.100.8')).status, 200);
    assert.equal((await hit('198.51.100.8')).status, 200);
    const limited = await hit('198.51.100.8');
    const limitedBody = await limited.text();
    assert.equal(limited.status, 429, `${limitedBody}\n${logs.slice(-2000)}`);
    assert.equal((await hit('198.51.100.9')).status, 200);
    const blocked = await fetch(`http://127.0.0.1:${port}/view/127.0.0.1/latest/meta-data`);
    assert.equal(blocked.status, 400);
    const blockedHtml = await blocked.text();
    assert.match(blockedHtml, /Supported hosts: github.com, gitlab.com, codeberg.org, bitbucket.org, git.sr.ht/);
    const gated = await fetch(`http://127.0.0.1:${port}/v1/refs?remote=${encodeURIComponent('https://github.com/octocat/Hello-World.git')}`);
    assert.equal(gated.status, 401);
    const leaked = await fetch(`http://127.0.0.1:${port}/view/user:super-secret-token@github.com/octocat/Hello-World`);
    assert.equal(leaked.status, 400);
    assert.equal((await leaked.text()).includes('super-secret-token'), false);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(logs.includes('super-secret-token'), false);
  } finally {
    if (proc.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } }
    else proc.kill('SIGKILL');
    cleanup();
  }
});

test('a public GitHub repository renders when the network can reach it', { timeout: 40_000 }, async (t) => {
  const probe = await fetch('https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack', {
    headers: { 'git-protocol': 'version=2', 'user-agent': VIEWER_UA },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!probe?.ok) {
    await probe?.body?.cancel().catch(() => {});
    return t.skip('GitHub is unreachable from this environment');
  }
  await probe.arrayBuffer();
  const env = { VIEWER_RATE: fakeRate(), PACK_CACHE: 'off' };
  const res = await handleViewer(new Request('https://ply.ivar.workers.dev/view/github.com/octocat/Hello-World', { headers: { 'cf-connecting-ip': '203.0.113.50', 'cf-ray': 'github-ray' } }), env, {});
  assert.equal(res.status, 200, await res.clone().text());
  const html = await res.text();
  assert.match(html, /Hello-World/);
  assert.match(html, /upload-pack/);
  assert.match(html, /github-ray/);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'none'/);
  assert.equal((res.headers.get('content-security-policy') ?? '').includes('unsafe-inline'), false);
  const want = /[0-9a-f]{40}/.exec(html)?.[0];
  assert.ok(want);
  const pack = await handleViewer(new Request(`https://ply.ivar.workers.dev/view/github.com/octocat/Hello-World?want=${want}&filter=blob:none`), env, {});
  assert.equal(pack.status, 200, await pack.clone().text());
  const packHtml = await pack.text();
  assert.match(packHtml, /Pack map/);
  assert.match(packHtml, /agent /);
});

// ply (since #26) never follows a redirect: any 3xx reaching it is an `http` error. The viewer's documented behaviour is
// that createViewerFetch follows same-repo redirects itself (manual, ≤ VIEWER_CAPS.maxRedirects hops, re-validated), so ply
// only ever sees the final response. This pins both halves against a real git http-backend.
test('same-repo redirects are resolved by the viewer fetch before ply sees them; ply alone refuses them', async () => {
  const { root, cleanup } = tmpRoot();
  const srv = await startGitServer(root);
  try {
    const name = 'moved';
    const bare = makeBareRepo(root, name);
    const work = join(root, 'work');
    mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    const head = commitFiles(work, bare, { 'README.md': 'redirected\n' }, 'seed');
    const dial = rewriteAllowlisted(srv.url);
    // The host answers `/moved/...` (GET advertisement and POST upload-pack alike) with a 301 to `/moved.git/...`.
    const hops: { method: string; url: string; status: number }[] = [];
    const redirecting: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = init?.method ?? 'GET';
      if (url.pathname.startsWith(`/${name}/`)) {
        hops.push({ method, url: url.href, status: 301 });
        return new Response(null, { status: 301, headers: { location: url.href.replace(`/${name}/`, `/${name}.git/`) } });
      }
      const res = await dial(input, init);
      hops.push({ method, url: url.href, status: res.status });
      return res;
    };
    const expected = git(bare, ['rev-parse', 'refs/heads/main']).trim();
    assert.equal(expected, head);

    // ply alone: the 301 is a typed http error naming where the server pointed; nothing is followed.
    hops.length = 0;
    const bareTransport = createTransport(`https://github.com/${name}`, { fetchImpl: redirecting, limits: VIEWER_GIT_LIMITS, tracer: new Tracer() });
    await assert.rejects(lsRefs(bareTransport, ['refs/heads/']), (err: { code?: string; status?: number; location?: string; message?: string }) =>
      err.code === 'http' && err.status === 301 && err.location === `https://github.com/${name}.git/git-upload-pack` && /does not follow redirects/.test(err.message ?? ''));
    assert.deepEqual(hops.map(h => h.status), [301]);

    // Through createViewerFetch: every request is redirected once and then answered; ply gets the refs.
    hops.length = 0;
    const guarded = createViewerFetch(redirecting, loc(`https://github.com/${name}`).url, ALLOWED_HOSTS, createBudget(), AbortSignal.timeout(10_000));
    const t = createTransport(`https://github.com/${name}`, { fetchImpl: guarded, limits: VIEWER_GIT_LIMITS, tracer: new Tracer() });
    const { refs } = await lsRefs(t, ['refs/heads/']);
    assert.equal(refs.get('refs/heads/main')?.oid, expected);
    assert.ok(hops.some(h => h.method === 'POST' && h.status === 301), 'the POST was redirected too');
    for (let i = 0; i < hops.length; i += 2) {
      assert.equal(hops[i]?.status, 301);
      assert.equal(hops[i + 1]?.status, 200);
      assert.equal(hops[i + 1]?.method, hops[i]?.method, 'a redirect keeps the method');
      assert.equal(hops[i + 1]?.url, hops[i]?.url.replace(`/${name}/`, `/${name}.git/`));
    }

    // End to end: /view on the redirecting spelling renders the repository.
    const page = await handleViewer(new Request(`https://ply.ivar.workers.dev/view/github.com/${name}?path=README.md`), viewerEnv(), {}, { fetchImpl: redirecting });
    assert.equal(page.status, 200, await page.clone().text());
    assert.match(await page.text(), /redirected/);

    // A redirect loop is cut at the hop cap by the viewer fetch, not handed to ply.
    let loops = 0;
    const loop = createViewerFetch(async () => { loops++; return new Response(null, { status: 302, headers: { location: `https://github.com/${name}/info/refs?service=git-upload-pack` } }); }, loc(`https://github.com/${name}`).url, ALLOWED_HOSTS, createBudget(), AbortSignal.timeout(1000));
    await assert.rejects(lsRefs(createTransport(`https://github.com/${name}`, { fetchImpl: loop, limits: VIEWER_GIT_LIMITS, tracer: new Tracer() }), ['refs/heads/']), (err: { code?: string; message?: string }) => err.code === 'bad_request' && /too many redirects/.test(err.message ?? ''));
    assert.equal(loops, VIEWER_CAPS.maxRedirects + 1);
  } finally {
    await srv.close();
    cleanup();
  }
});


test('history in one call: on a tree:0 server the page fetches the head and its parents with one deepen fetch', async () => {
  const { root, cleanup } = tmpRoot();
  const srv = await startGitServer(root);
  try {
    const bare = makeBareRepo(root, 'hist');
    const work = join(root, 'w-hist');
    mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { 'README.md': 'history\n' }, 'subject-0');
    for (let i = 1; i <= 6; i++) {
      git(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '--allow-empty', '-q', '-m', `subject-${i}`]);
    }
    git(work, ['push', '-q', bare, 'HEAD:refs/heads/main']);
    const calls: { method: string; body: string }[] = [];
    const dial = rewriteAllowlisted(srv.url);
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ method: init?.method ?? 'GET', body: init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('latin1') : '' });
      return dial(input, init);
    };
    const page = await handleViewer(new Request('https://ply.ivar.workers.dev/view/github.com/hist.git'), viewerEnv(), {}, { fetchImpl });
    assert.equal(page.status, 200);
    const html = await page.text();
    for (let i = 6; i >= 2; i--) assert.match(html, new RegExp(`subject-${i}\\b`), `subject-${i} in the log`);
    const fetches = calls.filter(c => c.body.includes('command=fetch'));
    const history = fetches.filter(c => new RegExp(`deepen ${VIEWER_CAPS.maxLogCommits}\n`).test(c.body) && /filter tree:0\n/.test(c.body));
    assert.equal(history.length, 1, 'one history fetch');
    assert.equal(fetches.filter(c => /deepen 1\n/.test(c.body)).length, 0, 'no per-commit fetches');
    // discover + ls-refs + history + root tree + README blob
    assert.equal(calls.length, 5, calls.map(c => c.body.slice(4, 30)).join(' | '));
  } finally {
    await srv.close();
    cleanup();
  }
});

test('scraping contract: li[data-oid] rows equal git ls-tree, and the commit card carries data-commit', async () => {
  // External monitors (ply issue #44) count these rows and compare the oids to the forge's tree API.
  // A redesign may restyle anything, but must keep: li[data-oid][data-mode][data-type][data-name], ul.files[data-entries],
  // and [data-commit] on the latest-commit card. See README "Machine-readable markup".
  const { root, cleanup } = tmpRoot();
  const srv = await startGitServer(root);
  try {
    const bare = makeBareRepo(root, 'scrape');
    const work = join(root, 'w-scrape');
    mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    const files = { 'README.md': 'x\n', 'src/a.js': 'a\n', 'src/b.ts': 'b\n', 'src/run.sh': { data: '#!/bin/sh\n', mode: '100755' }, 'src/lib/c.js': 'c\n', 'src/lib/d/e.js': 'e\n' };
    const head = commitFiles(work, bare, files, 'seed');
    const dial = rewriteAllowlisted(srv.url);
    const page = await handleViewer(new Request('https://ply.ivar.workers.dev/view/github.com/scrape.git?path=src'), viewerEnv(), {}, { fetchImpl: dial });
    assert.equal(page.status, 200);
    const html = await page.text();
    const rows = [...html.matchAll(/<li data-oid="([0-9a-f]{40})" data-mode="([0-7]{6})" data-type="(blob|tree|commit)" data-name="([^"]*)">/g)]
      .map(m => `${m[2]} ${m[3]} ${m[1]}\t${m[4]}`).sort();
    const expected = git(bare, ['ls-tree', `${head}:src`]).trim().split('\n').sort();
    assert.deepEqual(rows, expected);
    assert.match(html, new RegExp(`<ul class="files"[^>]* data-path="src" data-entries="${expected.length}" data-shown="${expected.length}">`));
    assert.match(html, new RegExp(`data-commit="${head}"`));
    // The parent-directory row is not an entry.
    assert.equal([...html.matchAll(/<li data-oid=/g)].length, expected.length);
  } finally {
    await srv.close();
    cleanup();
  }
});

test('stylesheet URL is content-hashed and immutable; HTML is no-store and links the sheet it was rendered with', async () => {
  // 2026-10-31: an iPhone kept the old /view.css (max-age=3600) and rendered the redesigned markup unstyled.
  const env = viewerEnv();
  const home = await handleViewer(new Request('https://ply.ivar.workers.dev/view'), env, {});
  assert.equal(home.headers.get('cache-control'), 'no-store');
  const href = /<link rel="stylesheet" href="(\/view\.([0-9a-f]{12})\.css)"\/>/.exec(await home.text());
  assert.ok(href?.[1] && href[2], 'hashed stylesheet href');
  const sheet = await handleViewer(new Request(`https://ply.ivar.workers.dev${href[1]}`), env, {});
  assert.equal(sheet.status, 200);
  assert.equal(sheet.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const body = await sheet.text();
  // The href names the bytes actually served.
  assert.equal(new Sha1().update(new TextEncoder().encode(body)).digest().reduce((s: string, b: number) => s + b.toString(16).padStart(2, '0'), '').slice(0, 12), href[2]);
  assert.equal(body, VIEWER_CSS);
  // Old HTML (/view.css) and a previous deploy's hash get the current sheet, but must revalidate.
  for (const old of ['/view.css', '/view.000000000000.css']) {
    const res = await handleViewer(new Request(`https://ply.ivar.workers.dev${old}`), env, {});
    assert.equal(res.status, 200, old);
    assert.equal(res.headers.get('cache-control'), 'no-cache', old);
    assert.equal(await res.text(), VIEWER_CSS, old);
  }
  const revalidated = await handleViewer(new Request('https://ply.ivar.workers.dev/view.css', { headers: { 'if-none-match': `"${href[2]}"` } }), env, {});
  assert.equal(revalidated.status, 304);
  // Icons carry intrinsic sizes, so even an unstyled page never draws a giant SVG.
  const html = String(renderLoaded(treeFixture({}), { bars: [], totalMs: 0, cfRay: 'r', requestId: 'q' }));
  for (const m of html.matchAll(/<svg class="i [^"]*"([^>]*)>/g)) assert.match(m[1] ?? '', /width="16" height="16"/);
});
