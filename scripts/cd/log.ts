import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { asRecord } from './json.ts'
import { RUN_ID } from './run-dir.ts'
import { redact } from './redact.ts'
import { isGitSha, type ReleasePair } from './release.ts'
import type { Fault } from './result.ts'
import { isSecret, type Secret } from './secret.ts'
import type { CommandNote } from './trace.ts'

const observationBrand = Symbol('observation')

/** Returned only by `RunLog.observation`. A decision cannot be built from anything else. */
export type ObservationRef = {
  readonly seq: number
  readonly [observationBrand]: 'observation'
}

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

export type DecisionOutcome = 'advance' | 'hold' | 'insufficient_data' | 'insufficient_samples' | 'rollback' | 'stop' | 'harness_fault' | 'state_conflict' | 'cleanup_leak'

export type RuleRef = {
  readonly name: string
  readonly value: number | string
}

export type StageTiming = {
  readonly name: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
}

export type StepBurn = {
  readonly percent: number
  readonly burns: { readonly [slo: string]: number | null }
}

type Base = {
  readonly seq: number
  readonly ts: string
  readonly run_id: string
  readonly stage: string
}

export type LifecycleStarted = {
  readonly event: 'run_started'
  readonly config: Json
  readonly tools: { readonly node: string; readonly cf: string; readonly git: string }
  readonly plySha: string | null
  readonly plyWebSha: string
  readonly host: string
  /** The release this run is shipping. Null on a command that does not deploy. */
  readonly release: ReleasePair | null
}

export type LifecycleFinished = {
  readonly event: 'run_finished'
  readonly verdict: 'pass' | 'fail'
  readonly reason: string | null
  readonly rolledBack: boolean
  readonly rollbackReason: string | null
  readonly versionId: string | null
  readonly plySha: string | null
  readonly plyMergedAt: string | null
  readonly plyWebSha: string
  readonly release: ReleasePair | null
  readonly smoke: { readonly passed: number; readonly failed: number }
  readonly stages: readonly StageTiming[]
  readonly steps: readonly StepBurn[]
  readonly liveAt: string | null
  readonly failedAt: string | null
  readonly restoredAt: string | null
  /** Null on a pass. `harness_fault` is a script, query, or join error and is not a change failure. */
  readonly fault: Fault | null
}

/** Appended when `--sha` continues an unfinished run. The run id stays the one on this log. */
export type LifecycleResumed = {
  readonly event: 'resumed'
  readonly sha: string
  readonly release: ReleasePair | null
}

export type CdEvent =
  | (Base & { readonly kind: 'lifecycle'; readonly payload: LifecycleStarted | LifecycleFinished | LifecycleResumed })
  | (Base & {
    readonly kind: 'command'
    readonly payload: {
      readonly argv: readonly string[]
      readonly cwd: string
      readonly exitCode: number
      readonly durationMs: number
      readonly stdoutDigest: string
      readonly stderrDigest: string
      readonly stdoutPath: string
      readonly stderrPath: string
    }
  })
  | (Base & {
    readonly kind: 'observation'
    readonly payload: {
      readonly measurement: Json
      readonly query: Json
      readonly window: { readonly from: string; readonly to: string }
      readonly responsePath: string
    }
  })
  | (Base & {
    readonly kind: 'decision'
    readonly payload: {
      readonly inputs: readonly number[]
      readonly rules: readonly RuleRef[]
      readonly outcome: DecisionOutcome
      readonly reason: string
    }
  })
  | (Base & {
    readonly kind: 'state_change'
    readonly payload: {
      readonly before: readonly { readonly versionId: string; readonly percentage: number }[]
      readonly after: readonly { readonly versionId: string; readonly percentage: number }[]
      readonly deploymentId: string | null
    }
  })
  | (Base & {
    readonly kind: 'request'
    readonly payload: {
      readonly method: string
      readonly url: string
      readonly status: number
      readonly version: string | null
      readonly latencyMs: number
      readonly cfRay: string | null
      readonly requestId: string | null
      readonly artifactsRay: string | null
    }
  })
  | (Base & { readonly kind: 'error'; readonly payload: { readonly message: string; readonly context: Json } })
  | (Base & { readonly kind: 'annotation'; readonly payload: { readonly note: 'false_positive'; readonly reason: string } })
  | (Base & { readonly kind: 'policy'; readonly payload: { readonly sha256: string; readonly path: string; readonly body: Json; readonly release: ReleasePair | null } })

