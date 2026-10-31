#!/usr/bin/env node
// Publish (or update) a read-only mirror of one branch into the public Artifacts namespace that the ply Worker serves.
//
//   env -u CLOUDFLARE_API_TOKEN node scripts/publish.mjs <repo> <source> [--branch main] [--tags]
//
// <source> is anything `git clone` accepts (a local path or an https URL). The branch is pushed to the same branch name,
// with --force, so the mirror always equals the source. --tags also pushes every tag on that branch.
//
// Credentials: this script uses your cf login (OAuth) to create the repo if it is missing and to mint a WRITE token for
// that one repo with a 10-minute TTL. The token reaches git only through GIT_CONFIG_* environment variables (never argv,
// never a file, never printed), and the script revokes it when the push is done. The Worker never holds a write token: it
// mints its own read tokens through its namespace-scoped binding.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_NAMESPACE } from '../src/public-namespace.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CF = join(ROOT, 'node_modules', '.bin', 'cf');
const WRITE_TTL_S = 600;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// Throws, so the `finally` that revokes minted tokens always runs.
class Die extends Error {}
// git's stderr without progress lines (they are separated by \r), last part only.
const gitTail = text => String(text).split(/[\r\n]+/).filter(l => l.trim() && !/(Processing|Resolving|Counting|Compressing|Writing|Enumerating) objects|^remote: *$/.test(l)).join('\n').slice(-800);
function die(msg) { throw new Die(`publish: ${msg}`); }
process.on('uncaughtException', e => { console.error(e instanceof Die ? e.message : e); process.exit(1); });

function parseArgs(argv) {
  const out = { branch: 'main', tags: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--branch') out.branch = argv[++i];
    else if (a === '--tags') out.tags = true;
    else if (a.startsWith('--')) die(`unknown flag ${a}`);
    else out.positional.push(a);
  }
  return out;
}

function cf(args, { allowFail = false } = {}) {
  const r = spawnSync(CF, args, { encoding: 'utf8', env: { ...process.env, CF_SEND_TELEMETRY: 'false' } });
  if (r.status !== 0 && !allowFail) die(`cf ${args.slice(0, 4).join(' ')} … exited ${r.status}: ${(r.stderr || r.stdout).slice(0, 400)}`);
  return r;
}

function json(text) {
  const start = text.indexOf('{');
  if (start < 0) die('cf did not print JSON');
  return JSON.parse(text.slice(start));
}

function git(args, { env = {}, cwd } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
  if (r.status !== 0) die(`git ${args[0]} exited ${r.status}: ${gitTail(r.stderr || r.error || '')}`);
  return r.stdout;
}

const { positional: [repo, source], branch, tags } = parseArgs(process.argv.slice(2));
if (!repo || !source) die('usage: node scripts/publish.mjs <repo> <source> [--branch main] [--tags]');
if (!NAME.test(repo) || repo.includes('..') || /\.git$/i.test(repo)) die('repo name: a letter or digit, then letters, digits, . _ - (no .., no .git suffix)');
if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) die('bad branch name');

