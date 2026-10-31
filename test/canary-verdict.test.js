// scripts/canary-verdict.mjs: the deploy telemetry gate's decision. Workers Observability loses ~1.4% of events, so an id
// logged by no version is tolerated iff the smoke saw x-ply-version: <new> on it and at most max(2, 2%) of the phase's ids
// are lost; an id logged by another version, or any bad event of <new>, always fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lossAllowance, parseRequests, verdict } from '../scripts/canary-verdict.mjs';

const NEW = 'new-version', OLD = 'old-version';
const healthy = { nonOk: 0, fivexx: 0, errorLogs: 0 };
const reqs = (n, version = NEW) => Array.from({ length: n }, (_, i) => ({ id: `id${i}`, version, step: `read: step ${i}` }));
// every id logged by NEW except those in `drop` (logged nowhere) and those in `other` (logged by OLD)
const logs = (rs, drop = [], other = []) => new Map(rs.filter(r => !drop.includes(r.id)).map(r => [r.id, new Set([other.includes(r.id) ? OLD : NEW])]));

test('all 119 matched: pass, no losses', () => {
  const rs = reqs(119);
  const v = verdict({ version: NEW, requests: rs, loggedBy: logs(rs), health: healthy });
  assert.equal(v.pass, true);
  assert.equal(v.matched, 119);
  assert.equal(v.line, 'telemetry: 119/119 matched');
});

test('2 of 119 lost, smoke saw x-ply-version NEW on both: tolerated', () => {
  const rs = reqs(119);
  const v = verdict({ version: NEW, requests: rs, loggedBy: logs(rs, ['id3', 'id70']), health: healthy });
  assert.equal(v.pass, true);
  assert.deepEqual(v.lost.map(r => [r.id, r.step]), [['id3', 'read: step 3'], ['id70', 'read: step 70']]);
  assert.equal(v.line, 'telemetry: 117/119 matched, 2 lost (tolerated)');
});

test('3 of 119 lost: over max(2, 2%) = 2, fails', () => {
  const rs = reqs(119);
  const v = verdict({ version: NEW, requests: rs, loggedBy: logs(rs, ['id1', 'id2', 'id3']), health: healthy });
  assert.equal(lossAllowance(119), 2);
  assert.equal(v.pass, false);
  assert.equal(v.lost.length, 3);
  assert.match(v.line, /3 lost \(NOT tolerated, allowance 2\).*FAIL/);
});

test('1 lost without the smoke recording x-ply-version NEW: fails', () => {
  const rs = reqs(119);
  rs[5] = { ...rs[5], version: null };
  const v = verdict({ version: NEW, requests: rs, loggedBy: logs(rs, ['id5']), health: healthy });
  assert.equal(v.pass, false);
  assert.deepEqual(v.unconfirmed.map(r => r.id), ['id5']);
  // a recorded answer from another version is no confirmation either
  rs[5] = { ...rs[5], version: OLD };
  assert.equal(verdict({ version: NEW, requests: rs, loggedBy: logs(rs, ['id5']), health: healthy }).pass, false);
});

test('1 logged by the old version: routing failure, fails even within the loss allowance', () => {
  const rs = reqs(119);
  const v = verdict({ version: NEW, requests: rs, loggedBy: logs(rs, [], ['id9']), health: healthy });
  assert.equal(v.pass, false);
  assert.deepEqual(v.otherVersion.map(r => [r.id, r.loggedBy]), [['id9', [OLD]]]);
  assert.match(v.line, /1 other version/);
});

test('any non-ok invocation, 5xx or error log of NEW fails with every id matched', () => {
  const rs = reqs(119);
  for (const bad of [{ nonOk: 1 }, { fivexx: 1 }, { errorLogs: 1 }])
    assert.equal(verdict({ version: NEW, requests: rs, loggedBy: logs(rs), health: { ...healthy, ...bad } }).pass, false);
});

test('allowance is max(2, floor(2%))', () => {
  assert.deepEqual([10, 119, 150, 200, 1000].map(lossAllowance), [2, 2, 3, 4, 20]);
});

test('ids file: JSON lines with version + step; a bare id has no recorded version', () => {
  assert.deepEqual(parseRequests('{"id":"a","version":"v","step":"gate: x"}\nb\n\n'), [
    { id: 'a', version: 'v', step: 'gate: x' }, { id: 'b', version: null, step: '?' },
  ]);
});
