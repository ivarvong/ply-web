import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_PREFIX, REVOKE_ATTEMPTS, REVOKE_PROBE_MS, REVOKE_WAIT_MS, SMOKE_HTTP_MS, SMOKE_REISSUE_ATTEMPTS, SMOKE_REISSUE_WAIT_MS, SMOKE_RESTARTS, TOKEN_TTL_SECONDS } from './baseline.ts'
import { clientHealth, type StallSource } from './client-health.ts'
import { confirmRoute, logRoute } from './route-confirm.ts'
import { cfOk, runCf } from './cf.ts'
import {
  appendCleanupFile,
  confirmDelete,
  recordCleanup,
  reposFromList,
  sweepLeaks,
  type CleanupBound,
  type CleanupResult,
  type DeleteCommand,
  type SweepReport,
} from './cleanup.ts'
import { artifactsProbeUrl, classifyCall, openingRevokeResult, revokeConfirmed, type FailureClass } from './classify.ts'
import { csvDocument, type CsvRow } from './csv.ts'
import { asRecord, extractJson } from './json.ts'
import { judgeCall, type Saved } from './judge.ts'
import { expectedStatuses, lifecycle, type HttpStep } from './lifecycle.ts'
import { activeLog } from './log.ts'
import { assertNever } from '../../src/never.ts'
import { errorMessage, run } from './proc.ts'
import { createdTokenSecret, harvestSecrets, redact } from './redact.ts'
import { judgeFsck, judgeRefs, parseShowRef, type ApiRefs } from './refs.ts'
import { fail, pass, type StageResult } from './result.ts'
import type { Secret } from './secret.ts'
import { writeJson, writeText } from './run-dir.ts'
import { CORRECTNESS } from './slo.ts'
import type { SmokeRequest } from './telemetry.ts'
import type { CdConfig } from './config.ts'

export type SmokeReport = {
  readonly version: string | null
  readonly repo: string
  readonly deleted: boolean
  /** Scratch repos whose delete could not be confirmed. Informational: it does not fail a pass. */
  readonly cleanup_leak: readonly string[]
  readonly requests: readonly SmokeRequest[]
  readonly refs: ApiRefs | null
  readonly detail: string
  readonly passed: number
  readonly failed: number
  /** Rows answered by another version or lost while the client stalled: re-issued or restarted, never counted. */
  readonly harnessEvents: number
  /** Lifecycle restarts on a new scratch repo after a write met a harness event. */
  readonly restarts: number
  /** Scratch repos of discarded attempts (deleted). */
  readonly discarded: readonly string[]
}

export type SweepRun =
  | { readonly kind: 'swept'; readonly deleted: readonly string[]; readonly leaks: readonly string[] }
  | { readonly kind: 'unlistable'; readonly detail: string }

const REMOTE = /^https:\/\/[a-z0-9]+\.artifacts\.cloudflare\.net\/git\//

function header(response: Response, name: string): string | null {
  const value = response.headers.get(name)
  return value === null || value === '' ? null : value
}

function findRemote(value: unknown): string | null {
  if (typeof value === 'string') return REMOTE.test(value) ? value : null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRemote(item)
      if (found) return found
    }
    return null
  }
  const rec = asRecord(value)
  if (!rec) return null
  for (const item of Object.values(rec)) {
    const found = findRemote(item)
    if (found) return found
  }
  return null
}

function tokenIds(value: unknown): string[] {
  const ids: string[] = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const rec = asRecord(node)
    if (!rec) return
    if (typeof rec.id === 'string' && rec.id !== '') ids.push(rec.id)
    for (const item of Object.values(rec)) visit(item)
  }
  visit(value)
  return ids
}

function remember(value: unknown, secrets: string[]): ReturnType<typeof harvestSecrets> {
  const found = harvestSecrets(value)
  for (const secret of found) {
    secrets.push(secret.reveal())
    activeLog()?.concealSecret(secret)
  }
  return found
}

async function cfJson(args: readonly string[], secrets: readonly string[]): Promise<unknown> {
  const stdout = await cfOk(args, secrets)
  return extractJson(stdout)
}