// 1. The repo exists, or is created with this branch as its default.
const got = cf(['artifacts', 'namespaces', 'repos', 'get', repo, '--namespace', PUBLIC_NAMESPACE], { allowFail: true });
let remote;
if (got.status === 0) remote = json(got.stdout).remote;
else {
  const created = json(cf(['artifacts', 'namespaces', 'repos', 'create', PUBLIC_NAMESPACE, '--name', repo, '--default-branch', branch, '--description', `Read-only mirror (${source.replace(/\/\/[^@/]*@/, '//')})`]).stdout);
  remote = created.remote;
  console.log(`created ${PUBLIC_NAMESPACE}/${repo}`);
  // The create response carries an initial write token (24 h) but not its id. It is not used: revoke every active
  // write token on the new repo so none outlives this run.
  const listed = cf(['artifacts', 'namespaces', 'repos', 'tokens', 'list', '--namespace', PUBLIC_NAMESPACE, '--name', repo, '--state', 'active'], { allowFail: true });
  if (listed.status === 0) {
    for (const t of JSON.parse(listed.stdout.slice(listed.stdout.indexOf('[')))) {
      if (t.scope === 'write') cf(['artifacts', 'namespaces', 'tokens', 'revoke', String(t.id), '--namespace', PUBLIC_NAMESPACE, '--force'], { allowFail: true });
    }
  }
}
if (!/^https:\/\/[a-z0-9]+\.artifacts\.cloudflare\.net\/git\//.test(String(remote))) die('unexpected remote from cf');

// 2. A local bare copy of just that branch (and its tags when asked).
const work = mkdtempSync(join(tmpdir(), 'ply-publish-'));
const tokenIds = [];
let current = null; // { token, at }
// A write token for this repo only, 10 minutes. Re-minted after 8 minutes for a long chunked publish.
function writeToken() {
  if (current && Date.now() - current.at < (WRITE_TTL_S - 120) * 1000) return current.token;
  const minted = json(cf(['artifacts', 'namespaces', 'tokens', 'create', PUBLIC_NAMESPACE, '--repo', repo, '--scope', 'write', '--ttl', String(WRITE_TTL_S)]).stdout);
  tokenIds.push(minted.id);
  if (!minted.plaintext) die('cf returned no token');
  current = { token: String(minted.plaintext), at: Date.now() };
  return current.token;
}
// Push. The Authorization header goes to git through the environment only. Returns null or git's stderr.
function push(refspecs, cwd) {
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${writeToken()}` };
  const r = spawnSync('git', ['push', '--quiet', remote, ...refspecs], { cwd, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
  return r.status === 0 ? null : String(r.stderr || 'push failed');
}
// Artifacts refuses a push over 64 MiB or 50,000 objects (developers.cloudflare.com/artifacts/platform/limits).
const TOO_BIG = /maximum size|too.large|limit is|exceeds|too many objects|413|object limit|object count/i;
try {
  const cwd = join(work, 'src.git');
  git(['clone', '--quiet', '--bare', '--single-branch', '--branch', branch, ...(tags ? [] : ['--no-tags']), source, cwd]);
  const sha = git(['rev-parse', `refs/heads/${branch}`], { cwd }).trim();
  const target = `refs/heads/${branch}`;
  let err = push([`+${target}:${target}`], cwd);
  if (err) console.log(`full push refused: ${gitTail(err)}`);
  if (err && TOO_BIG.test(err)) {
    // Over the per-push limit: walk the first-parent chain oldest → newest and push prefixes of history, each one a
    // fast-forward of the last, halving the stride when a push is still too big.
    const chain = git(['rev-list', '--first-parent', '--reverse', target], { cwd }).trim().split('\n');
    // Resume from what the remote already has, so a re-run never rewinds the branch.
    const auth = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${writeToken()}` };
    const have = (git(['ls-remote', remote, target], { cwd, env: auth }).split('\t')[0] ?? '').trim();
    let done = have ? chain.indexOf(have) : -1, stride = Math.max(1, Math.floor(chain.length / 8)), pushes = 0;
    while (done < chain.length - 1) {
      const next = Math.min(chain.length - 1, done + stride);
      const e = push([`+${chain[next]}:${target}`], cwd);
      if (e) {
        if (!TOO_BIG.test(e) || stride === 1) die(`chunked push failed at ${next}/${chain.length}: ${gitTail(e)}`);
        stride = Math.max(1, Math.floor(stride / 2));
        continue;
      }
      done = next; pushes++;
      console.log(`pushed ${done + 1}/${chain.length} first-parent commits (${pushes} pushes)`);
      stride = Math.ceil(stride * 1.5);
    }
    err = null;
  }
  if (err) die(`push failed: ${gitTail(err)}`);
  if (tags) { const e = push(['+refs/tags/*:refs/tags/*'], cwd); if (e) die(`tag push failed: ${e.slice(0, 300)}`); }
  console.log(`published ${PUBLIC_NAMESPACE}/${repo} ${branch} = ${sha}`);
  console.log(`view: https://ply.ivar.workers.dev/r/${repo}`);
} finally {
  rmSync(work, { recursive: true, force: true });
  // Revocation is eventually consistent (cf: a revoke within ~1 s of create can 404), so retry briefly.
  for (const tokenId of tokenIds) {
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      ok = cf(['artifacts', 'namespaces', 'tokens', 'revoke', String(tokenId), '--namespace', PUBLIC_NAMESPACE, '--force'], { allowFail: true }).status === 0;
      if (!ok) spawnSync('sleep', ['1']);
    }
    console.log(ok ? `write token ${tokenId} revoked` : `write token ${tokenId} not revoked; it expires in ${WRITE_TTL_S / 60} min`);
  }
}
