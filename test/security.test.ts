// Markdown breakout, the /v1 remote policy, viewer dot-segments, and security headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { createGuardedFetch, decideRemote, isAllowedRemote, type AllowedRemote } from '../src/remote.ts';
import { classifyHref, renderMarkdown } from '../src/viewer/markdown.ts';
import { handleViewer } from '../src/viewer/handle.ts';
import { renderLoaded } from '../src/viewer/html.ts';
import { parseViewerRequest, routeOptsFromEnv } from '../src/viewer/route.ts';
import { viewerHref } from '../src/viewer/url.ts';
import type { Loaded, TraceModel } from '../src/viewer/model.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'xlink:href', 'srcset']);
const MARKDOWN_TAGS = new Set(['p', 'a', 'code', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'br', 'hr', 'h2', 'h3', 'h4', 'h5', 'h6']);
// Markdown output may carry only these attributes, with these values: the renderer never copies source text into one,
// except href (allowlisted, checked below), an integer `start`, and a heading id slug.
const MARKDOWN_CLASSES = new Set(['md-code', 'md-code-lang', 'md-table', 'task', 'task done', 'task-item', 'al-l', 'al-c', 'al-r', 'md-img', 'md-frontmatter']);
function markdownAttrOk(name: string, value: string): boolean {
  if (name === 'href') return true;
  if (name === 'rel') return value === 'noopener noreferrer nofollow';
  if (name === 'class') return MARKDOWN_CLASSES.has(value);
  if (name === 'start') return /^\d{1,9}$/.test(value);
  if (name === 'id') return /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
  return false;
}

function isElement(node: Node): node is Element {
  return node.nodeName !== '#text' && node.nodeName !== '#comment' && node.nodeName !== '#document-fragment' && node.nodeName !== '#document' && 'attrs' in node;
}

function walk(node: Node, tags: string[], attrs: { name: string; value: string }[]): void {
  if (isElement(node)) {
    tags.push(node.nodeName.toLowerCase());
    for (const attr of node.attrs) attrs.push({ name: attr.name.toLowerCase(), value: attr.value });
    for (const child of node.childNodes) walk(child, tags, attrs);
    return;
  }
  if ('childNodes' in node) for (const child of node.childNodes) walk(child, tags, attrs);
}

function scan(html: string): { tags: string[]; attrs: { name: string; value: string }[] } {
  const tags: string[] = [];
  const attrs: { name: string; value: string }[] = [];
  walk(parseFragment(html), tags, attrs);
  return { tags, attrs };
}

function assertHtmlSafe(html: string, where: string, markdown = false): void {
  const { tags, attrs } = scan(html);
  for (const tag of tags) {
    assert.equal(['script', 'style', 'iframe', 'object', 'embed', 'frame'].includes(tag), false, `${where} tag ${tag}`);
    if (markdown) assert.equal(MARKDOWN_TAGS.has(tag), true, `${where} unexpected ${tag}`);
  }
  for (const attr of attrs) {
    if (markdown) assert.equal(markdownAttrOk(attr.name, attr.value), true, `${where} markdown attribute ${attr.name}=${attr.value}`);
    assert.equal(attr.name.startsWith('on'), false, `${where} handler ${attr.name}=${attr.value}`);
    assert.equal(/^[-a-z0-9:]+$/.test(attr.name), true, `${where} attribute name ${attr.name}`);
    if (!URL_ATTRS.has(attr.name)) continue;
    let compact = '';
    for (const char of attr.value) {
      const code = char.codePointAt(0) ?? 0;
      if (code <= 0x1f || code === 0x7f || code === 0x20) continue;
      compact += char;
    }
    compact = compact.toLowerCase();
    assert.equal(/^(javascript|data|vbscript):/.test(compact), false, `${where} ${attr.name}=${attr.value}`);
  }
}

function mustAllow(raw: string, allow: readonly string[] = []): AllowedRemote {
  const decision = decideRemote(raw, allow);
  assert.equal(decision.kind, 'allowed', `${raw} -> ${decision.kind === 'rejected' ? decision.reason : ''}`);
  if (decision.kind !== 'allowed') throw new Error('unreachable');
  assert.equal(isAllowedRemote(decision.remote), true);
  return decision.remote;
}

function mustReject(raw: string, reason: string, allow: readonly string[] = []): void {
  const decision = decideRemote(raw, allow);
  assert.equal(decision.kind, 'rejected', raw);
  if (decision.kind === 'rejected') assert.equal(decision.reason, reason, raw);
}

