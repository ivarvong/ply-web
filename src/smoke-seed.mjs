// Scratch Artifacts repos for src/smoke.mjs `read` and `write`: create one per run, seed it with git, hand the smoke a
// token for it, then revoke every token and delete the repo. Nothing in the smoke depends on another repo's history,
// so any number of runs back to back see the same starting state.
//
// Credentials: your cf login (OAuth; run with `env -u CLOUDFLARE_API_TOKEN` when the env token is a narrower one).
// Tokens are minted per run with a 15-minute TTL, reach git only through GIT_CONFIG_* environment variables, are never
// in argv, never printed, never written to disk, and are revoked at teardown (the repo is deleted after that).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CF = join(ROOT, 'node_modules', '.bin', 'cf');
export const SMOKE_NAMESPACE = 'default';
const PREFIX = 'ply-web-smoke-';
const TOKEN_TTL_S = 900;
// A run that was killed before teardown leaves its repo behind. The next run deletes smoke repos older than this.
const STALE_MS = 60 * 60 * 1000;

// The seeded history. Fixed identities and dates, so every run seeds the same commit oids.
const IDENT = { name: 'ply smoke', email: 'smoke@ply.invalid' };
const FILES = {
  'README.md': '# ply-web smoke\n\nSeeded by src/smoke-seed.mjs for one smoke run, then deleted.\nNon-ASCII bytes: ünïcødé ✓ 日本語\n',
  'src/index.js': 'export const answer = 42;\n',
  'notes/a.txt': 'MARK\n',
  'merge/x.txt': 'x1\nx2\nx3\n',
  'merge/y.txt': 'y1\ny2\ny3\n',
  'rebase/r.txt': 'r1\nr2\n',
  'c.txt': 'base\n',
};

function cf(args, { allowFail = false } = {}) {
  const r = spawnSync(CF, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CF_SEND_TELEMETRY: 'false' } });
  // cf's stderr can echo the request; it never carries a token (tokens are only in create responses on stdout).
  if (r.status !== 0 && !allowFail) throw new Error(`cf ${args.slice(0, 4).join(' ')} … exited ${r.status}: ${String(r.stderr || r.stdout).slice(0, 300)}`);
  return r;
}
const parse = (text, open) => JSON.parse(text.slice(text.indexOf(open)));

function git(cwd, args, env = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
  if (r.status !== 0) throw new Error(`git ${args[0]} exited ${r.status}: ${String(r.stderr).slice(-300)}`);
  return r.stdout;
}

