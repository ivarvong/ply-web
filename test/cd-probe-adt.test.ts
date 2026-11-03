import { strict as assert } from 'node:assert'
import { none, some } from '../src/option.ts'
import { toSimpleOutcome, type ProbeOutcome } from '../scripts/cd/probe.ts'

test('probe ADT mapping covers all branches', () => {
  const respondedOk: ProbeOutcome = { kind: 'responded', id: 'a', status: 200, ray: none(), latencyMs: 10, version: none() }
  const respondedErr: ProbeOutcome = { kind: 'responded', id: 'b', status: 503, ray: none(), latencyMs: 20, version: some('new') }
  const lostTimeout: ProbeOutcome = { kind: 'lost', id: 'c', reason: 'timed_out' }
  const lostNetwork: ProbeOutcome = { kind: 'lost', id: 'd', reason: 'network' }
  const lostAborted: ProbeOutcome = { kind: 'lost', id: 'e', reason: 'aborted' }
  const shed: ProbeOutcome = { kind: 'shed', id: 'f' }

  assert.deepEqual(toSimpleOutcome(respondedOk), { kind: 'ok' })
  assert.deepEqual(toSimpleOutcome(respondedErr), { kind: 'server_error' })
  assert.deepEqual(toSimpleOutcome(lostTimeout), { kind: 'timeout' })
  assert.deepEqual(toSimpleOutcome(lostNetwork), { kind: 'transport_error' })
  assert.deepEqual(toSimpleOutcome(lostAborted), { kind: 'transport_error' })
  assert.deepEqual(toSimpleOutcome(shed), { kind: 'shed' })
})

