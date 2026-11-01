import assert from 'node:assert/strict'
import { test } from 'node:test'
import { err, ok, runRequest, type UnexpectedFailure } from '../src/http/machine.ts'

test('authorize failure skips execute, and only respond sets the status', async () => {
  let executed = false
  let seen: number | null = null
  const response = await runRequest(
    {
      parse: () => ok({ path: '/v1' }),
      authorize: () => err({ kind: 'unauthorized' as const, status: 401 }),
      execute: () => {
        executed = true
        return ok({ status: 200 })
      },
    },
    result => {
      if (!result.ok) {
        seen = result.error.kind === 'unexpected' ? 500 : result.error.status
        return new Response(result.error.kind, { status: seen })
      }
      seen = result.value.status
      return new Response('ok', { status: result.value.status })
    },
  )
  assert.equal(executed, false)
  assert.equal(response.status, 401)
  assert.equal(seen, 401)
  assert.equal(await response.text(), 'unauthorized')
})

test('a throw fails only that request and the edge sees the error kind', async () => {
  const kinds: string[] = []
  const response = await runRequest(
    {
      parse: () => ok('parsed'),
      authorize: () => ok('auth'),
      execute: () => {
        throw new TypeError('secret detail')
      },
    },
    result => {
      assert.equal(result.ok, false)
      if (result.ok) return new Response('no')
      const failure = result.error as UnexpectedFailure
      kinds.push(failure.kind)
      assert.equal(failure.stage, 'execute')
      assert.equal(failure.name, 'TypeError')
      assert.equal(JSON.stringify(failure).includes('secret'), false)
      return new Response(failure.kind, { status: 500, headers: { 'x-ply-error-kind': failure.kind } })
    },
  )
  assert.deepEqual(kinds, ['unexpected'])
  assert.equal(response.status, 500)
  assert.equal(response.headers.get('x-ply-error-kind'), 'unexpected')
  assert.equal(await response.text(), 'unexpected')
})
