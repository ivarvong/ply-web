// The harness's own health. A VM pause (the box is snapshotted: dmesg "crng reseeded due to virtual machine fork", 69 of
// them in the 38 h before 2026-11-10 16:13) or a blocked event loop stops every timer, socket read and probe tick at once;
// when the process runs again the wall clock (and usually the monotonic clock) has jumped. Requests in flight across such
// a gap time out on the client, and a probe dwell that stops issuing looks like a starved window. Neither is evidence
// about the Worker. This module records those gaps so callers can tell a client stall from a product failure.
import { CLIENT_STALL_MS, CLIENT_TICK_MS } from './baseline.ts'

/** A gap in the client's own clocks, in wall-clock milliseconds (`from` is the last healthy tick, `to` the first after). */
export type Stall = {
  readonly from: number
  readonly to: number
  readonly ms: number
}

/** What the probe schedule and the smoke read: the gaps seen so far, measured at the call. */
export type StallSource = {
  /** Check the clocks now (a resumed loop sees the gap before its next timer fires). Returns the stall it found, or null. */
  check(): Stall | null
  /** Every stall that overlaps [from, to]. */
  during(from: number, to: number): readonly Stall[]
  /** Milliseconds of [from, to] the client spent stalled. */
  stalledMs(from: number, to: number): number
}

export type ClientClocks = {
  /** Wall clock, ms. */
  wall(): number
  /** Monotonic clock, ms. */
  mono(): number
}

const SYSTEM_CLOCKS: ClientClocks = {
  wall: () => Date.now(),
  mono: () => Number(process.hrtime.bigint() / 1_000_000n),
}

/**
 * A gap is a stall when either clock advanced by more than `stallMs` between two checks. Ticks are `tickMs` apart, so a
 * healthy gap is about `tickMs`; the wall clock catches a VM pause even when the guest's monotonic clock did not advance.
 */
export function gapStall(prevWall: number, prevMono: number, wall: number, mono: number, stallMs: number): Stall | null {
  const gap = Math.max(wall - prevWall, mono - prevMono)
  if (gap <= stallMs) return null
  return { from: prevWall, to: prevWall + gap, ms: gap }
}

function overlap(stall: Stall, from: number, to: number): number {
  return Math.max(0, Math.min(stall.to, to) - Math.max(stall.from, from))
}

export class ClientHealth implements StallSource {
  private readonly clocks: ClientClocks
  private readonly stallMs: number
  private readonly tickMs: number
  private prevWall: number
  private prevMono: number
  private readonly seen: Stall[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(clocks: ClientClocks = SYSTEM_CLOCKS, stallMs = CLIENT_STALL_MS, tickMs = CLIENT_TICK_MS) {
    this.clocks = clocks
    this.stallMs = stallMs
    this.tickMs = tickMs
    this.prevWall = clocks.wall()
    this.prevMono = clocks.mono()
  }

  start(): void {
    if (this.timer !== null) return
    this.prevWall = this.clocks.wall()
    this.prevMono = this.clocks.mono()
    this.timer = setInterval(() => {
      this.check()
    }, this.tickMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  check(): Stall | null {
    const wall = this.clocks.wall()
    const mono = this.clocks.mono()
    const stall = gapStall(this.prevWall, this.prevMono, wall, mono, this.stallMs)
    this.prevWall = wall
    this.prevMono = mono
    if (stall) this.seen.push(stall)
    return stall
  }

  stalls(): readonly Stall[] {
    return [...this.seen]
  }

  during(from: number, to: number): readonly Stall[] {
    return this.seen.filter(stall => overlap(stall, from, to) > 0)
  }

  stalledMs(from: number, to: number): number {
    return this.seen.reduce((sum, stall) => sum + overlap(stall, from, to), 0)
  }
}

/** A source that never stalls: tests and callers outside a run. */
export const NO_STALLS: StallSource = {
  check: () => null,
  during: () => [],
  stalledMs: () => 0,
}

let active: ClientHealth | null = null

/** The run's monitor, started by the pipeline. Outside a run this is NO_STALLS. */
export function clientHealth(): StallSource {
  return active === null ? NO_STALLS : active
}

export function startClientHealth(): ClientHealth {
  if (active === null) active = new ClientHealth()
  active.start()
  return active
}

/** Stops the run's monitor and returns every stall it saw. */
export function stopClientHealth(): readonly Stall[] {
  if (active === null) return []
  active.stop()
  const seen = active.stalls()
  active = null
  return seen
}
