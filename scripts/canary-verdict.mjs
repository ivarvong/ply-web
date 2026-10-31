// The telemetry gate's decision (scripts/canary-o11y.mjs), pure so it is unit-tested (test/canary-verdict.test.js).
//
// Workers Observability loses ~1.4% of events, in bursts: whole invocations (ply.request log, invocation event, sometimes
// the trace) that are still absent 15 min later (≈12 of ~830 smoke requests, 2026-10-31; lab_notebook
// ply-issues-2026-10-30.md). A strict "every smoke id logged by <version>" gate fails healthy deploys, so (CoS decision,
// 2026-10-31) a smoke id is classified as:
//   matched      logged by <version>.
//   otherVersion logged only by a different version: a routing failure. Always fails.
//   lost         logged by no version, and the smoke recorded x-ply-version: <version> on its response. Tolerated while
//                at most max(2, 2%) of the phase's ids are lost; beyond that the gate fails.
//   unconfirmed  logged by no version, and the smoke did not record <version> answering it. Always fails: nothing proves
//                which version ran it.
// Any non-ok invocation, 5xx ply.request log or error log of <version> fails regardless.

/** Lost ids a phase of `n` smoke requests may tolerate: max(2, 2% of n), rounded down. */
export const lossAllowance = n => Math.max(2, Math.floor(n * 0.02));

/**
 * @param {object} a
 * @param {string} a.version                     the version under test
 * @param {{ id: string, version: string | null, step: string }[]} a.requests  smoke requests: id, the x-ply-version the
 *                                               smoke saw on the response (null if unrecorded), and the smoke step
 * @param {Map<string, Set<string>>} a.loggedBy  id → every version that emitted a ply.request log line for it
 * @param {{ nonOk: number, fivexx: number, errorLogs: number }} a.health  bad events of `version` in the phase
 */
export function verdict({ version, requests, loggedBy, health }) {
  const byId = new Map();
  for (const r of requests) if (!byId.has(r.id) || (byId.get(r.id).version !== version && r.version === version)) byId.set(r.id, r);
  const reqs = [...byId.values()];
  const matched = [], otherVersion = [], lost = [], unconfirmed = [];
  for (const r of reqs) {
    const vs = loggedBy.get(r.id) ?? new Set();
    if (vs.has(version)) matched.push(r);
    else if (vs.size) otherVersion.push({ ...r, loggedBy: [...vs] });
    else if (r.version === version) lost.push(r);
    else unconfirmed.push(r);
  }
  const allowance = lossAllowance(reqs.length);
  const reasons = [];
  if (otherVersion.length) reasons.push(`${otherVersion.length} logged by another version`);
  if (unconfirmed.length) reasons.push(`${unconfirmed.length} lost without x-ply-version ${version} recorded by the smoke`);
  if (lost.length > allowance) reasons.push(`${lost.length} lost > allowance ${allowance}`);
  if (health.nonOk) reasons.push(`${health.nonOk} non-ok invocations`);
  if (health.fivexx) reasons.push(`${health.fivexx} 5xx`);
  if (health.errorLogs) reasons.push(`${health.errorLogs} error logs`);
  const pass = reasons.length === 0;
  const parts = [`${matched.length}/${reqs.length} matched`];
  if (lost.length) parts.push(`${lost.length} lost (${lost.length <= allowance ? 'tolerated' : `NOT tolerated, allowance ${allowance}`})`);
  if (unconfirmed.length) parts.push(`${unconfirmed.length} lost unconfirmed`);
  if (otherVersion.length) parts.push(`${otherVersion.length} other version`);
  const line = `telemetry: ${parts.join(', ')}${pass ? '' : ` FAIL: ${reasons.join('; ')}`}`;
  return { pass, total: reqs.length, matched: matched.length, allowance, lost, unconfirmed, otherVersion, reasons, line };
}

/**
 * Smoke requests from an ids file (scripts/deploy.sh): one JSON object { id, version, step } per line. A bare id line
 * (the pre-2026-10-31 format) has no recorded version, so a loss of it is never tolerated.
 */
export function parseRequests(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean).map(s => {
    if (!s.startsWith('{')) return { id: s, version: null, step: '?' };
    const o = JSON.parse(s);
    return { id: String(o.id), version: o.version ?? null, step: String(o.step ?? '?') };
  });
}
