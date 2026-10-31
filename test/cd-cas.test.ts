import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sameSplit, versionByTag } from '../scripts/cd/deploy-plan.ts'

const NEXT = '8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e'
const PREVIOUS = '1aa0bb11-2222-4333-8444-555566667777'

test('sameSplit matches version ids and percentages, in either order', () => {
  const expected = [{ versionId: NEXT, percentage: 1 }, { versionId: PREVIOUS, percentage: 99 }]
  assert.equal(sameSplit([{ versionId: PREVIOUS, percentage: 99 }, { versionId: NEXT, percentage: 1 }], expected), true)
  assert.equal(sameSplit([{ versionId: NEXT, percentage: 5 }, { versionId: PREVIOUS, percentage: 95 }], expected), false)
  assert.equal(sameSplit([{ versionId: NEXT, percentage: 100 }], expected), false)
  assert.equal(sameSplit([], []), true)
})

test('versionByTag reads the versions list and ignores TTY text', () => {
  const payload = { result: [{ id: NEXT, annotations: { 'workers/tag': 'abc123def456' } }, { id: PREVIOUS, tag: 'oldoldoldold' }] }
  assert.deepEqual(versionByTag(payload, 'abc123def456'), { ok: true, versionId: NEXT })
  assert.deepEqual(versionByTag(payload, 'oldoldoldold'), { ok: true, versionId: PREVIOUS })
  assert.deepEqual(versionByTag(payload, 'missingtag00'), { ok: false, kind: 'version-not-found', tag: 'missingtag00' })
  assert.deepEqual(versionByTag(`Created version\nversion id: ${NEXT}\n`, 'abc123def456'), { ok: false, kind: 'version-not-found', tag: 'abc123def456' })
})
