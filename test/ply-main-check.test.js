// scripts/ply-main-check.sh and its wiring in .github/workflows/ply-main.yml. Each case runs the real script in a
// scratch package whose test/lint/typecheck scripts are stubs, with a fake `npm` first on PATH: `npm install` writes
// the lockfile entry npm would (resolved `...ply.git#<full sha>`) or fails on demand; every other npm command is the
// real npm. Expected values are the exit-code contract in the script header (0 pass, 1 gate/install failure, 2 usage)
// and shas chosen here, never output of the script under test. Offline: nothing is fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/ply-main-check.sh');
const realNpm = execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
const PREV = '1111111111111111111111111111111111111111';
const FULL = 'abcdef0123456789abcdef0123456789abcdef01';

function run(sha, { failGate = '', failInstall = false, resolveTo = '', noOut = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ply-main-check-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const gate = name => (failGate === name
    ? `node -e "console.log('✔ fine (1ms)'); console.log('✖ ${name} breaks (2ms)'); console.log('ℹ fail 1'); console.log('✖ failing tests:'); console.log('✖ ${name} breaks (2ms)'); process.exit(1)"`
    : `node -e "console.log('✔ ${name} ok')"`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture', private: true, dependencies: { ply: `github:ivarvong/ply#${PREV}` },
    scripts: { test: gate('test'), lint: gate('lint'), typecheck: gate('typecheck') },
  }, null, 2));
  // Fake npm install: a short sha resolves to FULL when FULL starts with it (what the git ref lookup does).
  writeFileSync(join(bin, 'npm'), `#!/bin/sh
if [ "$1" = install ]; then
  [ -z "$FAKE_INSTALL_FAIL" ] || { echo "npm error prepare: tsc exited 2" >&2; exit 1; }
  exec node -e '
    const fs = require("fs"); const sha = require("./package.json").dependencies.ply.split("#")[1];
    const full = process.env.FAKE_RESOLVE || (process.env.FAKE_FULL.startsWith(sha) ? process.env.FAKE_FULL : sha);
    fs.writeFileSync("package-lock.json", JSON.stringify({ packages: { "node_modules/ply": { resolved: "git+ssh://git@github.com/ivarvong/ply.git#" + full } } }));'
fi
exec "${realNpm}" "$@"
`);
  chmodSync(join(bin, 'npm'), 0o755);
  const out = join(dir, 'out');
  const ghOut = join(dir, 'github-output');
  writeFileSync(ghOut, '');
  const r = spawnSync('sh', [script, sha, ...(noOut ? [] : [out])], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_FULL: FULL, FAKE_INSTALL_FAIL: failInstall ? '1' : '', FAKE_RESOLVE: resolveTo, GITHUB_OUTPUT: ghOut },
  });
  const read = f => (existsSync(join(out, f)) ? readFileSync(join(out, f), 'utf8') : null);
  const summary = read('summary.env');
  return {
    code: r.status, stderr: r.stderr, stdout: r.stdout, report: read('report.md'), logs: ['test', 'lint', 'typecheck'].filter(g => read(`${g}.log`) !== null),
    env: summary && Object.fromEntries(summary.trim().split('\n').map(l => l.split('='))),
    ghOutput: readFileSync(ghOut, 'utf8'),
    pin: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies.ply,
  };
}

test('every gate passes: exit 0, OUTCOME=pass, outcome=pass for the workflow', () => {
  const r = run(FULL);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.env.OUTCOME, 'pass');
  assert.equal(r.env.PLY_PREV, PREV);
  assert.equal(r.ghOutput, 'outcome=pass\n');
});

for (const g of ['test', 'lint', 'typecheck']) {
  test(`npm run ${g} fails: exit 1, OUTCOME=fail, report names it with the compare range`, () => {
    const r = run(FULL, { failGate: g });
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.env.OUTCOME, 'fail');
    assert.equal(r.env.PLY_SHORT, 'abcdef0');
    assert.equal(r.ghOutput, 'outcome=fail\n');
    assert.match(r.report, new RegExp(`^Failed gates: ${g}$`, 'm'));
    assert.ok(r.report.includes(`https://github.com/ivarvong/ply/compare/${PREV}...${FULL}`));
    if (g === 'test') {
      assert.match(r.report, /^Failing tests:\n✖ test breaks \(2ms\)\n/m);
      assert.ok(!/^Failing tests:\n✔/m.test(r.report));
      // node:test's summary header `✖ failing tests:` is not a test name; the list holds only the test.
      const list = r.report.slice(r.report.indexOf('Failing tests:\n')).split('\n\n')[0];
      assert.equal(list, 'Failing tests:\n✖ test breaks (2ms)');
    }
  });
}

