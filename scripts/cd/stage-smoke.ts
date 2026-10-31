import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_PREFIX, SMOKE_HTTP_MS, STALE_REPO_MS, TOKEN_TTL_SECONDS } from './baseline.ts'
import { cfOk, runCf } from './cf.ts'
import { csvDocument, type CsvRow } from './csv.ts'
import { asRecord, extractJson } from './json.ts'
import { judgeCall, type Saved } from './judge.ts'
import { expectedStatus, lifecycle, type HttpStep } from './lifecycle.ts'
import { activeLog } from './log.ts'
import { errorMessage, run } from './proc.ts'
import { harvestSecrets, redact } from './redact.ts'
import { judgeFsck, judgeRefs, parseShowRef, type ApiRefs } from './refs.ts'
import { fail, pass, type StageResult } from './result.ts'
import { writeJson, writeText } from './run-dir.ts'
import { CORRECTNESS } from './slo.ts'
import type { SmokeRequest } from './telemetry.ts'
import type { CdConfig } from './config.ts'

export type SmokeReport = {
  readonly version: string | null
  readonly repo: string
  readonly deleted: boolean
  readonly requests: readonly SmokeRequest[]
  readonly refs: ApiRefs | null
  readonly detail: string
  readonly passed: number
  readonly failed: number
}

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

async function cfJson(args: readonly string[], secrets: readonly string[]): Promise<unknown> {
  const stdout = await cfOk(args, secrets)
  return extractJson(stdout)
}

async function revoke(config: CdConfig, id: string, secrets: readonly string[]): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await runCf(['artifacts', 'namespaces', 'tokens', 'revoke', id, '--namespace', config.namespace, '--force'], secrets)
    if (result.code === 0) return true
    await new Promise(resolve => setTimeout(resolve, 1_000))
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

async function sweep(config: CdConfig, secrets: readonly string[]): Promise<void> {
  const listed = await runCf(['artifacts', 'namespaces', 'repos', 'list', '--namespace', config.namespace, '--search', REPO_PREFIX], secrets)
  if (listed.code !== 0) return
  let repos: unknown[] = []
  try {
    const parsed = extractJson(listed.stdout)
    repos = Array.isArray(parsed) ? parsed : []
  } catch {
    return
  }
  for (const repo of repos) {
    const rec = asRecord(repo)
    const name = typeof rec?.name === 'string' ? rec.name : ''
    const created = Date.parse(typeof rec?.created_at === 'string' ? rec.created_at : '')
    if (!name.startsWith(REPO_PREFIX) || !Number.isFinite(created) || Date.now() - created <= STALE_REPO_MS) continue
    await runCf(['artifacts', 'namespaces', 'repos', 'delete', name, '--namespace', config.namespace, '--force'], secrets)
  }
}