test('markdown hrefs are escaped, scheme-allowlisted, and carry rel', () => {
  const cases = [
    'See [docs](https://example.com/" onfocus="alert(1)" autofocus="x) for more.',
    'x [y](https://e.com/"onclick=alert(1) x=") z',
    'x [y](https://e.com/"/><img/src=x onerror=alert(1)><x=") z',
    'x [y](https://e.com/\'onclick=alert(1)//) z',
    'See [x](https://e.com/"onclick=alert(1)) here',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](java\tscript:alert(1))',
    '[x](java\nscript:alert(1))',
    '[x](&#106;avascript:alert(1))',
    '[x](javascript&#58;alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '[x](vbscript:msgbox(1))',
    '[x](//evil.example/a)',
    '[x](/\\evil.example)',
  ];
  for (const src of cases) {
    const html = String(renderMarkdown(src));
    assertHtmlSafe(html, src, true);
    const { attrs } = scan(html);
    assert.equal(attrs.some(attr => attr.name === 'onfocus' || attr.name === 'onerror' || attr.name === 'onclick'), false, src);
    assert.equal(/href\s*=\s*["']?\s*javascript:/i.test(html), false, src);
  }
  const ok = String(renderMarkdown('[ok](https://github.com/octocat/Hello-World) and [mail](mailto:a@b.example) and [rel](/view)'));
  assert.match(ok, /href="https:\/\/github.com\/octocat\/Hello-World" rel="noopener noreferrer nofollow"/);
  assert.match(ok, /href="mailto:a@b\.example" rel="noopener noreferrer nofollow"/);
  assert.match(ok, /href="\/view" rel="noopener noreferrer nofollow"/);
  assert.equal(classifyHref('https://example.com/a?b=1&c=2'), 'https://example.com/a?b=1&c=2');
  const escaped = String(renderMarkdown('[q](https://example.com/a?b=1&c=2)'));
  assert.match(escaped, /href="https:\/\/example.com\/a\?b=1&amp;c=2"/);
  assertHtmlSafe(escaped, 'query', true);
});

test('hostile markdown, filenames, commits, refs, and authors do not break out of HTML', () => {
  const payloads = [
    '<script>alert(1)</script>', '<style>@import "javascript:alert(1)"</style>', '<iframe src="javascript:alert(1)">',
    '<object data="javascript:alert(1)">', '" onfocus="alert(1)" autofocus="', '\' onclick=alert(1) x=\'',
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:alert(1)',
    '&#106;avascript:alert(1)', '&#x6A;avascript:alert(1)', 'javascript&#58;alert(1)', 'javascript&#x3a;alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'livescript:alert(1)', 'blob:https://example.com/x',
    '//evil.example', '/\\evil.example', 'https://example.com/"onclick=alert(1)', 'https://e.com/"/><img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>', '`onclick`', '{{constructor.constructor("alert(1)")()}}', '%2e%2e/%2e%2e/secret',
    '..\\..\\windows', 'mailto:a@b.example', 'https://example.com/a?b=1&c=2', '../README', './README', '/view',
    'file:///etc/passwd', 'gopher://evil.example', 'dict://evil.example', ' &#9;javascript:alert(1)',
  ];
  const rand = mulberry(0x5ec);
  for (let n = 0; n < 40; n++) {
    const href = payloads[Math.floor(rand() * payloads.length)] ?? 'x';
    const label = payloads[Math.floor(rand() * payloads.length)] ?? 'y';
    const text = payloads[Math.floor(rand() * payloads.length)] ?? 'z';
    const shapes = [
      `# ${text}\n\n[${label}](${href})\n\n- ${text}\n- [${label}](${href})\n\n\`\`\`\n${text}\n\`\`\`\n\n**${text}** \`${label}\``,
      `paragraph ${text} [${label}](${href}) tail`,
      `## ${label}\n\n${text}`,
      // GFM: tables (with alignment), task lists, images, reference and auto links, quotes, fences with a hostile info string.
      `| ${label} | b |\n|:--|--:|\n| [${label}](${href}) | ${text} |\n| \`${text}\` | ![${label}](${href}) |`,
      `- [ ] ${text}\n- [x] [${label}](${href})\n  1. nested ${text}\n\n7. ${label}\n8. ${text}`,
      `[${label}][r] and [r] and <${href}> and ${href}\n\n[r]: ${href}`,
      `> ${text}\n> [${label}](${href})\n\n\`\`\`${label}\n${text}\n\`\`\``,
      `${text}\n===\n\n${label}\n---\n\n***\n\n~~${text}~~ _${label}_`,
    ];
    for (const src of shapes) {
      assertHtmlSafe(String(renderMarkdown(src)), `sample ${n}`, true);
      // A repository-relative resolver must not widen what reaches href either.
      assertHtmlSafe(String(renderMarkdown(src, { base: 'docs', resolve: (path, kind) => `/view/github.com/o/r?path=${encodeURIComponent(path)}${kind === 'image' ? '&raw=1' : ''}` })), `resolved ${n}`, true);
    }
  }
  const trace: TraceModel = { bars: [], totalMs: 0, cfRay: 'ray', requestId: 'id' };
  for (let n = 0; n < 20; n++) {
    const name = payloads[n % payloads.length] ?? 'file';
    const message = payloads[(n + 3) % payloads.length] ?? 'm';
    const author = payloads[(n + 7) % payloads.length] ?? 'a';
    const ref = `refs/heads/${payloads[(n + 11) % payloads.length] ?? 'main'}`.slice(0, 80);
    const loaded: Loaded = {
      kind: 'tree',
      header: {
        host: 'github.com', repoPath: 'o/r', ref, commit: 'a'.repeat(40),
        treeHref: '/view/github.com/o/r',
        server: { agent: author, protocol: 2, objectFormat: 'sha1', caps: ['agent'], fetchFeatures: ['filter'], filterAdvertised: true },
      },
      path: '',
      commit: {
        oid: 'a'.repeat(40), tree: 'b'.repeat(40), parents: [], authorName: author, authorEmail: 'a@b',
        authorTime: '2020-01-02T03:04:05Z', authorTz: '+0000', message, signed: false,
      },
      log: [], logStopped: false,
      branches: [{ name: ref, oid: 'a'.repeat(40), head: true }], branchesTruncated: 0,
      tags: [], tagsTruncated: 0,
      entries: [{ name, mode: '100644', oid: 'c'.repeat(40), type: 'blob' }], entriesTruncated: 0,
      readme: { name: 'README.md', text: `# ${name}\n\n[${author}](${message})\n` },
    };
    assertHtmlSafe(String(renderLoaded(loaded, trace)), `page ${n}`);
  }
});

test('checkRemote rejects a table of hostile URLs and brands the ones it allows', () => {
  const rejected: Array<[string, string]> = [];
  const push = (raw: string, reason: string) => rejected.push([raw, reason]);
  for (const host of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '0.0.0.0', '8.8.8.8', '255.255.255.255', '127.000.000.001', '0177.0.0.1', '0x7f.0.0.1', '127.1', '127.0.1']) {
    push(`https://${host}/x.git`, 'ip_literal');
  }
  for (const host of ['2130706433', '0x7f000001', '017700000001', '3232235777', '0xA9FEA9FE']) {
    push(`https://${host}/x.git`, 'ip_literal');
  }
  for (const host of ['[::1]', '[::]', '[fe80::1]', '[fd00::1]', '[fc00::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:169.254.169.254]', '[0:0:0:0:0:ffff:127.0.0.1]', '[::127.0.0.1]', '[::ffff:7f00:0001]']) {
    push(`https://${host}/x.git`, 'ip_literal');
  }
  for (const host of [
    '127.0.0.1.nip.io', '169.254.169.254.nip.io', 'app.10.0.0.1.nip.io', 'customer.127.0.0.1.nip.io', 'foo.nip.io', 'nip.io',
    '127.0.0.1.sslip.io', '127-0-0-1.sslip.io', '7f000001.sslip.io', 'sslip.io', 'foo.sslip.io',
    '127.0.0.1.xip.io', 'xip.io', 'localtest.me', 'foo.localtest.me', 'customer.localtest.me',
    'lvh.me', 'foo.lvh.me', 'vcap.me', 'foo.vcap.me', 'lacolhost.com', 'localho.st', 'foo.traefik.me', 'traefik.me',
    '10.0.0.1.example.com', '169.254.169.254.attacker.example',
  ]) {
    const reason = /(?:^|\.)(?:\d{1,3}\.){3}\d{1,3}(?:\.|$)/.test(host) ? 'ip_literal' : 'wildcard_dns';
    push(`https://${host}/x.git`, reason);
  }
  for (const host of ['github.com.', 'example.com.', 'localhost.', '127.0.0.1.', 'GitHub.com.']) push(`https://${host}/x.git`, 'trailing_dot');
  for (const host of ['localhost', 'foo.localhost', 'git.internal', 'metadata.google.internal', 'foo.local', 'intranet', 'foo.lan', 'bar.home.arpa', 'corp', 'foo.corp', 'private', 'foo.private', 'localdomain', 'foo.localdomain']) {
    const reason = host.includes('.') ? 'private_name' : 'single_label';
    push(`https://${host}/x.git`, reason);
  }
  push('http://example.com/x.git', 'scheme');
  push('http://github.com/x.git', 'scheme');
  push('ftp://github.com/x.git', 'scheme');
  push('file:///etc/passwd', 'scheme');
  push('https://github.com:8443/x.git', 'port');
  push('https://github.com:444/x.git', 'port');
  push('https://user:pw@github.com/x.git', 'userinfo');
  push('https://token@github.com/x.git', 'userinfo');
  push('https://github.com/x.git?a=b', 'query');
  push('https://github.com/x.git#frag', 'fragment');
  push('https://github.com/a/../../b.git', 'bad_path');
  push('https://github.com/a/%2e%2e/b.git', 'bad_path');
  push('https://github.com/a/%2E%2E/%2e%2e/evil.com/x.git', 'bad_path');
  push('https://github.com/a/%2f../b.git', 'bad_path');
  push('https://github.com/a/%5c..%5csecret.git', 'bad_path');
  push('https://github.com/a/./b.git', 'bad_path');
  push('https://github.com/a\\b.git', 'control');
  push('not-a-url', 'not_url');
  push('', 'empty');
  push('   ', 'empty');
  push(`https://example.com/${'a'.repeat(2100)}`, 'too_long');
  push('https://github.com/a b.git', 'control');
  push('https://github .com/a.git', 'control');
  push('https://0/x.git', 'ip_literal');
  push('https://127.0.0.0/x.git', 'ip_literal');
  push('https://[ff02::1]/x.git', 'ip_literal');
  push('https://0177.0.0.01/x.git', 'ip_literal');
  push('https://0x7f.0.0.01/x.git', 'ip_literal');
  push('https://foo.xip.io/x.git', 'wildcard_dns');
  assert.ok(rejected.length >= 100, `expected >= 100 hostile URLs, got ${rejected.length}`);
  for (const [raw, reason] of rejected) mustReject(raw, reason);

  const github = mustAllow('https://GitHub.com/Foo/Bar');
  assert.equal(github.href, 'https://github.com/Foo/Bar');
  assert.equal(github.hostname, 'github.com');
  assert.equal(mustAllow('https://example.com/a/b.git').origin, 'https://example.com');
  const local = mustAllow('http://127.0.0.1:9/r.git', ['http://127.0.0.1:9']);
  assert.equal(local.origin, 'http://127.0.0.1:9');
  mustReject('http://127.0.0.1:9/r.git', 'scheme');
  mustReject('https://user:pw@127.0.0.1:9/r.git', 'userinfo', ['http://127.0.0.1:9']);
});

