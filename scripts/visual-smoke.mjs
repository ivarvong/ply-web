// Post-deploy visual smoke: headless Chrome over the raw DevTools protocol (Node's global WebSocket; no puppeteer).
// Loads the viewer at 375×812 and 1280×800 in light and dark mode and fails (exit 1) when a page looks broken:
//   - an SVG wider than 64 px (icons render at 16 px; an unstyled page draws them at 300 px),
//   - horizontal page overflow,
//   - no stylesheet with rules applied, or an icon whose computed width is not 16 px,
//   - a stylesheet href that is not the content-hashed /view.<hash>.css (a stale cached sheet could pair with new HTML),
//   - a tree page with no li[data-oid] rows (the scraping contract, README "Machine-readable markup"),
//   - a footer build token (ply=…, ply-web=…) broken across lines, an error-page headline that starts lowercase, or a
//     missing-repo page whose "Repository root" link points back at the missing repo.
// Default pages: home, /r/ply, a file, the /r index, and the failure pages (missing repo/ref/path, missing GitHub repo).
// STALE_CSS=<file> fulfils every request for STALE_CSS_URL (default <base>/view.css) with that file, which is what a
// browser that cached an old unversioned sheet does. A hashed href never hits it, so the run must still pass.
//
// usage: node scripts/visual-smoke.mjs [base=https://ply.ivar.workers.dev] [outdir=<tmp>] [-- url ...]
// env:   CHROME (default: macOS Google Chrome), STALE_CSS, STALE_CSS_URL,
//        PLY_VERSION=<version id>: every request carries Cloudflare-Workers-Version-Overrides: ply="<id>" (a 0% canary).
// The last line lists every x-ply-request-id the Worker answered with (requestIds) and, per request, the x-ply-version that
// answered it (requests: [{ id, version, url }], read by the telemetry gate); with PLY_VERSION, a
// response from another version (x-ply-version) fails the run.
// Run after a deploy, next to `npm run cd -- smoke --version <id>`.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dash = args.indexOf('--');
const [base = 'https://ply.ivar.workers.dev', outdirArg] = dash === -1 ? args : args.slice(0, dash);
const outdir = outdirArg ?? mkdtempSync(join(tmpdir(), 'ply-visual-'));
mkdirSync(outdir, { recursive: true });
const PUBLIC = '5ad2236b39de4c8bd8f6270ea63f3ea9.artifacts.cloudflare.net/git/public-v0';
const urls = dash !== -1 ? args.slice(dash + 1) : [
  `${base}/view`,
  `${base}/r/ply`,
  `${base}/view/${PUBLIC}/ply.git?path=src/fetchpack.ts`,
  // The namespace index and every failure page (#29): missing repo, ref and path in public-v0, missing GitHub repo.
  `${base}/r`,
  `${base}/r/no-such-repo`,
  `${base}/r/ply?ref=no-such-ref`,
  `${base}/r/ply?path=no-such-file.txt`,
  `${base}/view/github.com/ivarvong/no-such-repo-x`,
];
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const stale = process.env.STALE_CSS ? readFileSync(process.env.STALE_CSS).toString('base64') : null;
const staleUrl = process.env.STALE_CSS_URL ?? `${base}/view.css`;
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page'); if (t) return t.webSocketDebuggerUrl; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('chrome did not start');
}

