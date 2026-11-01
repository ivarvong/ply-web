// One traffic writer for the process. A deployment create outside the run log,
// or a percent that this step's decision has not armed, is a harness fault.
// Run 2026-11-01T20-01-08-225Z wrote `ramp … 100%` during the 75% observe window
// with no command event and no state_change.
import { AsyncLocalStorage } from 'node:async_hooks'
import { assertNever } from '../../src/never.ts'
import { activeLog } from './log.ts'
import { commandSinkActive } from './trace.ts'

export class HarnessFault extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'harness_fault'
  }
}

export type WriteIntent =
  | { readonly kind: 'canary' }
  | { readonly kind: 'step'; readonly percent: number }
  | { readonly kind: 'restore'; readonly percent: number }
  | { readonly kind: 'rollback' }

type Arm =
  | { readonly kind: 'idle' }
  | { readonly kind: 'step'; readonly percent: number }
  | { readonly kind: 'observe' }

const intents = new AsyncLocalStorage<WriteIntent>()
const depth = new AsyncLocalStorage<number>()

let arm: Arm = { kind: 'idle' }
let tail: Promise<void> = Promise.resolve()

export function withWriteIntent<T>(intent: WriteIntent, fn: () => Promise<T>): Promise<T> {
  return intents.run(intent, fn)
}

export function activeIntent(): WriteIntent | null {
  const intent = intents.getStore()
  if (intent) return intent
  return null
}

/** The first ramp percent may be written. A second begin without `endRamp` is a fault. */
export function beginRamp(percent: number): void {
  if (arm.kind !== 'idle') throw new HarnessFault(`ramp began while the traffic gate is ${armLabel(arm)}`)
  arm = { kind: 'step', percent }
}

/** The decision for the current step is on the log, so this percent may be written. */
export function armStep(percent: number): void {
  if (arm.kind === 'idle') throw new HarnessFault(`cannot arm ${percent}% outside a ramp`)
  arm = { kind: 'step', percent }
}

/** This percent was applied, or it was already live. Forward writes wait for the next decision. */
export function noteStepApplied(percent: number): void {
  if (arm.kind === 'observe') return
  if (arm.kind === 'step' && arm.percent === percent) {
    arm = { kind: 'observe' }
    return
  }
  throw new HarnessFault(`step ${percent}% was not armed (${armLabel(arm)})`)
}

export function endRamp(): void {
  arm = { kind: 'idle' }
}

/**
 * Process-wide single flight. A create that is already inside the lock
 * (the compare-and-swap calling `cf`) re-enters instead of waiting on itself.
 */
export async function withTrafficLock<T>(body: () => Promise<T>): Promise<T> {
  if (depth.getStore()) return body()
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const previous = tail
  tail = previous.then(() => gate, () => gate)
  await previous
  try {
    return await depth.run(1, body)
  } finally {
    release()
  }
}

function armLabel(current: Arm): string {
  switch (current.kind) {
    case 'idle':
      return 'idle'
    case 'observe':
      return 'observe'
    case 'step':
      return `step ${current.percent}%`
    default:
      return assertNever(current)
  }
}

function intentLabel(intent: WriteIntent): string {
  switch (intent.kind) {
    case 'canary':
      return 'canary'
    case 'rollback':
      return 'rollback'
    case 'step':
      return `step ${intent.percent}%`
    case 'restore':
      return `restore ${intent.percent}%`
    default:
      return assertNever(intent)
  }
}

function refusal(intent: WriteIntent): string | null {
  switch (arm.kind) {
    case 'idle':
      if (intent.kind === 'canary' || intent.kind === 'rollback') return null
      return `deployment write ${intentLabel(intent)} is outside the ramp`
    case 'step':
      if (intent.kind === 'rollback') return null
      if ((intent.kind === 'step' || intent.kind === 'restore') && intent.percent === arm.percent) return null
      return `deployment write ${intentLabel(intent)} is not the armed ${arm.percent}% step`
    case 'observe':
      if (intent.kind === 'rollback') return null
      return `deployment write ${intentLabel(intent)} during observe`
    default:
      return assertNever(arm)
  }
}

/** Call under the traffic lock, immediately before `cf workers deployments create`. */
export function assertDeploymentCreate(): void {
  if (!activeLog()) throw new HarnessFault('cf deployments create with no active log')
  if (!commandSinkActive()) throw new HarnessFault('cf deployments create with no command sink')
  const intent = activeIntent()
  if (!intent) throw new HarnessFault('cf deployments create with no write intent')
  const refused = refusal(intent)
  if (refused) throw new HarnessFault(refused)
  if (intent.kind === 'step' || intent.kind === 'restore') arm = { kind: 'observe' }
}
