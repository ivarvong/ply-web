// Open-loop probe schedule. Issue at the policy period even while requests are
// outstanding. At `maxInFlight`, record a shed and keep the clock. The dwell
// returns at the wall deadline and does not wait out a hung fetch.
import type { ProbeOutcome } from './probe.ts'

export type ProbeClock = {
  now(): number
  sleep(ms: number): Promise<void>
}

/** One probe the scheduler has started. The promise resolves with its outcome. */
export type ProbeStart = {
  readonly id: string
  readonly promise: Promise<ProbeOutcome>
}

export type ProbeSchedule = {
  readonly clock: ProbeClock
  readonly dwellMs: number
  readonly periodMs: number
  readonly maxInFlight: number
  readonly batch: number
  issue(seq: number): ProbeStart
  shed(seq: number): ProbeOutcome
  stop(): void
}

/**
 * Tick until the wall deadline. A full in-flight set sheds this tick instead of
 * awaiting it. Outstanding probes at the deadline are `timed_out` here; `stop`
 * aborts them so the process does not keep the sockets.
 */
export async function runProbeSchedule(input: ProbeSchedule): Promise<readonly ProbeOutcome[]> {
  if (input.periodMs <= 0) throw new Error('probe period must be > 0')
  if (input.batch <= 0) throw new Error('probe batch must be > 0')
  const start = input.clock.now()
  const deadline = start + input.dwellMs
  const outcomes: ProbeOutcome[] = []
  const inflight = new Map<number, string>()
  let nextAt = start
  let seq = 0
  const finish = (id: number, outcome: ProbeOutcome): void => {
    if (!inflight.has(id)) return
    inflight.delete(id)
    outcomes.push(outcome)
  }
  while (input.clock.now() < deadline) {
    const now = input.clock.now()
    if (now < nextAt) {
      const wait = Math.min(nextAt, deadline) - now
      if (wait > 0) await input.clock.sleep(wait)
      continue
    }
    if (inflight.size + input.batch > input.maxInFlight) {
      for (let index = 0; index < input.batch; index += 1) {
        seq += 1
        outcomes.push(input.shed(seq))
      }
    } else {
      for (let index = 0; index < input.batch; index += 1) {
        seq += 1
        const id = seq
        const started = input.issue(id)
        inflight.set(id, started.id)
        void started.promise.then(outcome => {
          finish(id, outcome)
        })
      }
    }
    nextAt += input.periodMs
  }
  input.stop()
  for (const [id, probeId] of [...inflight]) {
    inflight.delete(id)
    outcomes.push({ kind: 'lost', id: probeId, reason: 'timed_out' })
  }
  return outcomes
}
