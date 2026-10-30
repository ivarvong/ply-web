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

function die(msg) { console.error(`publish: ${msg}`); process.exit(1); }

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
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
  if (r.status !== 0) die(`git ${args[0]} exited ${r.status}: ${(r.stderr || '').slice(0, 400)}`);
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
let tokenId = null;
try {
  git(['clone', '--quiet', '--bare', '--single-branch', '--branch', branch, ...(tags ? [] : ['--no-tags']), source, join(work, 'src.git')]);
  const sha = git(['rev-parse', `refs/heads/${branch}`], { cwd: join(work, 'src.git') }).trim();

  // 3. A write token for this repo only, 10 minutes.
  const minted = json(cf(['artifacts', 'namespaces', 'tokens', 'create', PUBLIC_NAMESPACE, '--repo', repo, '--scope', 'write', '--ttl', String(WRITE_TTL_S)]).stdout);
  tokenId = minted.id;
  const token = String(minted.plaintext ?? '');
  if (!token) die('cf returned no token');

  // 4. Push. The Authorization header goes to git through the environment only.
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` };
  const refspecs = [`+refs/heads/${branch}:refs/heads/${branch}`, ...(tags ? ['+refs/tags/*:refs/tags/*'] : [])];
  git(['push', '--quiet', remote, ...refspecs], { env, cwd: join(work, 'src.git') });
  console.log(`published ${PUBLIC_NAMESPACE}/${repo} ${branch} = ${sha}`);
  console.log(`view: https://ply.ivar.workers.dev/r/${repo}`);
} finally {
  rmSync(work, { recursive: true, force: true });
  // Revocation is eventually consistent (cf: a revoke within ~1 s of create can 404), so retry briefly.
  if (tokenId) {
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      ok = cf(['artifacts', 'namespaces', 'tokens', 'revoke', String(tokenId), '--namespace', PUBLIC_NAMESPACE, '--force'], { allowFail: true }).status === 0;
      if (!ok) spawnSync('sleep', ['1']);
    }
    console.log(ok ? 'write token revoked' : `write token ${tokenId} not revoked; it expires in ${WRITE_TTL_S / 60} min`);
  }
}
