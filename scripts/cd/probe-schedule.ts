// Open-loop probe schedule. Issue at the policy period even while requests are
// outstanding. At `maxInFlight`, record a shed and keep the clock. Issuing stops at
// the wall deadline; probes still in flight then get `graceMs` (the probe's own
// timeout) to answer, and the dwell does not wait out a hung fetch past that.
import type { StallSource } from './client-health.ts'
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
  /**
   * The client's own stalls (client-health.ts). Time the client spent stalled is added back to the dwell, missed ticks
   * are skipped rather than burst, a probe in flight across a stall is `stalled` (not lost), and each stall in the
   * window adds one `stalled` marker so the judge knows the client was unhealthy. NO_STALLS outside a run.
   */
  readonly health: StallSource
  /**
   * After a stall, keep issuing past the dwell until `minReal` real samples (responded + lost) exist, but never more than
   * `maxMs` past the dwell (CLIENT_MAX_EXTENSION_MS). Without a stall the dwell is exactly `dwellMs`.
   */
  readonly extension: { readonly maxMs: number; readonly minReal: number }
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
  const outcomes: ProbeOutcome[] = []
  const inflight = new Map<number, string>()
  const issuedAt = new Map<number, number>()
  const pending = new Map<number, Promise<ProbeOutcome>>()
  let nextAt = start
  let seq = 0
  let real = 0
  let stalls = 0
  const crossedStall = (id: number, at: number): boolean => {
    // A resumed process may settle a probe before any timer runs: look at the clocks first.
    input.health.check()
    const from = issuedAt.get(id)
    return typeof from === 'number' && input.health.during(from, at).length > 0
  }
  const finish = (id: number, outcome: ProbeOutcome): void => {
    if (!inflight.has(id)) return
    const probeId = inflight.get(id) || String(id)
    inflight.delete(id)
    pending.delete(id)
    if (outcome.kind === 'lost' && crossedStall(id, input.clock.now())) {
      outcomes.push({ kind: 'stalled', id: probeId })
    } else {
      if (outcome.kind === 'responded' || outcome.kind === 'lost') real += 1
      outcomes.push(outcome)
    }
    issuedAt.delete(id)
  }
  const deadline = (): number => {
    const stalled = input.health.stalledMs(start, input.clock.now())
    if (stalled <= 0) return start + input.dwellMs
    const cap = start + input.dwellMs + input.extension.maxMs
    const stretched = start + input.dwellMs + stalled
    // Past the stretched dwell, keep going until enough real samples exist, up to the cap.
    if (input.clock.now() >= stretched && real + inflight.size < input.extension.minReal) return cap
    return Math.min(stretched, cap)
  }
  while (input.clock.now() < deadline()) {
    input.health.check()
    const seen = input.health.during(start, input.clock.now())
    if (seen.length > stalls) {
      for (const stall of seen.slice(stalls)) outcomes.push({ kind: 'stalled', id: `client-stall ${stall.from}-${stall.to} ${stall.ms}ms` })
      stalls = seen.length
      // Skip the ticks the stall swallowed instead of bursting them into sheds.
      nextAt = input.clock.now()
    }
    const now = input.clock.now()
    if (now < nextAt) {
      const wait = Math.min(nextAt, deadline()) - now
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
        issuedAt.set(id, input.clock.now())
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
  input.health.check()
  const end = input.clock.now()
  // A stall the loop did not see (it ended while stalled) still marks the window.
  for (const stall of input.health.during(start, end).slice(stalls)) {
    outcomes.push({ kind: 'stalled', id: `client-stall ${stall.from}-${stall.to} ${stall.ms}ms` })
  }
  for (const [id, probeId] of [...inflight]) {
    inflight.delete(id)
    outcomes.push(crossedStall(id, end) ? { kind: 'stalled', id: probeId } : { kind: 'lost', id: probeId, reason: 'timed_out' })
  }
  return outcomes
}
