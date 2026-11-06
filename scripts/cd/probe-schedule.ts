// Open-loop probe schedule. Issue at the policy period even while requests are
// outstanding. At `maxInFlight`, record a shed and keep the clock. Issuing stops at
// the wall deadline; probes still in flight then get `graceMs` (the probe's own
// timeout) to answer, and the dwell does not wait out a hung fetch past that.
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
  /**
   * How long probes in flight at the deadline may still answer. Without it the last tick's probes (issued a few ms
   * before the deadline, ~100 ms healthy latency) were always counted timed_out: 2-6 per 2,000-probe window against a
   * 0.13% cap, which failed or held 4 of 6 ramps on 2026-11-06 with 0 server errors (ids 1995-2000, 1996-2000, …).
   */
  readonly graceMs: number
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
  const pending = new Map<number, Promise<ProbeOutcome>>()
  let nextAt = start
  let seq = 0
  const finish = (id: number, outcome: ProbeOutcome): void => {
    if (!inflight.has(id)) return
    inflight.delete(id)
    pending.delete(id)
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
        pending.set(id, started.promise)
        void started.promise.then(outcome => {
          finish(id, outcome)
        })
      }
    }
    nextAt += input.periodMs
  }
  if (inflight.size > 0 && input.graceMs > 0) {
    await Promise.race([Promise.allSettled([...pending.values()]), input.clock.sleep(input.graceMs)])
    // Let the settled probes' `finish` callbacks run before the rest are counted.
    await Promise.resolve()
  }
  input.stop()
  for (const [id, probeId] of [...inflight]) {
    inflight.delete(id)
    outcomes.push({ kind: 'lost', id: probeId, reason: 'timed_out' })
  }
  return outcomes
}