export type RunFacts = {
  versionId: string | null
  plySha: string | null
  plyMergedAt: string | null
  plyWebSha: string
  release: ReleasePair | null
  rolledBack: boolean
  rollbackReason: string | null
  smokePassed: number
  smokeFailed: number
  stages: StageTiming[]
  steps: StepBurn[]
  liveAt: string | null
  failedAt: string | null
  restoredAt: string | null
  fault: Fault | null
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/
const OUTCOMES = new Set<DecisionOutcome>(['advance', 'hold', 'insufficient_data', 'insufficient_samples', 'rollback', 'stop', 'harness_fault', 'state_conflict', 'cleanup_leak'])
const FAULTS = new Set<Fault>(['worker', 'harness_fault', 'state_conflict', 'insufficient_samples'])

export function isoOffset(date: Date): string {
  const pad = (value: number, width = 2) => String(Math.trunc(Math.abs(value))).padStart(width, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.trunc(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function freezeJson(value: unknown, path: string): Json {
  if (isSecret(value)) throw new Error(`Secret at ${path} cannot be recorded`)
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => freezeJson(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    const out: { [key: string]: Json } = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = freezeJson(item, `${path}.${key}`)
    }
    return out
  }
  throw new Error(`value at ${path} is not JSON`)
}

function needRecord(value: unknown, what: string): Record<string, unknown> {
  const rec = asRecord(value)
  if (!rec) throw new Error(`${what} is not an object`)
  return rec
}

function needString(rec: Record<string, unknown>, key: string): string {
  const value = rec[key]
  if (typeof value !== 'string') throw new Error(`${key} is not a string`)
  return value
}

function needNumber(rec: Record<string, unknown>, key: string): number {
  const value = rec[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} is not a number`)
  return value
}

function needBoolean(rec: Record<string, unknown>, key: string): boolean {
  const value = rec[key]
  if (typeof value !== 'boolean') throw new Error(`${key} is not a boolean`)
  return value
}

function jsonValue(value: unknown, path: string): Json {
  return freezeJson(value, path)
}

function stringOrNull(value: unknown, key: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${key} is not a string`)
  return value
}

function shares(value: unknown, key: string): { versionId: string; percentage: number }[] {
  if (!Array.isArray(value)) throw new Error(`${key} is not a list`)
  return value.map((item, index) => {
    const rec = needRecord(item, `${key}[${index}]`)
    return { versionId: needString(rec, 'versionId'), percentage: needNumber(rec, 'percentage') }
  })
}

function rules(value: unknown): RuleRef[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('a decision needs a rule')
  return value.map((item, index) => {
    const rec = needRecord(item, `rules[${index}]`)
    const ruleValue = rec.value
    if (typeof ruleValue !== 'number' && typeof ruleValue !== 'string') throw new Error('rule value is not a number or string')
    if (typeof ruleValue === 'number' && !Number.isFinite(ruleValue)) throw new Error('rule value is not finite')
    return { name: needString(rec, 'name'), value: ruleValue }
  })
}

function parseFault(value: unknown): Fault | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && FAULTS.has(value as Fault)) return value as Fault
  throw new Error('fault is not a known kind')
}

function parseRelease(value: unknown): ReleasePair | null {
  if (value === undefined || value === null) return null
  const rec = asRecord(value)
  if (!rec) throw new Error('release is not a pair')
  const ply = needString(rec, 'ply')
  const web = needString(rec, 'web')
  if (!isGitSha(ply) || !isGitSha(web)) throw new Error('release shas must be 40 hex')
  return { ply, web }
}