/** git environment that sends `token` as a bearer header; the token never reaches argv. */
export const gitAuthEnv = token => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` });

function revoke(id) {
  // Revocation is eventually consistent (a revoke within ~1 s of create can 404), so retry briefly.
  for (let i = 0; i < 5; i++) {
    if (cf(['artifacts', 'namespaces', 'tokens', 'revoke', String(id), '--namespace', SMOKE_NAMESPACE, '--force'], { allowFail: true }).status === 0) return true;
    spawnSync('sleep', ['1']);
  }
  return false;
}

function deleteRepo(name) {
  return cf(['artifacts', 'namespaces', 'repos', 'delete', name, '--namespace', SMOKE_NAMESPACE, '--force'], { allowFail: true }).status === 0;
}

function sweepStale() {
  const r = cf(['artifacts', 'namespaces', 'repos', 'list', '--namespace', SMOKE_NAMESPACE, '--search', PREFIX], { allowFail: true });
  if (r.status !== 0) return;
  let repos = [];
  try { const j = parse(r.stdout, '['); repos = Array.isArray(j) ? j : []; } catch { return; }
  for (const repo of repos) {
    const created = Date.parse(repo.created_at ?? '');
    if (String(repo.name).startsWith(PREFIX) && Number.isFinite(created) && Date.now() - created > STALE_MS) {
      console.log(`seed: deleting stale ${repo.name} (created ${repo.created_at}): ${deleteRepo(repo.name) ? 'ok' : 'FAILED'}`);
    }
  }
}

function seedHistory(work) {
  let tick = 0;
  // One second apart, from a fixed epoch, so each commit oid is the same on every run.
  const at = () => { const d = `${1_790_000_000 + tick++} +0000`; return { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d }; };
  const env = { GIT_AUTHOR_NAME: IDENT.name, GIT_AUTHOR_EMAIL: IDENT.email, GIT_COMMITTER_NAME: IDENT.name, GIT_COMMITTER_EMAIL: IDENT.email, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const put = (path, text) => { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), text); };
  const commit = message => { git(work, ['add', '-A'], env); git(work, ['commit', '-q', '--no-gpg-sign', '-m', message], { ...env, ...at() }); };
  git(work, ['init', '-q', '-b', 'main'], env);
  for (const [path, text] of Object.entries(FILES)) put(path, text);
  commit('smoke: base');
  git(work, ['tag', 'smoke-base'], env);
  put('main2.txt', 'second\n');
  commit('smoke: main 2');
  // Two branches that conflict on c.txt, for the merge-conflict step.
  git(work, ['checkout', '-q', '-b', 'conflict-a'], env); put('c.txt', 'A\n'); commit('smoke: A');
  git(work, ['checkout', '-q', 'main'], env);
  git(work, ['checkout', '-q', '-b', 'conflict-b'], env); put('c.txt', 'B\n'); commit('smoke: B');
  git(work, ['checkout', '-q', 'main'], env);
}

/**
 * Creates and seeds a scratch repo. `scope` is the token the smoke gets: "read" or "write" (the seed push always uses
 * its own write token, revoked before a read token is minted). Returns { name, remote, token, work, teardown }.
 * `work` is the seeded local clone: the oracle the smoke compares the Worker's answers against.
 */
export function createScratchRepo(scope) {
  if (!['read', 'write'].includes(scope)) throw new Error(`scope must be read or write, not ${scope}`);
  sweepStale();
  const name = `${PREFIX}${scope}-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
  const tokenIds = [];
  const work = mkdtempSync(join(tmpdir(), 'ply-smoke-seed-'));
  let tornDown = false;
  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    const revoked = tokenIds.filter(revoke).length;
    const deleted = deleteRepo(name);
    rmSync(work, { recursive: true, force: true });
    console.log(`seed: teardown ${name}: revoked ${revoked}/${tokenIds.length} tokens, repo ${deleted ? 'deleted' : 'NOT deleted'}`);
  };
  const mint = s => {
    const t = parse(cf(['artifacts', 'namespaces', 'tokens', 'create', SMOKE_NAMESPACE, '--repo', name, '--scope', s, '--ttl', String(TOKEN_TTL_S)]).stdout, '{');
    if (!t.plaintext || !t.id) throw new Error('cf returned no token');
    tokenIds.push(t.id);
    return { id: t.id, token: String(t.plaintext) };
  };
  try {
    const created = parse(cf(['artifacts', 'namespaces', 'repos', 'create', SMOKE_NAMESPACE, '--name', name, '--default-branch', 'main', '--description', 'ply-web smoke scratch repo (deleted after the run)']).stdout, '{');
    const remote = created.remote;
    if (!/^https:\/\/[a-z0-9]+\.artifacts\.cloudflare\.net\/git\//.test(String(remote))) throw new Error('unexpected remote from cf');
    // The create response carries an initial token without its id. Revoke every active token on the new repo.
    const listed = cf(['artifacts', 'namespaces', 'repos', 'tokens', 'list', '--namespace', SMOKE_NAMESPACE, '--name', name, '--state', 'active'], { allowFail: true });
    if (listed.status === 0) for (const t of parse(listed.stdout, '[')) revoke(t.id);
    seedHistory(work);
    const writer = mint('write');
    git(work, ['push', '-q', remote, 'main', 'conflict-a', 'conflict-b', 'refs/tags/smoke-base'], gitAuthEnv(writer.token));
    let token = writer.token;
    if (scope === 'read') { revoke(writer.id); token = mint('read').token; }
    console.log(`seed: ${name} main=${git(work, ['rev-parse', 'main']).trim()} (${scope} token, ${TOKEN_TTL_S / 60} min)`);
    return { name, remote, token, work, teardown };
  } catch (e) {
    teardown();
    throw e;
  }
}
