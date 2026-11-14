// The workbench builds a scenario's seed in memory (src/bench/seed.ts). Its object ids must be the ones git plumbing
// makes from the same plan (ply's test/probes/runner.mjs buildSeed), or a run from the Worker would not be the run ply's
// suite makes. Every scenario the workbench can hold is built both ways here and compared id by id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENARIOS, type Seed } from 'ply/probes';
import { buildSeed, contentBytes, objectsFor, seedBytes } from '../src/bench/seed.ts';
import { WORKBENCH_SEED_BYTES } from '../src/bench/catalogue.ts';

const IDENT = { GIT_AUTHOR_NAME: 'ply probe', GIT_AUTHOR_EMAIL: 'probe@ply.invalid', GIT_COMMITTER_NAME: 'ply probe', GIT_COMMITTER_EMAIL: 'probe@ply.invalid', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };

async function gitSeed(seed: Seed): Promise<Map<string, string>> {
  const root = mkdtempSync(join(tmpdir(), 'bench-seed-'));
  const dir = join(root, 'objects.git');
  const env = { PATH: String(process.env['PATH']), HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...IDENT };
  const git = (args: string[], input: Uint8Array | string | null = null, extra: Record<string, string> = {}): string => execFileSync('git', args, { cwd: dir, env: { ...env, ...extra }, input: input === null ? '' : input, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir], { env });
  const names = new Map<string, string>();
  const trees = new Map<string, string>();
  try {
    for (const o of seed.objects) {
      if (o.tag === 'commit') {
        const idx = { GIT_INDEX_FILE: join(root, `index-${o.name}`) };
        const first = o.parents[0];
        git(typeof first === 'string' ? ['read-tree', String(trees.get(first))] : ['read-tree', '--empty'], null, idx);
        for (const f of o.files) {
          const blob = git(['hash-object', '-w', '--stdin'], await contentBytes(f.content));
          git(['update-index', '--add', '--cacheinfo', `100644,${blob},${f.path}`], null, idx);
        }
        trees.set(o.name, git(['write-tree'], null, idx));
        names.set(o.name, git(['commit-tree', String(trees.get(o.name)), ...o.parents.flatMap(p => ['-p', String(names.get(p))]), '-m', o.message]));
      } else {
        names.set(o.name, git(['mktag'], `object ${names.get(o.target)}\ntype commit\ntag ${o.tagName}\ntagger ply probe <probe@ply.invalid> 1700000000 +0000\n\n${o.message}\n`));
      }
    }
    return names;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const HELD = SCENARIOS.filter(s => seedBytes(s.seed) <= WORKBENCH_SEED_BYTES);

test('the workbench holds most of the catalogue in memory', () => {
  assert.ok(HELD.length >= SCENARIOS.length - 2, `${HELD.length} of ${SCENARIOS.length}`);
});

// Seeds repeat across scenarios; each distinct seed is built once.
const distinct = [...new Map(HELD.map(s => [JSON.stringify(s.seed), s])).values()];
for (const s of distinct) {
  test(`seed object ids match git plumbing: ${s.id}`, async () => {
    const built = await buildSeed(s.seed);
    assert.ok(built.ok, built.ok ? '' : built.error);
    const want = await gitSeed(s.seed);
    assert.deepEqual(Object.fromEntries(built.value.names), Object.fromEntries(want));
  });
}

test('objectsFor: a push carries what the target lacks, minus the plan omit', async () => {
  const s = SCENARIOS.find(x => x.id === 'pack.push-malformed-object-refused#missing-blob');
  assert.ok(s);
  const built = await buildSeed(s.seed);
  assert.ok(built.ok);
  const base = String(built.value.names.get('base'));
  const step = s.steps[0];
  assert.equal(step.tag, 'push');
  if (step.tag !== 'push') return;
  const objs = objectsFor(built.value, step.push, [base as never]);
  assert.ok(objs.ok);
  // ff: its commit and its root tree; f.txt's new blob is omitted, dir/ is unchanged and held
  assert.deepEqual(objs.value.map(o => o.type).sort(), ['commit', 'tree']);
});