function parseLifecycle(payload: Record<string, unknown>): LifecycleStarted | LifecycleFinished | LifecycleResumed {
  const event = needString(payload, 'event')
  if (event === 'run_started') {
    const tools = needRecord(payload.tools, 'tools')
    return {
      event,
      config: jsonValue(payload.config, 'config'),
      tools: { node: needString(tools, 'node'), cf: needString(tools, 'cf'), git: needString(tools, 'git') },
      plySha: stringOrNull(payload.plySha, 'plySha'),
      plyWebSha: needString(payload, 'plyWebSha'),
      host: needString(payload, 'host'),
      release: parseRelease(payload.release),
    }
  }
  if (event === 'resumed') return { event, sha: needString(payload, 'sha'), release: parseRelease(payload.release) }
  if (event === 'run_finished') {
    const smoke = needRecord(payload.smoke, 'smoke')
    if (!Array.isArray(payload.stages) || !Array.isArray(payload.steps)) throw new Error('run_finished needs stages and steps')
    return {
      event,
      verdict: payload.verdict === 'pass' || payload.verdict === 'fail' ? payload.verdict : (() => { throw new Error('verdict is not pass or fail') })(),
      reason: stringOrNull(payload.reason, 'reason'),
      rolledBack: needBoolean(payload, 'rolledBack'),
      rollbackReason: stringOrNull(payload.rollbackReason, 'rollbackReason'),
      versionId: stringOrNull(payload.versionId, 'versionId'),
      plySha: stringOrNull(payload.plySha, 'plySha'),
      plyMergedAt: stringOrNull(payload.plyMergedAt, 'plyMergedAt'),
      plyWebSha: needString(payload, 'plyWebSha'),
      release: parseRelease(payload.release),
      smoke: { passed: needNumber(smoke, 'passed'), failed: needNumber(smoke, 'failed') },
      stages: payload.stages.map((item, index) => {
        const rec = needRecord(item, `stages[${index}]`)
        return {
          name: needString(rec, 'name'),
          startedAt: needString(rec, 'startedAt'),
          finishedAt: needString(rec, 'finishedAt'),
          durationMs: needNumber(rec, 'durationMs'),
        }
      }),
      steps: payload.steps.map((item, index) => {
        const rec = needRecord(item, `steps[${index}]`)
        const burns = needRecord(rec.burns, 'burns')
        const mapped: { [slo: string]: number | null } = {}
        for (const [key, burn] of Object.entries(burns)) {
          if (burn !== null && (typeof burn !== 'number' || !Number.isFinite(burn))) throw new Error(`burn ${key} is not a number`)
          mapped[key] = burn === null ? null : burn
        }
        return { percent: needNumber(rec, 'percent'), burns: mapped }
      }),
      liveAt: stringOrNull(payload.liveAt, 'liveAt'),
      failedAt: stringOrNull(payload.failedAt, 'failedAt'),
      restoredAt: stringOrNull(payload.restoredAt, 'restoredAt'),
      fault: parseFault(payload.fault),
    }
  }
  throw new Error(`unknown lifecycle event ${event}`)
}

