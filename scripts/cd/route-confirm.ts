// Is a split write being served? After the 0% canary write, pinned requests (Cloudflare-Workers-Version-Overrides) must
// come back from the canary; after the 100% write, unpinned requests must come back from it. Cloudflare applies an
// override only on an edge machine that already has the new deployment and otherwise routes by the split, so a check on
// one keep-alive connection samples one path and can pass while other machines still serve the old version (run
// 2026-11-10T20-48-18-470Z). Each round here opens PIN_BATCH fresh TCP+TLS connections, and confirmation needs every
// answer to be the wanted version for PIN_SUSTAIN_MS. Every sample is kept: time since the write, colo, version.
import { request } from 'node:https'
import { activeLog } from './log.ts'
import { PIN_BATCH, PIN_INTERVAL_MS, PIN_MAX_MS, PIN_REQUEST_MS, PIN_SUSTAIN_MS } from './baseline.ts'

export type RouteSample = {
  /** Milliseconds since the split write (or since the check began when the write time is unknown). */
  readonly at: number
  readonly round: number
  readonly status: number
  /** `x-ply-version`; null for a lost request or a response without it. */
  readonly version: string | null
  /** The colo suffix of cf-ray, or null. */
  readonly colo: string | null
}

export type RouteVerdict =
  | { readonly kind: 'confirmed'; readonly samples: readonly RouteSample[]; readonly sustainedFrom: number; readonly at: number }
  /** A different version answered after the deadline, or no sustained window formed: routing, not the Worker. */
  | { readonly kind: 'routing'; readonly samples: readonly RouteSample[]; readonly reason: string }
  /** The wanted version never answered and answers had no version header at all: the Worker. */
  | { readonly kind: 'worker'; readonly samples: readonly RouteSample[]; readonly reason: string }

export type RouteIo = {
  now(): number
  sleep(ms: number): Promise<void>
  /** One GET on a fresh connection. Never throws: a lost request is status 0. */
  get(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ readonly status: number; readonly version: string | null; readonly ray: string | null }>
}

export type RouteTunables = {
  readonly batch: number
  readonly intervalMs: number
  readonly sustainMs: number
  readonly maxMs: number
  readonly requestMs: number
}

export const ROUTE_TUNABLES: RouteTunables = {
  batch: PIN_BATCH,
  intervalMs: PIN_INTERVAL_MS,
  sustainMs: PIN_SUSTAIN_MS,
  maxMs: PIN_MAX_MS,
  requestMs: PIN_REQUEST_MS,
}

/** GET on a new connection (agent: false): no socket is reused, so each sample is its own edge path. */
export function freshGet(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ readonly status: number; readonly version: string | null; readonly ray: string | null }> {
  return new Promise(resolve => {
    let settled = false
    const done = (value: { readonly status: number; readonly version: string | null; readonly ray: string | null }): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = request(url, { method: 'GET', headers, agent: false, timeout: timeoutMs }, response => {
      const version = response.headers['x-ply-version']
      const ray = response.headers['cf-ray']
      response.resume()
      response.on('end', () => {
        done({
          status: typeof response.statusCode === 'number' ? response.statusCode : 0,
          version: typeof version === 'string' && version !== '' ? version : null,
          ray: typeof ray === 'string' && ray !== '' ? ray : null,
        })
      })
      response.on('error', () => done({ status: 0, version: null, ray: null }))
    })
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', () => done({ status: 0, version: null, ray: null }))
    req.end()
  })
}

export const SYSTEM_ROUTE_IO: RouteIo = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  get: freshGet,
}

export function coloOf(ray: string | null): string | null {
  if (ray === null) return null
  const dash = ray.lastIndexOf('-')
  return dash < 0 || dash === ray.length - 1 ? null : ray.slice(dash + 1)
}

/**
 * The start of the current all-good run of rounds, or null. A round is good when every sample in it answered 2xx/3xx
 * from `version`. A lost sample (status 0) is not good: confirmation needs answers, and a stalled client cannot
 * confirm anything.
 */
export function sustainedFrom(samples: readonly RouteSample[], version: string): number | null {
  const rounds = new Map<number, RouteSample[]>()
  for (const sample of samples) {
    const list = rounds.get(sample.round)
    if (list) list.push(sample)
    else rounds.set(sample.round, [sample])
  }
  let from: number | null = null
  for (const round of [...rounds.keys()].sort((a, b) => a - b)) {
    const list = rounds.get(round) || []
    const good = list.length > 0 && list.every(sample => sample.version === version && sample.status >= 200 && sample.status < 400)
    if (!good) {
      from = null
      continue
    }
    if (from === null) from = Math.min(...list.map(sample => sample.at))
  }
  return from
}

