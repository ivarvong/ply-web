import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyCall, EXPIRED_TOKEN, openingRevokeResult, type CallEvidence } from '../scripts/cd/classify.ts'

function evidence(over: Partial<CallEvidence> = {}): CallEvidence {
  return { status: 500, body: '', timedOut: false, mintedToken: false, ...over }
}

test('a request with no response is a harness fault', () => {
  assert.equal(classifyCall(evidence({ status: 0, timedOut: true })), 'harness_fault')
  assert.equal(classifyCall(evidence({ status: 0, timedOut: false })), 'harness_fault')
  assert.equal(classifyCall(evidence({ status: 200, timedOut: true })), 'harness_fault')
})

test('a 403 on a token minted this stage is a harness fault', () => {
  assert.equal(classifyCall(evidence({
    status: 403,
    mintedToken: true,
    body: `{"detail":"${EXPIRED_TOKEN}"}`,
  })), 'harness_fault')
})

test('the repo-create token is confirmed only after a 403', () => {
  assert.deepEqual(openingRevokeResult({ hadToken: true, listed: 1, revoked: true, confirmed: true }), { ok: true })
  assert.equal(openingRevokeResult({ hadToken: false, listed: 1, revoked: true, confirmed: true }).ok, false)
  assert.equal(openingRevokeResult({ hadToken: true, listed: 0, revoked: false, confirmed: false }).ok, false)
  const refused = openingRevokeResult({ hadToken: true, listed: 1, revoked: true, confirmed: false })
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.reason, /not revoked/)
})

test('a worker answer stays a worker fault', () => {
  assert.equal(classifyCall(evidence({ status: 403, mintedToken: false, body: EXPIRED_TOKEN })), 'worker')
  assert.equal(classifyCall(evidence({ status: 403, mintedToken: true, body: 'forbidden' })), 'worker')
  assert.equal(classifyCall(evidence({ status: 500, body: 'exception' })), 'worker')
  assert.equal(classifyCall(evidence({ status: 502, mintedToken: true, body: EXPIRED_TOKEN })), 'worker')
})