function parsePayload(kind: CdEvent['kind'], payload: unknown): CdEvent['payload'] {
  const rec = needRecord(payload, kind)
  if (kind === 'lifecycle') return parseLifecycle(rec)
  if (kind === 'command') {
    if (!Array.isArray(rec.argv) || rec.argv.some(part => typeof part !== 'string')) throw new Error('argv is not a list of strings')
    return {
      argv: rec.argv,
      cwd: needString(rec, 'cwd'),
      exitCode: needNumber(rec, 'exitCode'),
      durationMs: needNumber(rec, 'durationMs'),
      stdoutDigest: needString(rec, 'stdoutDigest'),
      stderrDigest: needString(rec, 'stderrDigest'),
      stdoutPath: needString(rec, 'stdoutPath'),
      stderrPath: needString(rec, 'stderrPath'),
    }
  }
  if (kind === 'observation') {
    const window = needRecord(rec.window, 'window')
    return {
      measurement: jsonValue(rec.measurement, 'measurement'),
      query: jsonValue(rec.query, 'query'),
      window: { from: needString(window, 'from'), to: needString(window, 'to') },
      responsePath: needString(rec, 'responsePath'),
    }
  }
  if (kind === 'decision') {
    if (!Array.isArray(rec.inputs) || rec.inputs.length === 0 || rec.inputs.some(item => typeof item !== 'number')) {
      throw new Error('a decision needs an observation')
    }
    const outcome = needString(rec, 'outcome')
    if (!OUTCOMES.has(outcome as DecisionOutcome)) throw new Error(`unknown decision outcome ${outcome}`)
    return { inputs: rec.inputs, rules: rules(rec.rules), outcome: outcome as DecisionOutcome, reason: needString(rec, 'reason') }
  }
  if (kind === 'state_change') {
    return {
      before: shares(rec.before, 'before'),
      after: shares(rec.after, 'after'),
      deploymentId: stringOrNull(rec.deploymentId, 'deploymentId'),
    }
  }
  if (kind === 'request') {
    return {
      method: needString(rec, 'method'),
      url: needString(rec, 'url'),
      status: needNumber(rec, 'status'),
      version: stringOrNull(rec.version, 'version'),
      latencyMs: needNumber(rec, 'latencyMs'),
      cfRay: stringOrNull(rec.cfRay, 'cfRay'),
      requestId: stringOrNull(rec.requestId, 'requestId'),
      artifactsRay: stringOrNull(rec.artifactsRay, 'artifactsRay'),
    }
  }
  if (kind === 'annotation') {
    const note = needString(rec, 'note')
    if (note !== 'false_positive') throw new Error(`unknown annotation ${note}`)
    const reason = needString(rec, 'reason')
    if (!reason.trim()) throw new Error('annotation reason is empty')
    return { note: 'false_positive', reason }
  }
  if (kind === 'policy') {
    const sha256 = needString(rec, 'sha256')
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('policy sha256 is not 64 hex')
    return { sha256, path: needString(rec, 'path'), body: jsonValue(rec.body, 'body'), release: parseRelease(rec.release) }
  }
  return { message: needString(rec, 'message'), context: jsonValue(rec.context, 'context') }
}

/** One event object. Throws when the shape is not the log ADT. */
export function parseEvent(value: unknown): CdEvent {
  const rec = needRecord(value, 'event')
  const kind = needString(rec, 'kind')
  const known = ['lifecycle', 'command', 'observation', 'decision', 'state_change', 'request', 'error', 'annotation', 'policy']
  if (!known.includes(kind)) throw new Error(`unknown event kind ${kind}`)
  const ts = needString(rec, 'ts')
  if (!ISO.test(ts)) throw new Error('ts is not an ISO timestamp with a numeric offset')
  const event = {
    seq: needNumber(rec, 'seq'),
    ts,
    run_id: needString(rec, 'run_id'),
    stage: needString(rec, 'stage'),
    kind,
    payload: parsePayload(kind as CdEvent['kind'], rec.payload),
  }
  return event as CdEvent
}

/**
 * Append a false-positive note for a past run. The line is added to the ledger.
 * Earlier lines are not rewritten, and the sealed run directory is not opened.
 */
export async function appendFalsePositive(ledgerPath: string, runId: string, reason: string, now = new Date()): Promise<CdEvent> {
  if (!RUN_ID.test(runId)) throw new Error('run id must look like 2026-11-01T00-10-02-620Z')
  const trimmed = reason.trim()
  if (!trimmed || /[\n\r]/.test(reason)) throw new Error('false-positive reason must be one line')
  let seq = 1
  try {
    const text = await readFile(ledgerPath, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const event = parseEvent(JSON.parse(line) as unknown)
        if (event.run_id === runId && event.seq >= seq) seq = event.seq + 1
      } catch {
        // A bad ledger line stays where it is. The annotation is still appended.
      }
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
    if (code !== 'ENOENT') throw error
  }
  const event: CdEvent = {
    seq,
    ts: isoOffset(now),
    run_id: runId,
    stage: 'run',
    kind: 'annotation',
    payload: { note: 'false_positive', reason: trimmed },
  }
  await mkdir(dirname(ledgerPath), { recursive: true })
  await appendFile(ledgerPath, JSON.stringify(event) + '\n')
  return event
}