function stepPath(step: HttpStep): string {
  const params = new URLSearchParams(step.query ?? {})
  const query = params.toString()
  return query ? `${step.path}?${query}` : step.path
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
): Promise<{ row: CsvRow; judgementDetail: string; ok: boolean; save: Saved; request: SmokeRequest | null; refs: ApiRefs | null }> {
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
      row: {
        step: step.name, method: step.method, path: stepPath(step), status: 0, ms: Date.now() - started,
        pass: false, cfRay: '', requestId: '', artifactsRay: '', version: '', build: '', serverTiming: '', detail,
      },
      judgementDetail: detail,
      ok: false,
      save: {},
      request: null,
      refs: null,
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
    headers: { requestId, build, version: seen, ray },
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
    request: requestId ? { id: requestId, version: seen, step: step.name, status: response.status, expected: [expectedStatus(step)] } : null,
    refs,
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

export async function stageSmoke(
  config: CdConfig,
  opts: { readonly version: string | null; readonly pin: boolean; readonly token: string; readonly runDir: string },
): Promise<StageResult<SmokeReport>> {
  const secrets = [opts.token]
  const smokeStarted = Date.now()
  activeLog()?.conceal(opts.token)
  await sweep(config, secrets)
  const name = `${REPO_PREFIX}${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`
  let gitToken = ''
  let remote = ''
  const minted: string[] = []
  let deleted = false
  const rows: CsvRow[] = []
  const requests: SmokeRequest[] = []
  let saved: Saved = {}
  let detail = 'ok'
  let refs: ApiRefs | null = null
  let passed = false
  try {
    const created = await cfJson([
      'artifacts', 'namespaces', 'repos', 'create', config.namespace,
      '--name', name, '--default-branch', 'main', '--description', 'ply-web operator smoke (deleted after a pass)',
    ], secrets)
    harvestSecrets(created, secrets)
    remote = findRemote(created) ?? ''
    if (!REMOTE.test(remote)) throw new Error('cf did not return an Artifacts remote')
    for (const id of await listTokenIds(config, name, secrets)) {
      await revoke(config, id, secrets)
    }
    const mintedJson = await cfJson([
      'artifacts', 'namespaces', 'tokens', 'create', config.namespace,
      '--repo', name, '--scope', 'write', '--ttl', String(TOKEN_TTL_SECONDS),
    ], secrets)
    harvestSecrets(mintedJson, secrets)
    const rec = asRecord(mintedJson)
    gitToken = typeof rec?.plaintext === 'string' ? rec.plaintext : secrets.find(secret => secret.startsWith('art_v1_')) ?? ''
    if (typeof rec?.id === 'string') minted.push(rec.id)
    if (!gitToken.startsWith('art_v1_')) throw new Error('cf returned no write token')
    secrets.push(gitToken)
    activeLog()?.conceal(gitToken)
    for (const step of lifecycle()) {
      const result = await oneCall(config, step, saved, remote, opts.token, gitToken, opts.version, opts.pin)
      rows.push(result.row)
      if (result.request) requests.push(result.request)
      if (!result.ok) {
        detail = `${step.name}: ${result.judgementDetail}`
        break
      }
      saved = { ...saved, ...result.save }
      if (result.refs) refs = result.refs
    }
    if (detail === 'ok') {
      if (!refs) detail = 'refs-final did not return a ref map'
      else {
        const gitDetail = await judgeMirror(remote, gitToken, refs)
        if (gitDetail) detail = gitDetail
      }
    }
    passed = detail === 'ok'
  } catch (error) {
    detail = redact(errorMessage(error), secrets)
  } finally {
    await writeText(opts.runDir, opts.pin ? 'smoke.csv' : 'live-smoke.csv', csvDocument(rows), secrets)
    const pending = [...new Set([...minted, ...await listTokenIds(config, name, secrets)])]
    const stuck = []
    for (const id of pending) {
      if (!(await revoke(config, id, secrets))) stuck.push(id)
    }
    if (passed && stuck.length > 0) {
      detail = `smoke passed but a token for ${name} was not revoked`
      passed = false
    }
    if (passed) {
      const removed = await runCf(['artifacts', 'namespaces', 'repos', 'delete', name, '--namespace', config.namespace, '--force'], secrets)
      deleted = removed.code === 0
      if (!deleted) {
        detail = `smoke passed but repo ${name} was not deleted`
        passed = false
      }
    }
  }
  const httpPass = rows.filter(row => row.pass).length
  const httpFail = rows.length - httpPass
  const passedCount = httpPass + (passed ? 1 : 0)
  const failedCount = httpFail + (!passed && httpFail === 0 ? 1 : 0)
  const report: SmokeReport = { version: opts.version, repo: name, deleted, requests, refs, detail, passed: passedCount, failed: failedCount }
  await writeJson(opts.runDir, opts.pin ? 'smoke.json' : 'live-smoke.json', report, secrets)
  const runLog = activeLog()
  if (runLog) {
    runLog.addSmoke(passedCount, failedCount)
    const ref = await runLog.observation({
      measurement: { source: 'lifecycle-smoke', passed: passedCount, failed: failedCount, detail },
      query: { source: 'lifecycle' },
      from: smokeStarted,
      to: Date.now(),
      raw: JSON.stringify({ detail, requests: requests.length, repo: name, deleted }),
    })
    await runLog.decision({
      inputs: [ref],
      rules: [{ name: 'correctness.target', value: CORRECTNESS.target }],
      outcome: passed ? 'advance' : 'stop',
      reason: detail,
    })
  }
  if (!passed) return fail('smoke', `${detail}; repo ${deleted ? 'deleted' : name}`)
  return pass('smoke', report)
}