const ws = new WebSocket(await target());
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const handlers = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); }
  else if (m.method) handlers.forEach(h => h(m));
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const once = name => new Promise(r => { const h = m => { if (m.method === name) { handlers.splice(handlers.indexOf(h), 1); r(m.params); } }; handlers.push(h); });

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
const VERSION = process.env.PLY_VERSION ?? '';
if (VERSION) await send('Network.setExtraHTTPHeaders', { headers: { 'Cloudflare-Workers-Version-Overrides': `ply="${VERSION}"` } });
const requestIds = []; const requests = []; const wrongVersion = [];
handlers.push(m => {
  if (m.method !== 'Network.responseReceived') return;
  const h = Object.fromEntries(Object.entries(m.params.response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (h['x-ply-request-id']) { requestIds.push(h['x-ply-request-id']); requests.push({ id: h['x-ply-request-id'], version: h['x-ply-version'] ?? null, url: m.params.response.url }); }
  if (VERSION && h['x-ply-request-id'] && h['x-ply-version'] !== VERSION) wrongVersion.push(`${m.params.response.url} → ${h['x-ply-version']}`);
});
const cssRequested = new Set(); const staleServed = new Set();
await send('Fetch.enable', { patterns: [{ urlPattern: '*.css*', requestStage: 'Request' }] });
handlers.push(m => {
  if (m.method !== 'Fetch.requestPaused') return;
  const url = m.params.request.url;
  cssRequested.add(url);
  if (stale && url.split('?')[0] === staleUrl) {
    staleServed.add(url);
    send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/css' }], body: stale });
  } else send('Fetch.continueRequest', { requestId: m.params.requestId });
});

const PROBE = `(() => {
  const svgs = [...document.querySelectorAll('svg')].filter(s => s.getBoundingClientRect().width > 0);
  const icon = document.querySelector('svg.i');
  return {
    title: document.title,
    maxSvgPx: Math.round(Math.max(0, ...svgs.map(s => s.getBoundingClientRect().width))),
    iconPx: icon ? getComputedStyle(icon).width : null,
    overflowPx: document.documentElement.scrollWidth - innerWidth,
    sheets: [...document.styleSheets].map(s => { try { return { href: s.href, rules: s.cssRules.length }; } catch { return { href: s.href, rules: -1 }; } }),
    tree: !!document.querySelector('ul.files'),
    rows: document.querySelectorAll('li[data-oid]').length,
    // the footer build line: each token (ply=…, ply-web=…) must sit on one line
    buildTokensBroken: [...document.querySelectorAll('.site-footer .build > span')].filter(s => s.getClientRects().length > 1).map(s => s.textContent),
    headline: document.querySelector('h1.display')?.textContent ?? null,
    kicker: document.querySelector('.error-kicker')?.textContent ?? null,
    upLinks: [...document.querySelectorAll('.error-card .lede a')].map(a => [a.textContent, a.getAttribute('href')]),
  };
})()`;

let failed = false;
for (const url of urls) for (const [w, h, mobile] of [[375, 812, true], [1280, 800, false]]) for (const scheme of ['light', 'dark']) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  const loaded = once('Page.loadEventFired'); await send('Page.navigate', { url }); await loaded; await sleep(300);
  const r = (await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.value;
  const problems = [];
  if (r.maxSvgPx > 64) problems.push(`svg ${r.maxSvgPx}px wide`);
  if (r.overflowPx > 0) problems.push(`horizontal overflow ${r.overflowPx}px`);
  if (!r.sheets.some(s => s.rules > 50)) problems.push('no stylesheet with rules applied');
  if (r.iconPx && r.iconPx !== '16px') problems.push(`icon ${r.iconPx}`);
  if (!r.sheets.some(s => /\/view\.[0-9a-f]{12}\.css$/.test(s.href ?? ''))) problems.push(`stylesheet not content-hashed: ${r.sheets.map(s => s.href).join(' ')}`);
  if (r.tree && r.rows === 0) problems.push('tree page has no li[data-oid] rows');
  if (r.buildTokensBroken.length) problems.push(`footer build token wraps inside itself: ${r.buildTokensBroken.join(', ')}`);
  if (r.kicker && r.headline && /^\p{Ll}/u.test(r.headline)) problems.push(`headline not sentence case: ${r.headline}`);
  // an error page never links "Repository root" back to the repository it just failed to find
  const rootLink = r.upLinks.find(([text]) => text === 'Repository root');
  if (rootLink && /HTTP 404 · repo/.test(r.kicker ?? '')) problems.push(`missing-repo page links Repository root → ${rootLink[1]}`);
  const name = `${url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}-${w}-${scheme}${stale ? '-stale' : ''}.png`;
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(outdir, name), Buffer.from(shot.data, 'base64'));
  if (problems.length) failed = true;
  console.log(JSON.stringify({ ok: !problems.length, url, w, scheme, problems, shot: join(outdir, name), maxSvgPx: r.maxSvgPx, iconPx: r.iconPx, overflowPx: r.overflowPx, rows: r.rows, headline: r.headline, upLinks: r.upLinks, sheets: r.sheets }));
}
if (wrongVersion.length) failed = true;
console.log(JSON.stringify({ cssRequested: [...cssRequested], staleCss: stale ? { url: staleUrl, servedFor: [...staleServed] } : null, version: VERSION || null, requestIds, requests, wrongVersion, failed }));
ws.close(); chrome.kill();
process.exit(failed ? 1 : 0);
