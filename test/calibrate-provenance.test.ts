// Issue #73 acceptance: no threshold in the rollout policy (scripts/cd/cd.policy.json) or in ply-web's limits
// (src/limits.ts, src/viewer/limits.ts) without a cited distribution or an explicit `PRIOR (uncalibrated)` tag.
// The provenance of each is an entry in scripts/calibrate/thresholds.json whose `value` must match the threshold.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentThresholds, loadRegistry } from '../scripts/calibrate/current.ts'
import { CALIBRATED, PRIOR, policyThresholds, provenanceProblems, readRegistry, wildcardOf } from '../scripts/calibrate/provenance.ts'

test('every threshold in the policy and the limits cites a distribution or is tagged PRIOR (uncalibrated)', () => {
  const current = currentThresholds()
  const problems = provenanceProblems(loadRegistry(), current)
  assert.deepEqual(problems, [], problems.map(p => `${p.key}: ${p.problem}`).join('\n'))
  // The enumeration reaches every source, so a source dropped from currentThresholds cannot pass vacuously.
  for (const prefix of ['policy:', 'api:', 'mirror:', 'verify:', 'viewer:']) {
    assert.ok([...current.keys()].some(key => key.startsWith(prefix)), `no ${prefix} thresholds enumerated`)
  }
  for (const key of ['policy:probe.maxLossRate', 'policy:telemetry.maxLossRate', 'policy:steps[2].dwellMs', 'api:maxPackBytes', 'viewer:maxTreeEntries', 'mirror:maxPackObjects']) {
    assert.ok(current.has(key), key)
  }
})

test('the checked-in calibrated entries are the ones with a measured run behind them', () => {
  const { registry } = loadRegistry()
  const calibrated = [...registry.thresholds.entries()].filter(([, entry]) => entry.status === CALIBRATED).map(([key]) => key).sort()
  assert.deepEqual(calibrated, [
    'policy:cleanup.attempts',
    'policy:ingestWaitMs',
    'policy:probe.maxLossRate',
    'policy:probe.timeoutMs',
    'policy:probe.windowAttempts',
    'policy:telemetry.query.attempts',
    'policy:warmupMs',
  ])
  const prior = registry.thresholds.get('policy:telemetry.maxLossRate')
  assert.ok(prior)
  assert.equal(prior.status, PRIOR)
})

const CITED = { status: CALIBRATED, source: 'run r', query: 'q', window: 'w', date: '2026-11-01', n: 10, percentile: 'p99', headroom: 'x2' }
const MIN_N = { value: 30, status: PRIOR, why: 'floor' }

test('a threshold with neither a citation nor a PRIOR tag fails, and so does a stale or orphaned entry', () => {
  const current = new Map([['policy:a', 1], ['policy:b', 2], ['policy:steps[0].percent', 10], ['policy:steps[1].percent', 50], ['api:c', 3]])
  const parsed = readRegistry({
    minN: MIN_N,
    thresholds: {
      'policy:a': { ...CITED, value: 1 },
      'policy:b': { value: 3, status: PRIOR, why: 'round' },
      'policy:steps[*].percent': { value: [10, 25], status: PRIOR, why: 'schedule' },
      'api:gone': { value: 1, status: PRIOR, why: 'old' },
    },
  })
  assert.deepEqual(provenanceProblems(parsed, current).map(p => [p.key, p.problem.split(':')[0]]), [
    ['policy:b', 'threshold is 2, its provenance entry says 3'],
    ['api:c', 'threshold 3 has no provenance'],
    ['policy:steps[*].percent', 'thresholds are [10,50], the provenance entry says [10,25]'],
    ['api:gone', 'provenance entry for a threshold that does not exist'],
  ])
})

test('a citation must name source, query, window, date, n, percentile and headroom; a prior must say why', () => {
  const bad = readRegistry({
    minN: MIN_N,
    thresholds: {
      'x:nothing': { value: 1 },
      'x:untagged': { value: 1, status: 'calibrated-ish' },
      'x:half': { value: 1, status: CALIBRATED, source: 'run', date: '2026-11-01' },
      'x:date': { ...CITED, value: 1, date: 'Nov 1' },
      'x:n': { ...CITED, value: 1, n: 0 },
      'x:why': { value: 1, status: PRIOR, why: '  ' },
      'x:metric': { value: 1, status: PRIOR, why: 'w', metric: { attribute: 'git.pack.bytes', route: '*', quantile: 0.95, headroom: 2, band: 2 } },
      'x:value': { status: PRIOR, why: 'w' },
    },
  })
  assert.deepEqual(bad.problems.map(p => p.key), ['x:nothing', 'x:untagged', 'x:half', 'x:date', 'x:n', 'x:why', 'x:metric', 'x:value'])
  assert.match(bad.problems[2].problem, /must cite query, window, n, percentile, headroom/)
  assert.match(bad.problems[1].problem, /status must be "calibrated" \(with a citation\) or "PRIOR \(uncalibrated\)"/)
  assert.equal(readRegistry({ thresholds: {} }).problems.some(p => p.key === 'minN'), true, 'the registry floor needs provenance too')
})

test('policy enumeration skips citation blocks and indexes arrays', () => {
  const found = policyThresholds({ steps: [{ percent: 10 }], probe: { rps: 5, calls: [{ path: '/' }], calibration: { n: 790 }, schedule: { n: 128 } }, gates: { smoke: 'hard' } })
  assert.deepEqual([...found.entries()], [['policy:steps[0].percent', 10], ['policy:probe.rps', 5]])
  assert.equal(wildcardOf('policy:steps[3].dwellMs'), 'policy:steps[*].dwellMs')
  assert.equal(wildcardOf('api:maxPackBytes'), null)
})
