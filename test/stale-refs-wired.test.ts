// Stale refs wired end to end through handleViewer -> loadRepo with a local git http-backend whose ls-refs reply is held
// back (the a179dd82 Codeberg shape: ls-refs body ~10 s, 12 s page timeout). Expected values come from the owner decision
// and git itself (the branch names pushed here), not from the code under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeBareRepo, startGitServer, tmpRoot, commitFiles } from './server.js';
import { handleViewer } from '../src/viewer/handle.ts';
import type { RateNamespace } from '../src/viewer/model.ts';

function fakeRate(): RateNamespace {
  return { idFromName: name => name, get: () => ({ admit: () => ({ ok: true, remaining: 1, retryAfterMs: 0 }) }) } as unknown as RateNamespace;
}

function bodyText(init: RequestInit | undefined): string {
  const b = init ? init.body : null;
  if (typeof b === 'string') return b;
  if (b instanceof Uint8Array) return new TextDecoder().decode(b);
  if (b instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(b));
  return '';
}

test('slow ls-refs: stale list with note past the budget, background refresh replaces it, other repos never share it, no entry 504s', { timeout: 60_000 }, async () => {
  const { root, cleanup } = tmpRoot();
  const srv = await startGitServer(root);
  const local = new URL(srv.url);
  let lsRefsDelayMs = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (u.hostname !== 'github.com') throw new Error(`refusing to dial ${u.hostname}`);
    u.protocol = local.protocol; u.hostname = local.hostname; u.port = local.port;
    if (bodyText(init).includes('command=ls-refs') && lsRefsDelayMs > 0) {
      const sig = init && init.signal ? init.signal : null;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, lsRefsDelayMs);
        if (sig) sig.addEventListener('abort', () => { clearTimeout(t); reject(sig.reason); }, { once: true });
      });
    }
    return fetch(u, init);
  };
  const call = (path: string) => {
    const attrs: Record<string, unknown> = {};
    const deferred: Promise<unknown>[] = [];
    const ctx = {
      tracing: { startSpan: () => ({ setAttribute(k: string, v: unknown) { attrs[k] = v; }, end() {} }) },
      waitUntil(p: Promise<unknown>) { deferred.push(p); },
    };
    const env = { VIEWER_RATE: fakeRate(), PACK_CACHE: 'off' };
    return handleViewer(new Request(`https://ply.ivar.workers.dev${path}`), env as never, ctx, { fetchImpl }).then(async res => ({ res, html: await res.text(), attrs, deferred }));
  };
  try {
    for (const name of ['stale-a', 'stale-b']) {
      const bare = makeBareRepo(root, name);
      const work = join(root, `work-${name}`);
      mkdirSync(work);
      git(work, ['init', '-q', '-b', 'main']);
      commitFiles(work, bare, { 'README.md': `${name}\n` }, 'seed');
    }
    // (c) fast upstream: fresh refs, no note, span says live.
    const fresh = await call('/view/github.com/stale-a.git');
    assert.equal(fresh.res.status, 200, fresh.html);
    assert.equal(fresh.html.includes('data-refs-stale'), false);
    assert.equal(fresh.attrs['ply.viewer.refs_path'], 'live');
    assert.equal('ply.viewer.refs_stale_age_ms' in fresh.attrs, false);

    // (a) ls-refs body held 6 s (> 3.5 s budget, < 12 s timeout) with a prior entry: 200 on the last good list, the note,
    // span fields, and the live request handed to waitUntil.
    const work = join(root, 'work-stale-a');
    git(work, ['-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '--allow-empty', '-q', '-m', 'f']);
    lsRefsDelayMs = 6_000;
    const t0 = Date.now();
    // The new branch lands while the live ls-refs is held, so only the background refresh can see it.
    setTimeout(() => git(work, ['push', '-q', join(root, 'stale-a.git'), 'HEAD:refs/heads/feature-late']), 500);
    const stale = await call('/view/github.com/stale-a.git');
    const took = Date.now() - t0;
    assert.equal(stale.res.status, 200, stale.html);
    assert.match(stale.html, /data-refs-stale="\d+"/);
    assert.match(stale.html, /Refs as of \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ: the server took over 3\.5 s/);
    assert.equal(stale.html.includes('feature-late'), false, 'the stale list predates the push');
    assert.equal(stale.attrs['ply.viewer.refs_path'], 'stale');
    assert.equal(stale.attrs['ply.viewer.refs_stale_budget_ms'], 3_500);
    assert.equal(typeof stale.attrs['ply.viewer.refs_stale_age_ms'], 'number');
    assert.ok((stale.attrs['ply.viewer.refs_stale_age_ms'] as number) >= 3_500, 'age covers at least the budget');
    assert.ok(took < 6_000, `page answered before the held ls-refs (${took} ms)`);
    assert.ok(stale.deferred.length >= 1, 'live ls-refs handed to waitUntil');

    // (d) the background refresh replaces the entry: once it settles, the next page (again slow) shows the new branch.
    await Promise.all(stale.deferred);
    const next = await call('/view/github.com/stale-a.git');
    assert.equal(next.res.status, 200, next.html);
    assert.match(next.html, /feature-late/, 'the refreshed entry carries the branch pushed during the held request');

    // Isolation + (b): stale-b never finished a live ls-refs, so stale-a's list must not stand in; the page fails as today.
    lsRefsDelayMs = 13_000;
    const none = await call('/view/github.com/stale-b.git');
    assert.equal(none.res.status, 504, none.html.slice(0, 300));
    assert.equal(none.html.includes('data-refs-stale'), false);
    for (const p of none.deferred) await p.catch(() => {});
  } finally {
    lsRefsDelayMs = 0;
    await srv.close();
    cleanup();
  }
});