/** Seq starts at 1 and each decision cites an earlier observation in this run. */
export function validateRun(events: readonly CdEvent[]): void {
  let expected = 1
  let runId = ''
  const observations = new Set<number>()
  for (const event of events) {
    if (event.seq !== expected) throw new Error(`expected seq ${expected}, saw ${event.seq}`)
    expected += 1
    if (!runId) runId = event.run_id
    if (event.run_id !== runId) throw new Error('run log has two run ids')
    if (event.kind === 'observation') observations.add(event.seq)
    if (event.kind === 'decision') {
      for (const input of event.payload.inputs) {
        if (!observations.has(input) || input >= event.seq) {
          throw new Error(`decision ${event.seq} cites ${input}, which is not an earlier observation`)
        }
      }
    }
  }
}

export async function readEvents(dir: string): Promise<CdEvent[]> {
  const text = await readFile(join(dir, 'events.jsonl'), 'utf8')
  const events: CdEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    events.push(parseEvent(JSON.parse(line) as unknown))
  }
  validateRun(events)
  return events
}

function isObservationRef(value: unknown): value is ObservationRef {
  return typeof value === 'object' && value !== null && (value as { [observationBrand]?: unknown })[observationBrand] === 'observation'
}

function scrub(text: string, secrets: readonly string[]): string {
  return redact(text, secrets)
}

async function filesIn(dir: string, root = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await filesIn(path, root))
    else if (entry.isFile() && entry.name !== 'manifest.json') out.push(relative(root, path))
  }
  return out.sort()
}

export class RunLog {
  readonly #dir: string
  readonly #ledger: string
  readonly #runId: string
  readonly #concealed: string[] = []
  #stage = 'run'
  #seq = 1
  #tail: Promise<void> = Promise.resolve()
  #events: CdEvent[] = []
  #started = false
  #finished = false
  #sealed = false
  readonly facts: RunFacts = {
    versionId: null,
    plySha: null,
    plyMergedAt: null,
    plyWebSha: 'unknown',
    release: null,
    rolledBack: false,
    rollbackReason: null,
    smokePassed: 0,
    smokeFailed: 0,
    stages: [],
    steps: [],
    liveAt: null,
    failedAt: null,
    restoredAt: null,
    fault: null,
  }

  private constructor(dir: string, ledger: string, runId: string) {
    this.#dir = dir
    this.#ledger = ledger
    this.#runId = runId
  }

  static async open(dir: string, ledger: string, runId: string): Promise<RunLog> {
    await mkdir(dir, { recursive: true })
    return new RunLog(dir, ledger, runId)
  }

  /** Continue an unfinished run. Seq follows the last event. A sealed log is not reopened here. */
  static async reopen(dir: string, ledger: string): Promise<RunLog> {
    const events = await readEvents(dir)
    const first = events[0]
    if (!first) throw new Error('run has no events')
    const log = new RunLog(dir, ledger, first.run_id)
    log.#events = events.slice()
    log.#seq = (events[events.length - 1]?.seq ?? 0) + 1
    log.#started = events.some(event => event.kind === 'lifecycle' && event.payload.event === 'run_started')
    log.#finished = events.some(event => event.kind === 'lifecycle' && event.payload.event === 'run_finished')
    const started = events.find(event => event.kind === 'lifecycle' && event.payload.event === 'run_started')
    if (started && started.kind === 'lifecycle' && started.payload.event === 'run_started') {
      log.facts.plySha = started.payload.plySha
      log.facts.plyWebSha = started.payload.plyWebSha
      log.facts.release = started.payload.release
    }
    return log
  }

  get runId(): string {
    return this.#runId
  }

  get dir(): string {
    return this.#dir
  }

  get finished(): boolean {
    return this.#finished
  }

  get sealed(): boolean {
    return this.#sealed
  }

  recorded(): readonly CdEvent[] {
    return this.#events
  }

