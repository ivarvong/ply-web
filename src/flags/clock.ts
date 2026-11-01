// The Workers clock only advances when the isolate yields for I/O. A pair of performance.now()
// calls around pure CPU (the flag hash) both read the same instant, so that delta is 0.
// Measure across an await. That await is the cache lookup, the R2 read, or the FlagControl RPC.

const MS_PRECISION = 1_000;

export type Clock = () => number;

/** Milliseconds, three decimal places. Non-finite and non-positive deltas are 0: they are not a duration. */
export function roundMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms * MS_PRECISION) / MS_PRECISION;
}

export async function elapsed<T>(clock: Clock, run: () => Promise<T>): Promise<{ readonly value: T; readonly ms: number }> {
  const started = clock();
  const value = await run();
  return { value, ms: roundMs(clock() - started) };
}