/** After revoke, the minted bearer must be refused. The token is sent and never recorded. */
async function proveRevoked(remote: string, secret: Secret): Promise<boolean> {
  const url = artifactsProbeUrl(remote)
  const started = Date.now()
  let status = 0
  let cfRay: string | null = null
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${secret.reveal()}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(REVOKE_PROBE_MS),
    })
    status = response.status
    cfRay = header(response, 'cf-ray')
    try {
      await response.body?.cancel()
    } catch {
      // The status is what the check records. The body is not.
    }
  } catch {
    status = 0
  }
  await activeLog()?.request({
    method: 'GET',
    url,
    status,
    version: null,
    latencyMs: Date.now() - started,
    cfRay,
    requestId: null,
    artifactsRay: null,
  })
  return revokeConfirmed(status)
}

async function revoke(config: CdConfig, id: string, secrets: readonly string[]): Promise<boolean> {
  for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt++) {
    const result = await runCf(['artifacts', 'namespaces', 'tokens', 'revoke', id, '--namespace', config.namespace, '--force'], secrets)
    if (result.code === 0) return true
    await new Promise(resolve => setTimeout(resolve, REVOKE_WAIT_MS))
  }
  return false
}

async function listTokenIds(config: CdConfig, name: string, secrets: readonly string[]): Promise<string[]> {
  const listed = await runCf([
    'artifacts', 'namespaces', 'repos', 'tokens', 'list',
    '--namespace', config.namespace, '--name', name, '--state', 'active',
  ], secrets)
  if (listed.code !== 0) return []
  try {
    return tokenIds(extractJson(listed.stdout))
  } catch {
    return []
  }
}

