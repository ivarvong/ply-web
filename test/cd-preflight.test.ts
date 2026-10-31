import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeOriginMain, originMainReason } from '../scripts/cd/preflight.ts'

const MAIN = 'f9a3416001e0f89187cbc293738021c31a289c34'
const HEAD = '610913e0aabbccddeeff00112233445566778899'

test('HEAD equal to origin/main may deploy', () => {
  assert.deepEqual(judgeOriginMain(MAIN, MAIN), { ok: true, sha: MAIN })
})

test('any other HEAD is not-on-origin-main', () => {
  const result = judgeOriginMain(HEAD, MAIN)
  assert.deepEqual(result, { ok: false, kind: 'not-on-origin-main', head: HEAD, main: MAIN })
  if (!result.ok) assert.match(originMainReason(result), /^not-on-origin-main: HEAD .+ is not origin\/main .+/)
})

test('a missing sha is origin-main-unavailable', () => {
  const result = judgeOriginMain('HEAD', MAIN)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.kind, 'origin-main-unavailable')
    assert.match(originMainReason(result), /^origin-main-unavailable: /)
  }
})
