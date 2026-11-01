import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { runCf, useCfRunner, type CfResult } from '../scripts/cd/cf.ts'
import { isTrafficSplit, trafficSplit, type VersionShare } from '../scripts/cd/deploy-plan.ts'
import { RunLog, withRun } from '../scripts/cd/log.ts'
import { withCommandSink } from '../scripts/cd/trace.ts'
import { applySplit } from '../scripts/cd/traffic.ts'
import { armStep, beginRamp, endRamp, HarnessFault, withWriteIntent } from '../scripts/cd/traffic-gate.ts'

const NEXT = 'ab73257f-1111-4111-8111-111111111111'
const PREV = '11111111-2222-4333-8444-555555555555'

type Share = { version_id: string; percentage: number }
type Create = { message: string; versions: Share[] }

describe('traffic gate', { concurrency: false }, () => {
  afterEach(() => {
    endRamp()
    useCfRunner(null)
  })

  test('a deployment create with no active log is a harness fault and does not call cf', async () => {
    let called = false
    useCfRunner(async (): Promise<CfResult> => {
      called = true
      return { code: 0, stdout: '{}', stderr: '' }
    })
    await assert.rejects(
      () => runCf(['workers', 'deployments', 'create', '--worker', 'ply', '--body', '{}']),
      (error: unknown) => error instanceof HarnessFault && /no active log/.test(error.message),
    )
    assert.equal(called, false)
  })

  test('a create inside the run log still faults when the command sink is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ply-gate-'))
    const log = await RunLog.open(join(dir, 'run'), join(dir, 'ledger.jsonl'), 'run-gate')
    let called = false
    useCfRunner(async (): Promise<CfResult> => {
      called = true
      return { code: 0, stdout: '{}', stderr: '' }
    })
    await withRun(log, async () => {
      beginRamp(75)
      await assert.rejects(
        () => withWriteIntent({ kind: 'step', percent: 75 }, () => runCf(['workers', 'deployments', 'create', '--worker', 'ply', '--body', '{}'])),
        (error: unknown) => error instanceof HarnessFault && /no command sink/.test(error.message),
      )
    })
    assert.equal(called, false)
  })

  test('the 75% observe window refuses an unarmed 100% create, then accepts it after the decision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ply-gate-'))
    const runDir = join(dir, 'run')
    const log = await RunLog.open(runDir, join(dir, 'ledger.jsonl'), 'run-gate')
    const clock = { t: Date.parse('2026-11-01T20:07:27.000Z') }
    const live: Share[] = [
      { version_id: NEXT, percentage: 50 },
      { version_id: PREV, percentage: 50 },
    ]
    const creates: Create[] = []
    useCfRunner(async (args): Promise<CfResult> => {
      if (args[1] === 'deployments' && args[2] === 'list') {
        return { code: 0, stdout: JSON.stringify({ deployments: [{ id: 'dep-1', versions: live }] }), stderr: '' }
      }
      if (args[1] === 'deployments' && args[2] === 'create') {
        const raw = args[args.indexOf('--body') + 1]
        if (!raw) return { code: 1, stdout: '', stderr: 'missing body' }
        const body = JSON.parse(raw) as { versions: Share[]; annotations: { 'workers/message': string } }
        live.splice(0, live.length, ...body.versions)
        creates.push({ message: body.annotations['workers/message'], versions: body.versions.map(share => ({ version_id: share.version_id, percentage: share.percentage })) })
        return { code: 0, stdout: '{}', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'unexpected cf args' }
    })
    await withRun(log, () => withCommandSink(note => log.noteCommand(note), async () => {
      beginRamp(75)
      const at75 = trafficSplit(75, NEXT, PREV)
      if (!isTrafficSplit(at75)) throw new Error(at75.reason)
      const wrote75 = await applySplit('ply', `ramp ${NEXT} 75%`, at75, shares(live), { kind: 'step', percent: 75 })
      assert.equal(wrote75.ok, true)
      clock.t += 135_000
      const at100 = trafficSplit(100, NEXT, PREV)
      if (!isTrafficSplit(at100)) throw new Error(at100.reason)
      await assert.rejects(
        () => applySplit('ply', `ramp ${NEXT} 100%`, at100, shares(live), { kind: 'step', percent: 100 }),
        (error: unknown) => error instanceof HarnessFault && /during observe/.test(error.message),
      )
      assert.equal(creates.length, 1)
      const ref = await log.observation({
        measurement: { source: 'ramp-step', percent: 75, at: clock.t },
        query: { source: 'test' },
        from: clock.t - 40_000,
        to: clock.t,
        raw: '{}',
      })
      await log.decision({
        inputs: [ref],
        rules: [{ name: 'ramp', value: 'advance' }],
        outcome: 'advance',
        reason: '75% passed',
      })
      armStep(100)
      const wrote100 = await applySplit('ply', `ramp ${NEXT} 100%`, at100, shares(live), { kind: 'step', percent: 100 })
      assert.equal(wrote100.ok, true)
    }))
    assert.deepEqual(creates.map(create => create.message), [`ramp ${NEXT} 75%`, `ramp ${NEXT} 100%`])
    assert.deepEqual(creates.map(create => percentOf(create.versions, NEXT)), [75, 100])
    const text = await readFile(join(runDir, 'events.jsonl'), 'utf8')
    const lines = text.split('\n').filter(line => line.includes('"kind":"command"') && line.includes('deployments'))
    const loggedCreates = lines.filter(line => line.includes('create'))
    assert.equal(loggedCreates.length, creates.length)
    assert.equal(text.includes('"kind":"state_change"'), true)
    assert.equal(text.includes('"outcome":"advance"'), true)
  })

  test('two creates cannot overlap, and the second loses the arm', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ply-gate-'))
    const log = await RunLog.open(join(dir, 'run'), join(dir, 'ledger.jsonl'), 'run-gate')
    const live: Share[] = [
      { version_id: NEXT, percentage: 50 },
      { version_id: PREV, percentage: 50 },
    ]
    let release: () => void = () => {}
    const hold = new Promise<void>(resolve => {
      release = resolve
    })
    let entered = 0
    let releaseEntered: () => void = () => {}
    const enteredGate = new Promise<void>(resolve => {
      releaseEntered = resolve
    })
    useCfRunner(async (args): Promise<CfResult> => {
      if (args[1] === 'deployments' && args[2] === 'list') {
        return { code: 0, stdout: JSON.stringify({ deployments: [{ id: 'dep-1', versions: live }] }), stderr: '' }
      }
      if (args[1] === 'deployments' && args[2] === 'create') {
        entered += 1
        if (entered === 1) releaseEntered()
        await hold
        const raw = args[args.indexOf('--body') + 1]
        if (!raw) return { code: 1, stdout: '', stderr: 'missing body' }
        const body = JSON.parse(raw) as { versions: Share[] }
        live.splice(0, live.length, ...body.versions)
        return { code: 0, stdout: '{}', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'unexpected cf args' }
    })
    await withRun(log, () => withCommandSink(note => log.noteCommand(note), async () => {
      beginRamp(75)
      const at75 = trafficSplit(75, NEXT, PREV)
      if (!isTrafficSplit(at75)) throw new Error(at75.reason)
      const expected = shares(live)
      const first = applySplit('ply', `ramp ${NEXT} 75%`, at75, expected, { kind: 'step', percent: 75 })
      const second = applySplit('ply', `ramp ${NEXT} 75%`, at75, expected, { kind: 'step', percent: 75 })
      await enteredGate
      assert.equal(entered, 1)
      release()
      const settled = await Promise.allSettled([first, second])
      const fulfilled = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
      assert.equal(fulfilled.length, 2)
      assert.equal(fulfilled.filter(result => result.ok).length, 1)
      assert.equal(fulfilled.filter(result => !result.ok && result.kind === 'state_conflict').length, 1)
      assert.equal(entered, 1)
    }))
  })
})

function shares(versions: readonly Share[]): VersionShare[] {
  return versions.map(share => ({ versionId: share.version_id, percentage: share.percentage }))
}

function percentOf(versions: readonly Share[], id: string): number {
  const share = versions.find(item => item.version_id === id)
  if (!share) throw new Error(`missing ${id}`)
  return share.percentage
}