function cleanupBound(config: CdConfig): CleanupBound {
  return { attempts: config.policy.cleanup.attempts, backoffMs: config.policy.cleanup.backoffMs }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

async function deleteOnce(name: string, config: CdConfig, secrets: readonly string[]): Promise<DeleteCommand> {
  const started = Date.now()
  const removed = await runCf(['artifacts', 'namespaces', 'repos', 'delete', name, '--namespace', config.namespace, '--force'], secrets)
  return { code: removed.code, stdout: removed.stdout, stderr: removed.stderr, latencyMs: Date.now() - started }
}

async function noteCleanup(result: CleanupResult, bound: CleanupBound): Promise<void> {
  const log = activeLog()
  if (!log) return
  await recordCleanup(log, result, bound)
}

async function sweep(config: CdConfig, secrets: readonly string[]): Promise<SweepReport | null> {
  const listed = await runCf(['artifacts', 'namespaces', 'repos', 'list', '--namespace', config.namespace, '--search', REPO_PREFIX], secrets)
  if (listed.code !== 0) return null
  let parsed: unknown
  try {
    parsed = extractJson(listed.stdout)
  } catch {
    return null
  }
  const bound = cleanupBound(config)
  return sweepLeaks({
    listed: reposFromList(parsed),
    nowMs: Date.now(),
    staleMs: config.policy.cleanup.staleMinutes * 60_000,
    prefix: REPO_PREFIX,
    bound,
    once: name => deleteOnce(name, config, secrets),
    sleep: wait,
    note: result => noteCleanup(result, bound),
  })
}

/** Delete leaked `ply-web-cd-*` repos older than `cleanup.staleMinutes`. A leak stays informational. */
export async function stageSweep(config: CdConfig, runDir: string): Promise<SweepRun> {
  const listed = await runCf(['artifacts', 'namespaces', 'repos', 'list', '--namespace', config.namespace, '--search', REPO_PREFIX], [])
  if (listed.code !== 0) {
    const detail = listed.stderr.replace(/\s+/g, ' ').trim().slice(0, 300)
    return { kind: 'unlistable', detail: detail.length === 0 ? `cf list exited ${listed.code}` : detail }
  }
  let parsed: unknown
  try {
    parsed = extractJson(listed.stdout)
  } catch (error) {
    return { kind: 'unlistable', detail: errorMessage(error) }
  }
  const bound = cleanupBound(config)
  const report = await sweepLeaks({
    listed: reposFromList(parsed),
    nowMs: Date.now(),
    staleMs: config.policy.cleanup.staleMinutes * 60_000,
    prefix: REPO_PREFIX,
    bound,
    once: name => deleteOnce(name, config, []),
    sleep: wait,
    note: result => noteCleanup(result, bound),
  })
  await appendCleanupFile(runDir, report.leaks)
  await writeJson(runDir, 'verdict.json', {
    kind: 'pass',
    failures: [],
    cleanup_leak: report.leaks,
    deleted: report.deleted,
  })
  return { kind: 'swept', deleted: report.deleted, leaks: report.leaks }
}

function stepPath(step: HttpStep): string {
  const params = new URLSearchParams(step.query ?? {})
  const query = params.toString()
  return query ? `${step.path}?${query}` : step.path
}

export type CallResult = {
  readonly started: number
  readonly ended: number
  /** `x-ply-version` of the response, null when there was none (or no response). */
  readonly served: string | null
  readonly row: CsvRow
  readonly judgementDetail: string
  readonly ok: boolean
  readonly save: Saved
  readonly request: SmokeRequest | null
  readonly refs: ApiRefs | null
  readonly fault: FailureClass | null
}

/**
 * A row that is not evidence about the version under test. `wrong_version`: another version answered (the override or
 * the new split was not yet on that edge machine). `client_stall`: no response while this process was stalled
 * (client-health.ts). Either is re-issued or restarts the attempt; neither is a pass or a product failure.
 */
export type HarnessEvent =
  | { readonly kind: 'wrong_version'; readonly served: string; readonly detail: string }
  | { readonly kind: 'client_stall'; readonly stalledMs: number; readonly detail: string }

export function harnessEvent(
  call: { readonly started: number; readonly ended: number; readonly served: string | null; readonly status: number },
  version: string | null,
  health: StallSource,
): HarnessEvent | null {
  if (call.status !== 0 && version !== null && call.served !== null && call.served !== version) {
    return { kind: 'wrong_version', served: call.served, detail: `routing: answered by ${call.served}, wanted ${version}` }
  }
  if (call.status === 0) {
    const stalls = health.during(call.started, call.ended)
    if (stalls.length > 0) {
      const stalledMs = health.stalledMs(call.started, call.ended)
      return { kind: 'client_stall', stalledMs, detail: `client stall: no response while the harness was stalled ${stalledMs} ms` }
    }
  }
  return null
}

/** Re-issue a GET; restart the attempt (fresh scratch repo) for anything else, since a write may have landed. */
export function reissuable(step: { readonly method: string }): boolean {
  return step.method === 'GET'
}

async function oneCall(
  config: CdConfig,
  step: HttpStep,
  saved: Saved,
  remote: string,
  token: string,
  gitToken: string,
  version: string | null,
  pin: boolean,
): Promise<CallResult> {
  const started = Date.now()
  const params = new URLSearchParams({ remote, ...(step.query ?? {}) })
  const url = `${config.baseUrl}${step.path}?${params.toString()}`
  const headers: Record<string, string> = {}
  if (step.ply !== false) headers.authorization = `Bearer ${token}`
  if (step.git !== false) headers['git-token'] = gitToken
  if (pin && version) headers['Cloudflare-Workers-Version-Overrides'] = `${config.worker}="${version}"`
  const rawBody = step.body?.(saved)
  if (rawBody) headers['content-type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(url, {
      method: step.method,
      headers,
      body: rawBody ? JSON.stringify({ ...rawBody, remote }) : undefined,
      signal: AbortSignal.timeout(SMOKE_HTTP_MS),
    })
  } catch (error) {
    const detail = redact(errorMessage(error), [token, gitToken])
    await activeLog()?.request({
      method: step.method, url, status: 0, version: null, latencyMs: Date.now() - started,
      cfRay: null, requestId: null, artifactsRay: null,
    })
    return {
      started,
      ended: Date.now(),
      served: null,
      row: {
        step: step.name, method: step.method, path: stepPath(step), status: 0, ms: Date.now() - started,
        pass: false, cfRay: '', requestId: '', artifactsRay: '', version: '', build: '', serverTiming: '', detail,
      },
      judgementDetail: detail,
      ok: false,
      save: {},
      request: null,
      refs: null,
      fault: classifyCall({ status: 0, body: detail, timedOut: true, mintedToken: step.git !== false }),
    }
  }
  const bodyText = await response.text()
  const requestId = header(response, 'x-ply-request-id')
  const build = header(response, 'x-ply-build')
  const seen = header(response, 'x-ply-version')
  const ray = header(response, 'x-artifacts-ray')
  const judgement = judgeCall({
    status: response.status,
    bodyText,
    headers: {
      requestId,
      build,
      version: seen,
      ray,
      cacheControl: header(response, 'cache-control'),
      contentType: header(response, 'content-type'),
    },
    ray: step.ray,
    rayIncludes: step.rayIncludes,
    version: pin || version ? version : null,
    expect: step.expect,
    save: step.save,
    secrets: [token, gitToken],
  }, saved)
  let refs: ApiRefs | null = null
  if (step.name === 'refs-final' && judgement.kind === 'ok') {
    try {
      const parsed = JSON.parse(bodyText) as unknown
      const rec = asRecord(parsed)
      const map = asRecord(rec?.refs)
      if (rec && map) {
        const peeled = asRecord(rec.peeled) ?? {}
        refs = {
          head: typeof rec.head === 'string' ? rec.head : null,
          refs: Object.fromEntries(Object.entries(map).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          peeled: Object.fromEntries(Object.entries(peeled).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        }
      }
    } catch {
      refs = null
    }
  }
  const detail = judgement.kind === 'ok' ? 'ok' : judgement.detail
  await activeLog()?.request({
    method: step.method,
    url,
    status: response.status,
    version: seen,
    latencyMs: Date.now() - started,
    cfRay: header(response, 'cf-ray'),
    requestId,
    artifactsRay: ray,
  })
  return {
    started,
    ended: Date.now(),
    served: seen,
    row: {
      step: step.name,
      method: step.method,
      path: stepPath(step),
      status: response.status,
      ms: Date.now() - started,
      pass: judgement.kind === 'ok',
      cfRay: header(response, 'cf-ray') ?? '',
      requestId: requestId ?? '',
      artifactsRay: ray ?? '',
      version: seen ?? '',
      build: build ?? '',
      serverTiming: header(response, 'server-timing') ?? '',
      detail,
    },
    judgementDetail: detail,
    ok: judgement.kind === 'ok',
    save: judgement.kind === 'ok' ? judgement.save : {},
    request: requestId ? { id: requestId, version: seen, step: step.name, status: response.status, expected: expectedStatuses(step), ray: header(response, 'cf-ray') } : null,
    refs,
    fault: judgement.kind === 'ok' ? null : classifyCall({
      status: response.status,
      body: bodyText,
      timedOut: response.status === 0,
      mintedToken: step.git !== false,
    }),
  }
}

async function judgeMirror(remote: string, gitToken: string, api: ApiRefs): Promise<string | null> {
  const dest = await mkdtemp(join(tmpdir(), 'ply-cd-'))
  const secrets = [gitToken]
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${gitToken}`,
  }
  try {
    const cloned = await run('git', ['clone', '--mirror', remote, dest], { env, secrets })
    if (cloned.code !== 0) return `git clone failed: ${cloned.stderr.slice(0, 300)}`
    const fsck = await run('git', ['fsck', '--strict', '--full'], { cwd: dest, env, secrets })
    const fsckJudgement = judgeFsck(fsck.code, fsck.stdout, fsck.stderr)
    if (!fsckJudgement.ok) return fsckJudgement.detail
    const shown = await run('git', ['show-ref'], { cwd: dest, env, secrets })
    if (shown.code !== 0) return `git show-ref failed: ${shown.stderr.slice(0, 300)}`
    const showRef = parseShowRef(shown.stdout)
    const head = await run('git', ['symbolic-ref', 'HEAD'], { cwd: dest, env, secrets })
    if (head.code !== 0) return `git symbolic-ref failed: ${head.stderr.slice(0, 300)}`
    const peeled = new Map<string, string>()
    for (const name of showRef.keys()) {
      const parsed = await run('git', ['rev-parse', `${name}^{}`], { cwd: dest, env, secrets })
      if (parsed.code !== 0) return `git rev-parse ${name} failed: ${parsed.stderr.slice(0, 200)}`
      peeled.set(name, parsed.stdout.trim())
    }
    const refs = judgeRefs(api, showRef, peeled, head.stdout.trim())
    return refs.ok ? null : refs.detail
  } finally {
    await rm(dest, { recursive: true, force: true })
  }
}

type HarnessFaultKind = 'harness_fault' | 'harness_unhealthy'

type AttemptResult = {
  readonly name: string
  readonly deleted: boolean
  readonly refs: ApiRefs | null
  readonly detail: string
  readonly passed: boolean
  readonly harness: boolean
  readonly fault: HarnessFaultKind | null
  /** Set when a write met a harness event: discard this scratch repo and run the lifecycle again on a new one. */
  readonly restart: string | null
}

/** A harness event's row: kept in the CSV for the record, never counted as a pass or a failure. */
function eventRow(row: CsvRow, event: HarnessEvent, next: string): CsvRow {
  return { ...row, pass: false, detail: `${event.detail}; ${next}` }
}

async function noteEvent(step: HttpStep, event: HarnessEvent, call: CallResult, next: string): Promise<void> {
  const log = activeLog()
  if (!log) return
  await log.observation({
    measurement: {
      source: 'smoke-harness-event',
      step: step.name,
      method: step.method,
      kind: event.kind,
      served: event.kind === 'wrong_version' ? event.served : null,
      stalledMs: event.kind === 'client_stall' ? event.stalledMs : null,
      status: call.row.status,
      cfRay: call.row.cfRay,
      next,
    },
    query: { source: 'smoke' },
    from: call.started,
    to: call.ended,
    raw: JSON.stringify({ step: step.name, detail: event.detail, next }),
  })
}

function exhausted(event: HarnessEvent, step: HttpStep, tries: number): { readonly detail: string; readonly fault: HarnessFaultKind } {
  if (event.kind === 'client_stall') {
    return { detail: `harness unhealthy, prod untouched: ${step.name}: ${event.detail} on ${tries} tries`, fault: 'harness_unhealthy' }
  }
  return { detail: `${step.name}: ${event.detail} on ${tries} tries`, fault: 'harness_fault' }
}

async function smokeAttempt(
  config: CdConfig,
  opts: { readonly version: string | null; readonly pin: boolean; readonly token: string },
  secrets: string[],
  rows: CsvRow[],
  harnessRows: Set<CsvRow>,
  requests: SmokeRequest[],
): Promise<AttemptResult> {
  const name = `${REPO_PREFIX}${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`
  let gitToken = ''
  let remote = ''
  const minted: string[] = []
  let mintedToken: { readonly id: string; readonly secret: Secret } | null = null
  let deleted = false
  let saved: Saved = {}
  let detail = 'ok'
  let refs: ApiRefs | null = null
  let passed = false
  let harness = false
  let fault: HarnessFaultKind | null = null
  let restart: string | null = null
  try {
    const created = await cfJson([
      'artifacts', 'namespaces', 'repos', 'create', config.namespace,
      '--name', name, '--default-branch', 'main', '--description', 'ply-web operator smoke (deleted after a pass)',
    ], secrets)
    const found = remember(created, secrets)
    const auto = createdTokenSecret(created, found)
    remote = findRemote(created) || ''
    if (!REMOTE.test(remote)) throw new Error('cf did not return an Artifacts remote')
    const opening = await listTokenIds(config, name, secrets)
    let revoked = opening.length > 0
    for (const id of opening) {
      if (!(await revoke(config, id, secrets))) revoked = false
    }
    let confirmed = false
    if (auto && revoked) confirmed = await proveRevoked(remote, auto)
    const openingResult = openingRevokeResult({
      hadToken: auto !== null,
      listed: opening.length,
      revoked,
      confirmed,
    })
    if (!openingResult.ok) {
      detail = `${openingResult.reason} for ${name}`
      harness = true
    } else {
      const mintedJson = await cfJson([
        'artifacts', 'namespaces', 'tokens', 'create', config.namespace,
        '--repo', name, '--scope', 'write', '--ttl', String(TOKEN_TTL_SECONDS),
      ], secrets)
      const mintedSecrets = remember(mintedJson, secrets)
      const rec = asRecord(mintedJson)
      const plain = rec !== null && typeof rec.plaintext === 'string' ? rec.plaintext : ''
      const writeToken = mintedSecrets.find(secret => secret.reveal() === plain)
      if (!writeToken) throw new Error('cf returned no write token')
      gitToken = writeToken.reveal()
      if (rec !== null && typeof rec.id === 'string') {
        minted.push(rec.id)
        mintedToken = { id: rec.id, secret: writeToken }
      }
      steps: for (const step of lifecycle()) {
        let result = await oneCall(config, step, saved, remote, opts.token, gitToken, opts.version, opts.pin)
        let tries = 1
        for (;;) {
          const event = harnessEvent({ started: result.started, ended: result.ended, served: result.served, status: result.row.status }, opts.version, clientHealth())
          if (event === null) break
          if (!reissuable(step)) {
            const next = 'restart the lifecycle on a new scratch repo'
            const row = eventRow(result.row, event, next)
            rows.push(row)
            harnessRows.add(row)
            await noteEvent(step, event, result, next)
            restart = `${step.name}: ${event.detail}`
            if (event.kind === 'client_stall') fault = 'harness_unhealthy'
            break steps
          }
          if (tries > SMOKE_REISSUE_ATTEMPTS) {
            const next = 'no re-issue left'
            const row = eventRow(result.row, event, next)
            rows.push(row)
            harnessRows.add(row)
            await noteEvent(step, event, result, next)
            const out = exhausted(event, step, tries)
            detail = out.detail
            fault = out.fault
            harness = true
            break steps
          }
          const next = `re-issued (${tries}/${SMOKE_REISSUE_ATTEMPTS})`
          const row = eventRow(result.row, event, next)
          rows.push(row)
          harnessRows.add(row)
          await noteEvent(step, event, result, next)
          await wait(SMOKE_REISSUE_WAIT_MS)
          tries += 1
          result = await oneCall(config, step, saved, remote, opts.token, gitToken, opts.version, opts.pin)
        }
        rows.push(result.row)
        if (result.request) requests.push(result.request)
        if (!result.ok) {
          detail = `${step.name}: ${result.judgementDetail}`
          harness = result.fault === 'harness_fault'
          break
        }
        saved = { ...saved, ...result.save }
        if (result.refs) refs = result.refs
      }
      if (detail === 'ok' && restart === null) {
        if (!refs) detail = 'refs-final did not return a ref map'
        else {
          const gitDetail = await judgeMirror(remote, gitToken, refs)
          if (gitDetail) detail = gitDetail
        }
      }
      passed = detail === 'ok' && restart === null
    }
  } catch (error) {
    detail = redact(errorMessage(error), secrets)
    harness = true
  } finally {
    const pending = [...new Set([...minted, ...await listTokenIds(config, name, secrets)])]
    const stuck = []
    for (const id of pending) {
      if (!(await revoke(config, id, secrets))) {
        stuck.push(id)
        continue
      }
      if (mintedToken && mintedToken.id === id && REMOTE.test(remote) && !(await proveRevoked(remote, mintedToken.secret))) {
        stuck.push(id)
      }
    }
    if ((passed || restart !== null) && stuck.length > 0) {
      detail = `smoke ${passed ? 'passed' : 'restart'} but a token for ${name} was not revoked`
      passed = false
      restart = null
      harness = true
      fault = 'harness_fault'
    }
  }
  return { name, deleted, refs, detail, passed, harness, fault, restart }
}

/** The route the smoke needs, confirmed again before a restart: the override for a pinned smoke, the split otherwise. */
async function reconfirmRoute(config: CdConfig, version: string | null, pin: boolean): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string; readonly fault: 'harness_fault' | 'worker' }> {
  if (version === null) return { ok: true }
  const since = Date.now()
  const verdict = await confirmRoute({
    url: `${config.baseUrl}/`,
    version,
    headers: pin ? { 'Cloudflare-Workers-Version-Overrides': `${config.worker}="${version}"` } : {},
    since,
  })
  await logRoute({ purpose: pin ? 'pin' : 'live', version, since, started: since }, verdict)
  if (verdict.kind === 'confirmed') return { ok: true }
  return { ok: false, reason: verdict.reason, fault: verdict.kind === 'worker' ? 'worker' : 'harness_fault' }
}

export async function stageSmoke(
  config: CdConfig,
  opts: { readonly version: string | null; readonly pin: boolean; readonly token: string; readonly runDir: string },
): Promise<StageResult<SmokeReport>> {
  const secrets = [opts.token]
  const smokeStarted = Date.now()
  activeLog()?.conceal(opts.token)
  const leaks: string[] = []
  const swept = await sweep(config, secrets)
  if (swept) {
    for (const repoName of swept.leaks) leaks.push(repoName)
  }
  const rows: CsvRow[] = []
  const harnessRows = new Set<CsvRow>()
  const requests: SmokeRequest[] = []
  const discarded: string[] = []
  let attempt: AttemptResult
  let restarts = 0
  let routeFault: { readonly reason: string; readonly fault: 'harness_fault' | 'worker' } | null = null
  for (;;) {
    attempt = await smokeAttempt(config, opts, secrets, rows, harnessRows, requests)
    if (attempt.restart === null) break
    // The discarded attempt's repo saw a write that is not evidence; delete it like a passed one.
    const bound = cleanupBound(config)
    const removed = await confirmDelete(attempt.name, bound, { once: () => deleteOnce(attempt.name, config, secrets), sleep: wait })
    await noteCleanup(removed, bound)
    if (removed.kind === 'leak') leaks.push(removed.repo)
    discarded.push(attempt.name)
    if (restarts >= SMOKE_RESTARTS) break
    restarts += 1
    const route = await reconfirmRoute(config, opts.version, opts.pin)
    if (!route.ok) {
      routeFault = { reason: route.reason, fault: route.fault }
      break
    }
  }
  let detail = attempt.detail
  let passed = attempt.passed
  let harness = attempt.harness
  let fault: HarnessFaultKind | null = attempt.fault
  const name = attempt.name
  let deleted = attempt.deleted
  if (attempt.restart !== null) {
    passed = false
    harness = true
    if (routeFault !== null) {
      detail = `${attempt.restart}; ${routeFault.reason}`
      fault = routeFault.fault === 'worker' ? null : 'harness_fault'
      harness = routeFault.fault !== 'worker'
    } else {
      detail = fault === 'harness_unhealthy'
        ? `harness unhealthy, prod untouched: ${attempt.restart}; ${restarts} restarts exhausted`
        : `${attempt.restart}; ${restarts} restarts exhausted`
      if (fault === null) fault = 'harness_fault'
    }
    deleted = true
  }
  try {
    await writeText(opts.runDir, opts.pin ? 'smoke.csv' : 'live-smoke.csv', csvDocument(rows), secrets)
    if (passed) {
      const bound = cleanupBound(config)
      const removed = await confirmDelete(name, bound, {
        once: () => deleteOnce(name, config, secrets),
        sleep: wait,
      })
      await noteCleanup(removed, bound)
      switch (removed.kind) {
        case 'deleted':
          deleted = true
          break
        case 'leak':
          deleted = false
          leaks.push(removed.repo)
          break
        default:
          assertNever(removed)
      }
    }
    if (passed && leaks.length > 0) detail = `ok; cleanup_leak ${leaks.join(' ')}`
    await appendCleanupFile(opts.runDir, leaks)
  } catch (error) {
    detail = redact(errorMessage(error), secrets)
    passed = false
    harness = true
  }
  const counted = rows.filter(row => !harnessRows.has(row))
  const httpPass = counted.filter(row => row.pass).length
  const httpFail = counted.length - httpPass
  const passedCount = httpPass + (passed ? 1 : 0)
  const failedCount = httpFail + (!passed && httpFail === 0 ? 1 : 0)
  const harnessEvents = harnessRows.size
  const report: SmokeReport = { version: opts.version, repo: name, deleted, cleanup_leak: leaks, requests, refs: attempt.refs, detail, passed: passedCount, failed: failedCount, harnessEvents, restarts, discarded }
  await writeJson(opts.runDir, opts.pin ? 'smoke.json' : 'live-smoke.json', report, secrets)
  const runLog = activeLog()
  const outcomeFault = harness ? (fault === null ? 'harness_fault' : fault) : null
  if (runLog) {
    runLog.addSmoke(passedCount, failedCount)
    const ref = await runLog.observation({
      measurement: { source: 'lifecycle-smoke', passed: passedCount, failed: failedCount, harnessEvents, restarts, detail },
      query: { source: 'lifecycle' },
      from: smokeStarted,
      to: Date.now(),
      raw: JSON.stringify({ detail, requests: requests.length, repo: name, deleted, cleanup_leak: leaks, harnessEvents, restarts, discarded }),
    })
    const informationalSmoke = !passed && !harness && config.policy.gates.smoke === 'informational'
    await runLog.decision({
      inputs: [ref],
      rules: [{ name: 'correctness.target', value: CORRECTNESS.target }],
      outcome: passed || informationalSmoke ? 'advance' : outcomeFault !== null ? outcomeFault : 'stop',
      reason: informationalSmoke ? `informational: ${detail}` : detail,
    })
  }
  const smokeHard = config.policy.gates.smoke === 'hard'
  if (!passed && (harness || smokeHard)) return fail('smoke', `${detail}; repo ${deleted ? 'deleted' : name}`, false, outcomeFault !== null ? outcomeFault : 'worker')
  return pass('smoke', report)
}