/** Offsets (ms since the write) of samples answered by any version other than `version`. */
export function stragglers(samples: readonly RouteSample[], version: string): readonly RouteSample[] {
  return samples.filter(sample => sample.version !== null && sample.version !== version)
}

export function summarizeRoute(samples: readonly RouteSample[], version: string): string {
  const late = stragglers(samples, version)
  const colos = [...new Set(samples.map(sample => sample.colo).filter((colo): colo is string => colo !== null))].sort()
  const lost = samples.filter(sample => sample.status === 0).length
  const lastLate = late.length === 0 ? '-' : `${Math.max(...late.map(sample => sample.at))} ms`
  return `${samples.length} fresh-connection samples, ${late.length} from another version (last at ${lastLate}), ${lost} lost, colos ${colos.join(',') || '-'}`
}

/**
 * Rounds of `batch` fresh-connection GETs every `intervalMs` until every answer has been `version` for `sustainMs`
 * (measured from the first sample of the first good round to the last sample of the latest), or until `maxMs`.
 * `since` is the split write's time, so sample offsets are time since the write.
 */
export async function confirmRoute(
  input: { readonly url: string; readonly version: string; readonly headers: Record<string, string>; readonly since: number },
  io: RouteIo = SYSTEM_ROUTE_IO,
  tunables: RouteTunables = ROUTE_TUNABLES,
): Promise<RouteVerdict> {
  const started = io.now()
  const samples: RouteSample[] = []
  let round = 0
  while (io.now() - started < tunables.maxMs) {
    round += 1
    const this1 = round
    const answers = await Promise.all(Array.from({ length: tunables.batch }, async () => {
      const answer = await io.get(input.url, input.headers, tunables.requestMs)
      return { at: io.now() - input.since, round: this1, status: answer.status, version: answer.version, colo: coloOf(answer.ray) }
    }))
    samples.push(...answers)
    const from = sustainedFrom(samples, input.version)
    const last = Math.max(...answers.map(sample => sample.at))
    if (from !== null && last - from >= tunables.sustainMs) return { kind: 'confirmed', samples, sustainedFrom: from, at: last }
    await io.sleep(tunables.intervalMs)
  }
  const answered = samples.filter(sample => sample.status !== 0)
  const wanted = answered.some(sample => sample.version === input.version)
  const headerless = answered.length > 0 && answered.every(sample => sample.version === null)
  if (!wanted && headerless) {
    return { kind: 'worker', samples, reason: `no answer carried x-ply-version in ${tunables.maxMs} ms (${summarizeRoute(samples, input.version)})` }
  }
  return { kind: 'routing', samples, reason: `routing: ${input.version} not served on every fresh connection for ${tunables.sustainMs} ms within ${tunables.maxMs} ms (${summarizeRoute(samples, input.version)})` }
}

/** Record a confirmation in the run log (every sample, so straggler offsets accumulate run over run) and say what it found. */
export async function logRoute(
  input: { readonly purpose: 'pin' | 'live'; readonly version: string; readonly since: number; readonly started: number },
  verdict: RouteVerdict,
): Promise<string> {
  const line = `route-confirm ${input.purpose}: ${verdict.kind} ${input.version.slice(0, 8)}; ${summarizeRoute(verdict.samples, input.version)}${verdict.kind === 'confirmed' ? `; sustained from +${verdict.sustainedFrom} ms to +${verdict.at} ms after the write` : `; ${verdict.reason}`}`
  const log = activeLog()
  if (log) {
    const late = stragglers(verdict.samples, input.version)
    await log.observation({
      measurement: {
        source: 'route-confirm',
        purpose: input.purpose,
        kind: verdict.kind,
        version: input.version,
        samples: verdict.samples.length,
        stragglers: late.length,
        stragglerAtMs: late.map(sample => sample.at),
        lost: verdict.samples.filter(sample => sample.status === 0).length,
        colos: [...new Set(verdict.samples.map(sample => sample.colo).filter((colo): colo is string => colo !== null))].sort(),
        sustainedFromMs: verdict.kind === 'confirmed' ? verdict.sustainedFrom : null,
        confirmedAtMs: verdict.kind === 'confirmed' ? verdict.at : null,
      },
      query: { source: 'fresh-connection GET /', purpose: input.purpose },
      from: input.started,
      to: Date.now(),
      raw: JSON.stringify({ samples: verdict.samples }),
    })
  }
  return line
}