test('guarded fetch re-validates every redirect hop and stays on the allowed origin', async () => {
  const remote = mustAllow('https://github.com/acme/widgets.git');
  const seen: { url: string; redirect: string | undefined }[] = [];
  const good = createGuardedFetch(async (input, init) => {
    const url = String(input);
    seen.push({ url, redirect: init?.redirect });
    if (url === 'https://github.com/acme/widgets/info/refs?service=git-upload-pack') {
      return new Response(null, { status: 302, headers: { location: 'https://github.com/acme/widgets.git/info/refs?service=git-upload-pack' } });
    }
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  }, remote, []);
  const res = await good('https://github.com/acme/widgets/info/refs?service=git-upload-pack', { method: 'GET' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(seen.map(hop => hop.redirect), ['manual', 'manual']);
  assert.equal(seen[1]?.url, 'https://github.com/acme/widgets.git/info/refs?service=git-upload-pack');

  for (const location of [
    'https://127.0.0.1.nip.io/latest',
    'https://169.254.169.254/latest',
    'https://github.com.evil.com/acme/widgets.git/info/refs?service=git-upload-pack',
    'https://evil.example/acme/widgets.git/info/refs',
    'https://github.com/acme/../../other/secret.git/info/refs?service=git-upload-pack',
    'https://github.com./acme/widgets.git/info/refs?service=git-upload-pack',
    '../secret.git/info/refs?service=git-upload-pack',
    'https://github.com/acme/%2e%2e/secret.git/info/refs',
    'http://github.com/acme/widgets.git/info/refs?service=git-upload-pack',
  ]) {
    let hops = 0;
    const fetchImpl = createGuardedFetch(async () => {
      hops++;
      return new Response(null, { status: 302, headers: { location } });
    }, remote, []);
    await assert.rejects(() => fetchImpl(`${remote.href}/info/refs?service=git-upload-pack`), (err: { code?: string }) => err.code === 'bad_request');
    assert.equal(hops, 1, location);
  }

  assert.throws(() => createGuardedFetch(async () => new Response('x'), { href: 'https://evil.example', origin: 'https://evil.example', hostname: 'evil.example', host: 'evil.example' } as AllowedRemote));
});

test('viewer paths reject dot segments and encoded separators before normalization', () => {
  const opts = routeOptsFromEnv({});
  const collapsed = new URL('https://ply.example/view/github.com/a/%2e%2e/%2e%2e/evil.com/x/y');
  assert.equal(collapsed.pathname, '/view/evil.com/x/y');
  const hostile = [
    'https://ply.example/view/github.com/a/../../evil.com/o/r',
    'https://ply.example/view/github.com/a/%2e%2e/%2e%2e/evil.com/x/y',
    'https://ply.example/view/github.com/a/%2E%2E/b',
    'https://ply.example/view/github.com/./octocat/Hello-World',
    'https://ply.example/view/github.com/%2e/octocat/Hello-World',
    'https://ply.example/view/github.com/a/%2f../b',
    'https://ply.example/view/github.com/a%5c..%5c..%5cevil',
    'https://ply.example/view/github.com/octocat/Hello-World?path=../secret',
    'https://ply.example/view/github.com/octocat/Hello-World?path=%2e%2e%2fsecret',
    'https://ply.example/view/github.com/octocat/Hello-World?path=foo%5cbar',
    'https://github.com/a/../../b',
  ];
  for (const raw of hostile) {
    assert.throws(() => parseViewerRequest(raw, opts), /not allowed|not a viewer/, raw);
  }
  for (const raw of ['https://ply.example/view/github.com/o/r?path=a%2Fb%2Fc', 'https://ply.example/view/github.com/o/r?path=a/b/c']) {
    const nested = parseViewerRequest(raw, opts);
    assert.equal(nested.kind === 'repo' && nested.path, 'a/b/c', raw);
  }
  for (const raw of ['https://ply.example/view/github.com/o/r?path=a%2F..%2Fb', 'https://ply.example/view/github.com/o/r?path=a%2F%2e%2e%2Fb', 'https://ply.example/view/github.com/o/r?path=a%2F%5Cb']) {
    assert.throws(() => parseViewerRequest(raw, opts), /not allowed|not a valid|path/, raw);
  }
  assert.equal(viewerHref('github.com', 'o/r', { ref: 'refs/heads/main', path: 'a/b c/d' }), '/view/github.com/o/r?ref=refs/heads/main&path=a/b+c/d');
  const ok = parseViewerRequest('https://ply.example/view/github.com/octocat/Hello-World?path=README.md', opts);
  assert.equal(ok.kind, 'repo');
  if (ok.kind === 'repo') assert.equal(ok.path, 'README.md');
  assert.throws(() => parseViewerRequest('https://ply.example/view?remote=' + encodeURIComponent('https://github.com/a/../../b'), opts), /not allowed/);
});

test('security headers are present on every viewer route', async () => {
  const routes = [
    'https://ply.example/view',
    'https://ply.example/view/',
    'https://ply.example/view.css',
    'https://ply.example/view/evil.example/a/b',
    'https://ply.example/view/github.com/a/%2f../b',
    'https://ply.example/view?remote=' + encodeURIComponent('https://evil.example/a/b'),
  ];
  for (const url of routes) {
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await handleViewer(new Request(url, { method }), {});
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${method} ${url}`);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${method} ${url}`);
      assert.match(csp, /frame-ancestors 'none'/, `${method} ${url}`);
      assert.match(csp, /script-src 'none'/, `${method} ${url}`);
      assert.equal(csp.includes('unsafe-inline'), false, `${method} ${url}`);
      await res.arrayBuffer();
    }
  }
  const post = await handleViewer(new Request('https://ply.example/view', { method: 'POST' }), {});
  assert.equal(post.status, 405);
  assert.match(post.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal((post.headers.get('content-security-policy') ?? '').includes('unsafe-inline'), false);
});

function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
