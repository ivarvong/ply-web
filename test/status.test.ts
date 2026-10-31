import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CODES } from 'ply'
import { STATUS, statusOf } from '../src/status.ts'
import { WORKER_RETRY } from '../src/write/errors.ts'

test('every ply error code and every Worker code maps to an HTTP status', () => {
  for (const code of [...CODES, ...Object.keys(WORKER_RETRY)]) {
    assert.equal(typeof STATUS[code], 'number', code)
    assert.ok(STATUS[code]! >= 400 && STATUS[code]! < 600, code)
  }
  assert.deepEqual(Object.keys(STATUS).sort(), [...CODES, ...Object.keys(WORKER_RETRY)].sort())
})

test('statusOf keeps the upstream auth status and defaults to 500', () => {
  assert.equal(statusOf({ code: 'auth', status: 403 }), 403)
  assert.equal(statusOf({ code: 'auth', status: 500 }), 401)
  assert.equal(statusOf({ code: 'cas_conflict' }), 409)
  assert.equal(statusOf({ code: 'toString' }), 500)
  assert.equal(statusOf({ code: 'nope' }), 500)
  assert.equal(statusOf(null), 500)
})
