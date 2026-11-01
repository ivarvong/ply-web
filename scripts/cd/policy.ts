import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Json } from './log.ts'

/** Checked-in rollout policy. Override a run with `--policy <path>`. */
export const DEFAULT_POLICY_PATH = fileURLToPath(new URL('./cd.policy.json', import.meta.url))

export type SignalMode = 'hard' | 'informational'

export type ProbeCall = {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly auth: boolean
}

export type RolloutStep = {
  readonly percent: number
  readonly dwellMs: number
}

/** `gate` without thresholds is not a value of this type. The parser rejects it. */
export type LatencyPolicy =
  | { readonly mode: 'off' }
  | { readonly mode: 'informational' }
  | { readonly mode: 'gate'; readonly minSamples: number; readonly p99Ratio: number; readonly effectFloorMs: number }

export type RolloutGates = {
  readonly smoke: SignalMode
  readonly fivexx: SignalMode
  readonly exceptions: SignalMode
  readonly errorLogs: SignalMode
  readonly nonOk: SignalMode
  readonly burn: SignalMode
  readonly latency: LatencyPolicy
}

/** What a routed-share miss does. It does not advance. */
export type SplitAction = 'hold' | 'rollback'

/** What too few new-version requests does. Rollback is not a choice: thin evidence is not a fault. */
export type EvidenceAction = 'advance' | 'hold'

export type SplitPolicy = {
  /** Half-width of the acceptance band, in standard errors of a binomial at the target percent. */
  readonly z: number
  /** New-version fetch invocations required before a step may advance. */
  readonly minNewRequests: number
  readonly onMismatch: SplitAction
  readonly onInsufficient: EvidenceAction
}

export type RolloutPolicy = {
  readonly steps: readonly RolloutStep[]
  readonly ingestWaitMs: number
  readonly warmupMs: number
  readonly probe: {
    readonly rps: number
    readonly calls: readonly ProbeCall[]
  }
  readonly gates: RolloutGates
  readonly burn: {
    readonly fastBurn: number
    readonly minSamples: number
  }
  readonly split: SplitPolicy
}

export type LoadedPolicy = {
  readonly policy: RolloutPolicy
  readonly sha256: string
  readonly body: Json
}

function reject(path: string, message: string): never {
  throw new Error(`rollout policy ${path}: ${message}`)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(path, 'must be an object')
  return value as Record<string, unknown>
}

function exactKeys(rec: Record<string, unknown>, path: string, keys: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set<string>([...keys, ...optional])
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) reject(`${path}.${key}`, 'unknown field')
  }
  for (const key of keys) {
    if (!(key in rec)) reject(`${path}.${key}`, 'missing')
  }
}

function integer(value: unknown, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) reject(path, `must be an integer >= ${min}`)
  return value
}

function positive(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) reject(path, 'must be a number > 0')
  return value
}

function aboveOne(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 1) reject(path, 'must be a number > 1')
  return value
}

function signal(value: unknown, path: string): SignalMode {
  if (value !== 'hard' && value !== 'informational') reject(path, 'must be hard or informational')
  return value
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  reject(path, `must be ${allowed.join(' or ')}`)
}

function stepsOf(value: unknown): readonly RolloutStep[] {
  if (!Array.isArray(value) || value.length === 0) reject('steps', 'must be a non-empty list')
  const steps: RolloutStep[] = []
  for (let index = 0; index < value.length; index++) {
    const path = `steps[${index}]`
    const rec = record(value[index], path)
    exactKeys(rec, path, ['percent', 'dwellMs'])
    const percent = integer(rec.percent, `${path}.percent`, 1)
    if (percent > 100) reject(`${path}.percent`, 'must be <= 100')
    const dwellMs = integer(rec.dwellMs, `${path}.dwellMs`, 1)
    const previous = steps[steps.length - 1]
    if (previous && percent <= previous.percent) reject(`${path}.percent`, 'steps must be strictly increasing')
    steps.push({ percent, dwellMs })
  }
  const last = steps[steps.length - 1]
  if (!last || last.percent !== 100) reject('steps', 'the last step must be 100')
  return steps
}

