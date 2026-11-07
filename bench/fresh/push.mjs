#!/usr/bin/env node
// Freshness pushes: N commits to public-v0/<repo> straight to Artifacts (not through the mirror), one every <gapS>
// seconds, each recorded with the laptop clock when `git push` returned and the laptop's offset to Cloudflare's clock
// (ply-fresh /now, best round trip of 8). Prints one JSON line per push. Watchers (ply-fresh /watch-start) observe
// /r/<repo> meanwhile; analyse.mjs joins the two.
//
//   env -u CLOUDFLARE_API_TOKEN node bench/fresh/push.mjs <repo> <workdir> <n> <gapS>
//
// The write token (10 min, this repo only, re-minted after 8 min) reaches git through GIT_CONFIG_* only and is revoked
// at the end. It is never printed.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CF = join(ROOT, 'node_modules', '.bin', 'cf');
const NS = 'public-v0';
const [repo, work, nArg, gapArg] = process.argv.slice(2);
if (!repo || !work) throw new Error('usage: push.mjs <repo> <workdir> <n> <gapS>');
const n = Number(nArg || 10), gapS = Number(gapArg || 30);

function cf(args) {
  const r = spawnSync(CF, args, { encoding: 'utf8', env: { ...process.env, CF_SEND_TELEMETRY: 'false' } });
  if (r.status !== 0) throw new Error(`cf ${args.slice(0, 4).join(' ')} exited ${r.status}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
}
function git(args, env = {}) {
  const r = spawnSync('git', args, { cwd: work, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
  if (r.status !== 0) throw new Error(`git ${args[0]} exited ${r.status}: ${String(r.stderr).replace(/art_v1_\w+/g, '[redacted]').slice(-300)}`);
  return r.stdout.trim();
}
async function offset() {
  let best = { rtt: Infinity, off: 0 };
  for (let i = 0; i < 8; i++) {
    const a = Date.now();
    const { now } = await (await fetch('https://ply-fresh.ivar.workers.dev/now')).json();
    const b = Date.now();
    if (b - a < best.rtt) best = { rtt: b - a, off: now - (a + b) / 2 };
  }
  return best;
}

const remote = cf(['artifacts', 'namespaces', 'repos', 'get', repo, '--namespace', NS]).remote;
let token = null, ids = [];
const mint = () => {
  if (token && Date.now() - token.at < 480_000) return token.value;
  const m = cf(['artifacts', 'namespaces', 'tokens', 'create', NS, '--repo', repo, '--scope', 'write', '--ttl', '600']);
  ids.push(m.id);
  token = { value: String(m.plaintext), at: Date.now() };
  return token.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  for (let i = 1; i <= n; i++) {
    const readme = join(work, 'README.md');
    writeFileSync(readme, readFileSync(readme, 'utf8').replace(/counter: \d+/, `counter: ${Date.now()}`));
    git(['-c', 'user.name=ply fresh', '-c', 'user.email=fresh@ply.invalid', 'commit', '-q', '-am', `fresh-probe: push ${i}`]);
    const oid = git(['rev-parse', 'HEAD']);
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${mint()}` };
    const t0 = Date.now();
    git(['push', '--quiet', remote, 'HEAD:refs/heads/main'], env);
    const t1 = Date.now();
    const o = await offset();
    console.log(JSON.stringify({ i, oid, pushStart: t0, pushDone: t1, pushMs: t1 - t0, cfOffset: o.off, offRtt: o.rtt, cfPushDone: t1 + o.off }));
    if (i < n) await sleep(gapS * 1000 - (Date.now() - t0));
  }
} finally {
  for (const id of ids) spawnSync(CF, ['artifacts', 'namespaces', 'tokens', 'revoke', String(id), '--namespace', NS, '--force'], { encoding: 'utf8' });
}