  /** Remember a credential so a later line cannot contain it. The value is not written. */
  conceal(value: string): void {
    if (value.length >= 8) this.#concealed.push(value)
  }

  concealSecret(secret: Secret): void {
    this.conceal(secret.reveal())
  }

  useStage(stage: string): void {
    this.#stage = stage
  }

  patch(partial: Partial<RunFacts>): void {
    Object.assign(this.facts, partial)
  }

  addStage(timing: StageTiming): void {
    this.facts.stages.push(timing)
  }

  addStep(step: StepBurn): void {
    this.facts.steps.push(step)
  }

  addSmoke(passed: number, failed: number): void {
    this.facts.smokePassed += passed
    this.facts.smokeFailed += failed
  }

  async resumed(sha: string, release: ReleasePair | null = null): Promise<void> {
    await this.#enqueue(async () => {
      await this.#append('lifecycle', { event: 'resumed', sha, release }, 'run')
    })
  }

  async recordPolicy(input: { readonly sha256: string; readonly path: string; readonly body: Json; readonly release?: ReleasePair | null }): Promise<void> {
    await this.#enqueue(async () => {
      await this.#append('policy', { sha256: input.sha256, path: input.path, body: input.body, release: input.release ?? null }, 'run')
    })
  }

  async started(input: Omit<LifecycleStarted, 'event' | 'release'> & { readonly release?: ReleasePair | null }): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#started) throw new Error('run already started')
      this.#started = true
      this.facts.plySha = input.plySha
      this.facts.plyWebSha = input.plyWebSha
      this.facts.release = input.release ?? null
      await this.#append('lifecycle', { event: 'run_started', ...input, release: input.release ?? null }, 'run')
    })
  }

  async finish(code: number, reason: string | null): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#finished) return
      this.#finished = true
      const payload: LifecycleFinished = {
        event: 'run_finished',
        verdict: code === 0 ? 'pass' : 'fail',
        reason,
        rolledBack: this.facts.rolledBack,
        rollbackReason: this.facts.rollbackReason,
        versionId: this.facts.versionId,
        plySha: this.facts.plySha,
        plyMergedAt: this.facts.plyMergedAt,
        plyWebSha: this.facts.plyWebSha,
        release: this.facts.release,
        smoke: { passed: this.facts.smokePassed, failed: this.facts.smokeFailed },
        stages: this.facts.stages,
        steps: this.facts.steps,
        liveAt: this.facts.liveAt,
        failedAt: this.facts.failedAt,
        restoredAt: this.facts.restoredAt,
        fault: this.facts.fault,
      }
      await this.#append('lifecycle', payload, 'run')
    })
  }

  /** Hash every file except the manifest, then refuse further writes. */
  async seal(): Promise<void> {
    await this.#enqueue(async () => {
      if (!this.#finished) throw new Error('seal requires run_finished')
      if (this.#sealed) return
      const files = await filesIn(this.#dir)
      const listed: { [path: string]: string } = {}
      for (const file of files) {
        const bytes = await readFile(join(this.#dir, file))
        listed[file] = createHash('sha256').update(bytes).digest('hex')
      }
      const manifest = { run_id: this.#runId, sealed_at: isoOffset(new Date()), files: listed }
      await writeFile(join(this.#dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
      this.#sealed = true
    })
  }

  async noteCommand(note: CommandNote): Promise<void> {
    await this.#enqueue(async () => {
      const seq = this.#seq
      for (const part of note.argv) if (isSecret(part)) this.conceal(part.reveal())
      const argv = note.argv.map(part => (isSecret(part) ? '<redacted>' : part))
      const stdout = scrub(note.stdout, this.#concealed)
      const stderr = scrub(note.stderr, this.#concealed)
      const stdoutPath = `captures/${seq}.stdout`
      const stderrPath = `captures/${seq}.stderr`
      await mkdir(join(this.#dir, 'captures'), { recursive: true })
      await writeFile(join(this.#dir, stdoutPath), stdout)
      await writeFile(join(this.#dir, stderrPath), stderr)
      await this.#append('command', {
        argv,
        cwd: note.cwd,
        exitCode: note.exitCode,
        durationMs: note.durationMs,
        stdoutDigest: sha256(stdout),
        stderrDigest: sha256(stderr),
        stdoutPath,
        stderrPath,
      })
    })
  }

  async observation(input: {
    readonly measurement: unknown
    readonly query: unknown
    readonly from: number
    readonly to: number
    readonly raw: string
  }): Promise<ObservationRef> {
    return this.#enqueue(async () => {
      const seq = this.#seq
      const responsePath = `raw/${seq}.json`
      await mkdir(join(this.#dir, 'raw'), { recursive: true })
      await writeFile(join(this.#dir, responsePath), scrub(input.raw, this.#concealed))
      await this.#append('observation', {
        measurement: input.measurement,
        query: input.query,
        window: { from: isoOffset(new Date(input.from)), to: isoOffset(new Date(input.to)) },
        responsePath,
      })
      const ref: ObservationRef = { seq, [observationBrand]: 'observation' }
      return ref
    })
  }

  async decision(input: {
    readonly inputs: readonly [ObservationRef, ...ObservationRef[]]
    readonly rules: readonly [RuleRef, ...RuleRef[]]
    readonly outcome: DecisionOutcome
    readonly reason: string
  }): Promise<void> {
    await this.#enqueue(async () => {
      if (input.inputs.length === 0) throw new Error('a decision needs an observation')
      const seqs: number[] = []
      for (const ref of input.inputs) {
        if (!isObservationRef(ref)) throw new Error('a decision input must be an observation')
        const prior = this.#events.find(event => event.seq === ref.seq)
        if (!prior || prior.kind !== 'observation') throw new Error(`decision input ${ref.seq} is not an observation`)
        seqs.push(ref.seq)
      }
      if (input.rules.length === 0) throw new Error('a decision needs a rule')
      await this.#append('decision', {
        inputs: seqs,
        rules: input.rules,
        outcome: input.outcome,
        reason: input.reason,
      })
    })
  }

  async stateChange(input: {
    readonly before: readonly { readonly versionId: string; readonly percentage: number }[]
    readonly after: readonly { readonly versionId: string; readonly percentage: number }[]
    readonly deploymentId: string | null
  }): Promise<void> {
    await this.#enqueue(async () => {
      await this.#append('state_change', input)
    })
  }

  async request(input: {
    readonly method: string
    readonly url: string
    readonly status: number
    readonly version: string | null
    readonly latencyMs: number
    readonly cfRay: string | null
    readonly requestId: string | null
    readonly artifactsRay: string | null
  }): Promise<void> {
    await this.#enqueue(async () => {
      await this.#append('request', input)
    })
  }

  async error(message: string, context: unknown): Promise<void> {
    await this.#enqueue(async () => {
      await this.#append('error', { message, context })
    })
  }

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.#sealed) return Promise.reject(new Error('run log is sealed'))
    const run = this.#tail.then(job, job)
    this.#tail = run.then(() => undefined, () => undefined)
    return run
  }

  async #append(kind: CdEvent['kind'], payload: unknown, stage = this.#stage): Promise<void> {
    if (this.#sealed) throw new Error('run log is sealed')
    const event = {
      seq: this.#seq,
      ts: isoOffset(new Date()),
      run_id: this.#runId,
      stage,
      kind,
      payload: freezeJson(payload, kind),
    }
    this.#seq += 1
    const line = scrub(JSON.stringify(event), this.#concealed)
    const parsed = parseEvent(JSON.parse(line) as unknown)
    await appendFile(join(this.#dir, 'events.jsonl'), line + '\n')
    await mkdir(dirname(this.#ledger), { recursive: true })
    await appendFile(this.#ledger, line + '\n')
    this.#events.push(parsed)
  }
}

const runs = new AsyncLocalStorage<RunLog>()

/** Stages record into the log that `fn` sees. A test that does not open a run records nothing. */
export function withRun<T>(log: RunLog, fn: () => Promise<T>): Promise<T> {
  return runs.run(log, fn)
}

export function activeLog(): RunLog | undefined {
  return runs.getStore()
}