/** `/path` plus an optional `?query`. The engine sends this string unchanged. */
const PROBE_PATH = /^\/[^\s?#]*(\?[^\s#]*)?$/

function probePath(value: unknown, path: string): string {
  if (typeof value !== 'string' || !PROBE_PATH.test(value)) {
    reject(path, 'must be a path starting with /, plus an optional query')
  }
  return value
}

function callsOf(value: unknown): readonly ProbeCall[] {
  if (!Array.isArray(value)) reject('probe.calls', 'must be a list')
  return value.map((item, index) => {
    const path = `probe.calls[${index}]`
    const rec = record(item, path)
    exactKeys(rec, path, ['method', 'path', 'auth'])
    if (rec.method !== 'GET' && rec.method !== 'POST') reject(`${path}.method`, 'must be GET or POST')
    const callPath = probePath(rec.path, `${path}.path`)
    if (typeof rec.auth !== 'boolean') reject(`${path}.auth`, 'must be a boolean')
    return { method: rec.method, path: callPath, auth: rec.auth }
  })
}

function latencyOf(value: unknown): LatencyPolicy {
  const rec = record(value, 'gates.latency')
  const mode = rec.mode
  if (mode === 'off' || mode === 'informational') {
    exactKeys(rec, 'gates.latency', ['mode'])
    return { mode }
  }
  if (mode !== 'gate') reject('gates.latency.mode', 'must be off, informational, or gate')
  if (rec.minSamples === undefined || rec.p99Ratio === undefined || rec.effectFloorMs === undefined) {
    reject('gates.latency', 'latency=gate needs minSamples, p99Ratio, and effectFloorMs')
  }
  exactKeys(rec, 'gates.latency', ['mode', 'minSamples', 'p99Ratio', 'effectFloorMs'])
  return {
    mode: 'gate',
    minSamples: integer(rec.minSamples, 'gates.latency.minSamples', 1),
    p99Ratio: aboveOne(rec.p99Ratio, 'gates.latency.p99Ratio'),
    effectFloorMs: positive(rec.effectFloorMs, 'gates.latency.effectFloorMs'),
  }
}

function gatesOf(value: unknown): RolloutGates {
  const rec = record(value, 'gates')
  exactKeys(rec, 'gates', ['smoke', 'fivexx', 'exceptions', 'errorLogs', 'nonOk', 'burn', 'latency'])
  return {
    smoke: signal(rec.smoke, 'gates.smoke'),
    fivexx: signal(rec.fivexx, 'gates.fivexx'),
    exceptions: signal(rec.exceptions, 'gates.exceptions'),
    errorLogs: signal(rec.errorLogs, 'gates.errorLogs'),
    nonOk: signal(rec.nonOk, 'gates.nonOk'),
    burn: signal(rec.burn, 'gates.burn'),
    latency: latencyOf(rec.latency),
  }
}

function splitOf(value: unknown): SplitPolicy {
  const rec = record(value, 'split')
  exactKeys(rec, 'split', ['z', 'minNewRequests', 'onMismatch', 'onInsufficient'])
  return {
    z: positive(rec.z, 'split.z'),
    minNewRequests: integer(rec.minNewRequests, 'split.minNewRequests', 1),
    onMismatch: oneOf(rec.onMismatch, 'split.onMismatch', ['hold', 'rollback']),
    onInsufficient: oneOf(rec.onInsufficient, 'split.onInsufficient', ['advance', 'hold']),
  }
}

function validate(value: unknown): RolloutPolicy {
  const rec = record(value, 'policy')
  exactKeys(rec, 'policy', ['steps', 'ingestWaitMs', 'probe', 'gates', 'burn', 'split'], ['warmupMs'])
  const probe = record(rec.probe, 'probe')
  exactKeys(probe, 'probe', ['rps', 'calls'])
  const rps = probe.rps
  if (typeof rps !== 'number' || !Number.isFinite(rps) || rps < 0) reject('probe.rps', 'must be a number >= 0')
  const calls = callsOf(probe.calls)
  if (rps > 0 && calls.length === 0) reject('probe.calls', 'probe rps needs at least one call')
  const burn = record(rec.burn, 'burn')
  exactKeys(burn, 'burn', ['fastBurn', 'minSamples'])
  return {
    steps: stepsOf(rec.steps),
    ingestWaitMs: integer(rec.ingestWaitMs, 'ingestWaitMs', 0),
    warmupMs: rec.warmupMs === undefined ? 0 : integer(rec.warmupMs, 'warmupMs', 0),
    probe: { rps, calls },
    gates: gatesOf(rec.gates),
    burn: {
      fastBurn: positive(burn.fastBurn, 'burn.fastBurn'),
      minSamples: integer(burn.minSamples, 'burn.minSamples', 1),
    },
    split: splitOf(rec.split),
  }
}

function policyBody(policy: RolloutPolicy): Json {
  const latency: Json = policy.gates.latency.mode === 'gate'
    ? {
      mode: 'gate',
      minSamples: policy.gates.latency.minSamples,
      p99Ratio: policy.gates.latency.p99Ratio,
      effectFloorMs: policy.gates.latency.effectFloorMs,
    }
    : { mode: policy.gates.latency.mode }
  return {
    steps: policy.steps.map(step => ({ percent: step.percent, dwellMs: step.dwellMs })),
    ingestWaitMs: policy.ingestWaitMs,
    warmupMs: policy.warmupMs,
    probe: {
      rps: policy.probe.rps,
      calls: policy.probe.calls.map(call => ({ method: call.method, path: call.path, auth: call.auth })),
    },
    gates: {
      smoke: policy.gates.smoke,
      fivexx: policy.gates.fivexx,
      exceptions: policy.gates.exceptions,
      errorLogs: policy.gates.errorLogs,
      nonOk: policy.gates.nonOk,
      burn: policy.gates.burn,
      latency,
    },
    burn: { fastBurn: policy.burn.fastBurn, minSamples: policy.burn.minSamples },
    split: {
      z: policy.split.z,
      minNewRequests: policy.split.minNewRequests,
      onMismatch: policy.split.onMismatch,
      onInsufficient: policy.split.onInsufficient,
    },
  }
}

/** Parse and validate. The hash is the raw file bytes, so two spellings of the same rules do not share a hash. */
export function parsePolicy(text: string): LoadedPolicy {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error('rollout policy is not JSON')
  }
  const policy = validate(value)
  return { policy, sha256: createHash('sha256').update(text).digest('hex'), body: policyBody(policy) }
}

export function loadPolicy(path: string): LoadedPolicy {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`cannot read rollout policy ${path}`)
  }
  return parsePolicy(text)
}

/** `--policy` is removed before command parsing. A missing or repeated value is an error. */
export function splitPolicy(argv: readonly string[]): { readonly argv: readonly string[]; readonly policyPath: string | null } | { readonly error: string } {
  const kept: string[] = []
  let policyPath: string | null = null
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ''
    if (arg !== '--policy') {
      kept.push(arg)
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) return { error: '--policy needs a path' }
    if (policyPath) return { error: '--policy was given twice' }
    policyPath = value
    index += 1
  }
  return { argv: kept, policyPath }
}
