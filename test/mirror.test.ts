// Mirror sync (src/mirror.ts) against real git: a local http-backend plays both GitHub (the source) and the Artifacts
// host (the mirror). Checked: the first sync, in-sync, an incremental update that sends only the new objects, a
// rewritten upstream, the write token's scope / TTL / revocation, and that no token appears in a result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeBareRepo, startGitServer, tmpRoot, commitFiles } from './server.js';
import { syncMirror, WRITE_TTL_S, type Mirror } from '../src/mirror.ts';
import type { ArtifactsNamespace, TokenSource } from '../src/public.ts';

/** Null and a missing value take the fallback. An empty string and 0 stay. */
function fill<T>(value: unknown, fallback: T): T {
  return value === null || value === void 0 ? fallback : value as T;
}

/** One property. A null receiver and a missing key are holes. A stored null stays null. */
function slot(receiver: unknown, key: string): unknown {
  if (receiver === null || receiver === void 0) return void 0;
  if (typeof receiver !== 'object' && typeof receiver !== 'function') return void 0;
  return (receiver as Record<string, unknown>)[key];
}

const READ = `art_v1_${'re4d'.repeat(10)}?expires=4102444800`;
const WRITE = `art_v1_${'wr17'.repeat(10)}?expires=4102444800`;

test('syncMirror: first sync, in-sync, incremental, rewritten upstream; a 60 s write token, revoked, never in the result', async () => {
  const { root, cleanup } = tmpRoot();
  const srv = await startGitServer(root);
  try {
    const source = makeBareRepo(root, 'src');
    mkdirSync(join(root, 'git', 'public-v0'), { recursive: true });
    const mirrorBare = makeBareRepo(root, 'git/public-v0/ply');
    const work = join(root, 'w-src');
    mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    const c1 = commitFiles(work, source, { 'README.md': 'one\n', 'src/a.js': 'a\n' }, 'one');
    const mints: { scope: string; ttl: number }[] = [];
    const revoked: string[] = [];
    const binding: ArtifactsNamespace = {
      async get() {
        return Object.assign({ async createToken(scope: 'read' | 'write', ttl: number) { mints.push({ scope, ttl }); return { plaintext: WRITE }; } },
          { async revokeToken(t: string) { revoked.push(t); return true; } });
      },
    };
    const tokens: TokenSource = { readToken: async () => READ, secrets: () => [READ] };
    const auths: string[] = [];
    // github.com/ivarvong/ply.git → the local source repo; the mirror origin is the local server itself
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      auths.push(fill(new Headers(slot(init, 'headers') as HeadersInit).get('authorization'), ''));
      const u = String(input).replace('https://github.com/ivarvong/ply.git', `${srv.url}/src.git`);
      return fetch(u, init);
    };
    const m: Mirror = { repo: 'ply', source: 'https://github.com/ivarvong/ply.git', branch: 'main' };
    const deps = { binding, tokens, fetchImpl, origin: srv.url };
    const mirrorTip = () => git(mirrorBare, ['rev-parse', 'refs/heads/main']).trim();

    const first = await syncMirror(m, deps);
    assert.equal(first.outcome, 'updated', JSON.stringify(first));
    assert.equal(first.from, null);
    assert.equal(first.to, c1);
    assert.equal(mirrorTip(), c1);
    git(mirrorBare, ['fsck', '--strict', '--no-dangling']);

    const again = await syncMirror(m, deps);
    assert.equal(again.outcome, 'in-sync');
    assert.equal(mints.length, 1, 'no write token when nothing changed');

    git(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '--allow-empty', '-q', '-m', 'two']);
    git(work, ['push', '-q', source, 'HEAD:refs/heads/main']);
    const c2 = git(work, ['rev-parse', 'HEAD']).trim();
    const inc = await syncMirror(m, deps);
    assert.equal(inc.outcome, 'updated');
    assert.equal(inc.from, c1);
    assert.equal(inc.to, c2);
    assert.equal(inc.objects, 1, 'only the new commit (its tree is already there)');
    assert.equal(mirrorTip(), c2);

    // upstream rewrites history (force push): followed, with a CAS from the mirror's tip
    git(work, ['reset', '-q', '--hard', c1]);
    writeFileSync(join(work, 'README.md'), 'rewritten\n');
    git(work, ['add', '-A']);
    git(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'rewritten']);
    git(work, ['push', '-q', '-f', source, 'HEAD:refs/heads/main']);
    const c3 = git(work, ['rev-parse', 'HEAD']).trim();
    const rw = await syncMirror(m, deps);
    assert.equal(rw.outcome, 'updated', JSON.stringify(rw));
    assert.equal(mirrorTip(), c3);
    git(mirrorBare, ['fsck', '--strict', '--no-dangling']);

    assert.deepEqual(mints.map(x => x.scope), ['write', 'write', 'write']);
    assert.ok(mints.every(x => x.ttl === WRITE_TTL_S && WRITE_TTL_S === 60));
    assert.deepEqual(revoked, [WRITE, WRITE, WRITE], 'every write token is revoked after its push');
    // the source is read anonymously; the mirror with the read token (ls-refs) and the write token (receive-pack)
    assert.ok(auths.includes(''));
    assert.ok(auths.includes(`Bearer ${READ}`) && auths.includes(`Bearer ${WRITE}`));
    for (const r of [first, again, inc, rw]) assert.equal(JSON.stringify(r).includes('art_v1_'), false);

    // a missing source branch is an error result, not a throw, and pushes nothing
    const missing = await syncMirror({ ...m, branch: 'nope' }, deps);
    assert.equal(missing.outcome, 'error');
    assert.equal(mirrorTip(), c3);
  } finally {
    await srv.close();
    cleanup();
  }
});