test('npm install of a valid sha fails: exit 1 and a report, so the workflow opens the issue', () => {
  const r = run(FULL, { failInstall: true });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.env.OUTCOME, 'fail');
  assert.equal(r.env.PLY_SHORT, 'abcdef0');
  assert.equal(r.ghOutput, 'outcome=fail\n');
  assert.match(r.report, /^Failed gates: install$/m);
  assert.match(r.report, /^### npm install$/m);
  assert.ok(r.report.includes('prepare: tsc exited 2'));
  // No gate runs after a failed install: no gate log, and the stub gates never printed.
  assert.deepEqual(r.logs, []);
  assert.ok(!/npm run (test|lint|typecheck) exit/.test(r.stdout), r.stdout);
});

test('lockfile resolves ply to a different sha than asked: usage error, exit 2, no report, no gate ran', () => {
  const other = '2222222222222222222222222222222222222222';
  const r = run(FULL, { resolveTo: other });
  assert.equal(r.code, 2, r.stderr);
  assert.ok(r.stderr.includes(`lockfile resolved ply to '${other}', not ${FULL}`), r.stderr);
  assert.equal(r.report, null);
  assert.equal(r.ghOutput, '');
  assert.deepEqual(r.logs, []);
});

test('no out-dir: usage error, exit 2, the pin is untouched and nothing is installed', () => {
  const r = run(FULL, { noOut: true });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /^usage: sh scripts\/ply-main-check\.sh <ply-sha> <out-dir>$/m);
  assert.equal(r.pin, `github:ivarvong/ply#${PREV}`);
  assert.equal(r.ghOutput, '');
});

test('a short sha resolves to the full one before the gates run', () => {
  const r = run(FULL.slice(0, 7));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.env.PLY_SHA, FULL);
  assert.equal(r.pin, `github:ivarvong/ply#${FULL}`);
});

test('sha bounds: 7 and 40 lowercase hex are accepted', () => {
  assert.equal(run(FULL.slice(0, 7)).code, 0);
  assert.equal(run(FULL).code, 0);
});

for (const [name, sha] of [['6 hex', FULL.slice(0, 6)], ['41 hex', `${FULL}a`], ['uppercase', FULL.toUpperCase()], ['empty', ''], ['non-hex', 'abcdefg']]) {
  test(`sha ${name}: usage error, exit 2, no report, no workflow outcome`, () => {
    const r = run(sha);
    assert.equal(r.code, 2);
    assert.equal(r.report, null);
    assert.equal(r.ghOutput, '');
  });
}

test('workflow: the check step runs the script unmapped and the issue step keys on outcome == fail', () => {
  const wf = readFileSync(join(root, '.github/workflows/ply-main.yml'), 'utf8');
  const step = wf.slice(wf.indexOf('id: check'));
  assert.match(step, /^\s+run: sh scripts\/ply-main-check\.sh "\$\{PLY_SHA\}" "\$RUNNER_TEMP\/ply-main"$/m);
  assert.match(wf, /^\s+if: failure\(\) && steps\.check\.outputs\.outcome == 'fail'$/m);
});

test('workflow: concurrency is keyed by the ply sha, so a queued sha is never cancelled by a newer one', () => {
  // GitHub keeps one pending run per concurrency group and cancels the older pending one when another queues, so a
  // single fixed group skips the middle sha of three quick dispatches. One group per sha only dedupes the same sha.
  const wf = readFileSync(join(root, '.github/workflows/ply-main.yml'), 'utf8');
  const groups = [...wf.matchAll(/^\s+group: (.*)$/gm)].map(m => m[1]);
  assert.deepEqual(groups, ['ply-main-consumer-check-${{ github.event.client_payload.sha || inputs.sha }}']);
});
