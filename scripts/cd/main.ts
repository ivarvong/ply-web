import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from './cf.ts'
import { loadConfig, publicConfig, type CdConfig } from './config.ts'
import { writeDebrief } from './debrief.ts'
import { VERSION_ID } from './deploy-plan.ts'
import { RunLog, withRun } from './log.ts'
import { runPipeline } from './pipeline.ts'
import { checkNode } from './preflight.ts'
import { errorMessage, run } from './proc.ts'
import { unfinishedRunDir } from './reconcile.ts'
import { reportLedger } from './report.ts'
import { createRunDir, writeJson } from './run-dir.ts'
import { stageBump } from './stage-bump.ts'
import { stageDeploy } from './stage-deploy.ts'
import { stageRamp } from './stage-ramp.ts'
import { stageRollback } from './stage-rollback.ts'
import { stageSmoke } from './stage-smoke.ts'
import { stageTelemetry } from './stage-telemetry.ts'
import { withCommandSink } from './trace.ts'
import { readTokenFile } from './token.ts'
import { parseSince } from './config.ts'

export type Parsed =
  | { readonly kind: 'cd'; readonly sha: string | null; readonly noBump: boolean }
  | { readonly kind: 'bump'; readonly sha: string | null }
  | { readonly kind: 'deploy-canary' }
  | { readonly kind: 'smoke'; readonly version: string | null; readonly expectVersion: string | null }
  | { readonly kind: 'telemetry'; readonly version: string; readonly since: string; readonly report: string | null }
  | { readonly kind: 'ramp'; readonly version: string; readonly previous: string | null; readonly verdict: string | null }
  | { readonly kind: 'rollback'; readonly to: string }
  | { readonly kind: 'report' }
  | { readonly kind: 'debrief'; readonly runDir: string }
  | { readonly kind: 'usage' }
  | { readonly kind: 'error'; readonly reason: string }

function flag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return null
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) return null
  return value
}

function uuid(value: string | null): string | null {
  if (value === null) return null
  if (!VERSION_ID.test(value)) return null
  return value
}

function parseCd(argv: readonly string[]): Parsed {
  let sha: string | null = null
  let noBump = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--no-bump') {
      noBump = true
      continue
    }
    if (arg === '--sha') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--') || !/^[0-9a-f]{40}$/.test(value)) {
        return { kind: 'error', reason: '--sha must be 40 hex characters' }
      }
      sha = value
      i += 1
      continue
    }
    return { kind: 'error', reason: arg.startsWith('--') ? `unknown option ${arg}` : `unknown command ${arg}` }
  }
  if (noBump && sha) return { kind: 'error', reason: '--no-bump deploys the checkout; it does not take --sha' }
  return { kind: 'cd', sha, noBump }
}

export function parseArgs(argv: readonly string[]): Parsed {
  const [command, ...rest] = argv
  if (command === 'help' || command === '--help' || command === '-h') return { kind: 'usage' }
  if (!command || command === 'cd' || command.startsWith('--')) {
    return parseCd(command === 'cd' ? rest : argv)
  }
  if (command === 'bump') {
    const sha = flag(rest, 'sha')
    if (sha !== null && !/^[0-9a-f]{40}$/.test(sha)) return { kind: 'error', reason: '--sha must be 40 hex characters' }
    return { kind: 'bump', sha }
  }
  if (command === 'deploy-canary') return { kind: 'deploy-canary' }
  if (command === 'smoke') {
    const version = flag(rest, 'version')
    const expectVersion = flag(rest, 'expect-version')
    if (Boolean(version) === Boolean(expectVersion)) return { kind: 'error', reason: 'smoke needs --version or --expect-version' }
    const id = uuid(version ?? expectVersion)
    if (!id) return { kind: 'error', reason: 'version id must be a uuid' }
    return { kind: 'smoke', version: version ? id : null, expectVersion: expectVersion ? id : null }
  }
  if (command === 'telemetry') {
    const version = uuid(flag(rest, 'version'))
    const since = flag(rest, 'since')
    if (!version || !since) return { kind: 'error', reason: 'telemetry needs --version and --since' }
    return { kind: 'telemetry', version, since, report: flag(rest, 'report') }
  }
  if (command === 'ramp') {
    const version = uuid(flag(rest, 'version'))
    if (!version) return { kind: 'error', reason: 'ramp needs --version' }
    const previous = flag(rest, 'previous')
    if (previous !== null && !VERSION_ID.test(previous)) return { kind: 'error', reason: '--previous must be a uuid' }
    return { kind: 'ramp', version, previous, verdict: flag(rest, 'verdict') }
  }
  if (command === 'rollback') {
    const to = uuid(flag(rest, 'to'))
    if (!to) return { kind: 'error', reason: 'rollback needs --to <version id>' }
    return { kind: 'rollback', to }
  }
  if (command === 'report') return { kind: 'report' }
  if (command === 'debrief') {
    const runDir = rest[0]
    if (!runDir || runDir.startsWith('--')) return { kind: 'error', reason: 'debrief needs a run directory' }
    return { kind: 'debrief', runDir }
  }
  return { kind: 'error', reason: `unknown command ${command}` }
}

export function usageText(): string {
  return [
    'usage: npm run cd -- [command]',
    '  cd [--sha <40 hex>] [--no-bump]',
    '  [--sha <40 hex>] [--no-bump]',
    '  bump [--sha <40 hex>]',
    '  deploy-canary',
    '  smoke --version <id> | --expect-version <id>',
    '  telemetry --version <id> --since <iso|epoch> --report smoke.json',
    '  ramp --version <id> [--previous <id>] [--verdict telemetry.json]',
    '  rollback --to <id>',
    '  report',
    '  debrief <run-dir>',
  ].join('\n')
}

function finish(log: (line: string) => void, code: number, line: string): number {
  log(line)
  return code
}

async function toolLine(cmd: string, args: readonly string[]): Promise<string> {
  const result = await run(cmd, args, { cwd: ROOT })
  const line = (result.stdout || result.stderr).trim().split('\n')[0] ?? ''
  return result.code === 0 && line ? line : `${cmd} unavailable`
}

async function identity(config: CdConfig) {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: { ply?: string } }
  const spec = pkg.dependencies?.ply ?? ''
  const pin = /#([0-9a-f]{40})$/.exec(spec)
  const plyWeb = await toolLine('git', ['rev-parse', 'HEAD'])
  return {
    config: publicConfig(config),
    tools: {
      node: process.version,
      cf: await toolLine(join(ROOT, 'node_modules', '.bin', 'cf'), ['--version']),
      git: await toolLine('git', ['--version']),
    },
    plySha: pin?.[1] ?? null,
    plyWebSha: plyWeb === 'git unavailable' ? 'unknown' : plyWeb,
    host: hostname(),
  }
}

export async function cli(argv: readonly string[], env: NodeJS.ProcessEnv, log: (line: string) => void = console.log): Promise<number> {
  const nodeError = checkNode(process.version)
  if (nodeError) return finish(log, 1, `cd: harness_fault preflight: ${nodeError}`)
  const parsed = parseArgs(argv)
  if (parsed.kind === 'usage') return finish(log, 2, usageText())
  if (parsed.kind === 'error') return finish(log, 2, parsed.reason)
  let config: CdConfig
  try {
    config = loadConfig(env)
  } catch (error) {
    return finish(log, 2, errorMessage(error))
  }
  if (parsed.kind === 'report') {
    log(await reportLedger(config.ledgerPath))
    return 0
  }
  if (parsed.kind === 'debrief') {
    try {
      const path = await writeDebrief(resolve(parsed.runDir))
      return finish(log, 0, `debrief: ${path}`)
    } catch (error) {
      return finish(log, 1, `cd: FAIL debrief: ${errorMessage(error)}`)
    }
  }
  const needsToken = parsed.kind === 'cd' || parsed.kind === 'smoke' || parsed.kind === 'ramp'
  let token = ''
  if (needsToken) {
    if (!config.tokenFile) return finish(log, 1, 'cd: harness_fault preflight: PLY_TOKEN_FILE is not set')
    try {
      token = await readTokenFile(config.tokenFile)
    } catch (error) {
      return finish(log, 1, `cd: harness_fault preflight: ${errorMessage(error)}`)
    }
  }
  const resumeSha = parsed.kind === 'cd' ? parsed.sha : null
  const existing = resumeSha ? await unfinishedRunDir(config.runRoot, resumeSha) : null
  const runDir = existing ?? await createRunDir(config.runRoot)
  const runLog = existing
    ? await RunLog.reopen(runDir, config.ledgerPath)
    : await RunLog.open(runDir, config.ledgerPath, basename(runDir))
  log(`run: ${runDir}`)
  if (existing) log(`resume: ${runDir}`)
  return withRun(runLog, () => withCommandSink(note => runLog.noteCommand(note), async () => {
    let code = 1
    let reason: string | null = 'run ended before finish'
    try {
      if (token) runLog.conceal(token)
      if (existing && resumeSha) {
        await runLog.resumed(resumeSha)
      } else {
        const started = await identity(config)
        const recorded = resumeSha ? { ...started, config: { ...started.config, sha: resumeSha } } : started
        await runLog.started(recorded)
      }
      const outcome = await dispatch(parsed, config, token, runDir, runLog, log)
      code = outcome.code
      reason = outcome.reason
      return code
    } catch (error) {
      reason = errorMessage(error)
      runLog.patch({ fault: 'harness_fault' })
      await runLog.error(reason, { stage: 'run', fault: 'harness_fault' })
      log(`cd: harness_fault run: ${reason}`)
      return 1
    } finally {
      if (!runLog.finished) await runLog.finish(code, code === 0 ? null : reason)
      if (!runLog.sealed) await runLog.seal()
    }
  }))
}

type Outcome = { readonly code: number; readonly reason: string | null }

async function dispatch(
  parsed: Exclude<Parsed, { kind: 'usage' | 'error' | 'report' | 'debrief' }>,
  config: CdConfig,
  token: string,
  runDir: string,
  runLog: RunLog,
  log: (line: string) => void,
): Promise<Outcome> {
  if (parsed.kind === 'cd') {
    const exit = await runPipeline(config, { token, sha: parsed.sha, noBump: parsed.noBump, log, runDir, runLog })
    return { code: exit.code, reason: exit.reason }
  }
  if (parsed.kind === 'bump') {
    const result = await stageBump(config, parsed.sha)
    await writeJson(runDir, 'bump.json', result)
    if (result.kind === 'fail') {
      runLog.patch({ fault: 'harness_fault' })
      const line = `cd: harness_fault bump: ${result.reason}`
      log(line)
      return { code: 1, reason: line }
    }
    const line = result.value.committed ? `cd: PASS bump ${result.value.sha}` : `cd: PASS bump unchanged ${result.value.sha}`
    log(line)
    return { code: 0, reason: null }
  }
  if (parsed.kind === 'deploy-canary') {
    const result = await stageDeploy(config)
    await writeJson(runDir, 'deploy.json', result)
    if (result.kind === 'fail') {
      runLog.patch({ fault: result.fault })
      const line = `cd: ${result.fault === 'worker' ? 'FAIL' : result.fault} deploy-canary: ${result.reason}`
      log(line)
      return { code: 1, reason: line }
    }
    log(`version: ${result.value.version}`)
    log(`previous: ${result.value.previous}`)
    log(`cd: PASS deploy-canary ${result.value.version}`)
    return { code: 0, reason: null }
  }
  if (parsed.kind === 'smoke') {
    const version = parsed.version ?? parsed.expectVersion
    const result = await stageSmoke(config, { version, pin: parsed.version !== null, token, runDir })
    if (result.kind === 'fail') {
      runLog.patch({ fault: result.fault })
      const line = `cd: ${result.fault === 'worker' ? 'FAIL' : result.fault} smoke: ${result.reason}`
      log(line)
      return { code: 1, reason: line }
    }
    log(`cd: PASS smoke ${version}`)
    return { code: 0, reason: null }
  }
  if (parsed.kind === 'telemetry') {
    let since = 0
    try {
      since = parseSince(parsed.since)
    } catch (error) {
      const line = errorMessage(error)
      log(line)
      return { code: 2, reason: line }
    }
    if (!parsed.report) {
      log('telemetry needs --report')
      return { code: 2, reason: 'telemetry needs --report' }
    }
    const result = await stageTelemetry(config, { version: parsed.version, since, reportPath: parsed.report, runDir, live: false })
    if (result.kind === 'fail') {
      const line = `cd: FAIL telemetry: ${result.reason}`
      log(line)
      return { code: 1, reason: line }
    }
    log(result.value.line)
    log(`cd: PASS telemetry ${parsed.version}`)
    return { code: 0, reason: null }
  }
  if (parsed.kind === 'ramp') {
    const result = await stageRamp(config, {
      version: parsed.version,
      previous: parsed.previous,
      verdictPath: parsed.verdict,
      runDir,
      token,
      log,
    })
    if (result.kind === 'fail') {
      const line = `cd: FAIL ramp: ${result.reason}`
      log(line)
      return { code: 1, reason: line }
    }
    log(`version: ${result.value.version}`)
    log(`previous: ${result.value.previous}`)
    log(`cd: PASS ramp ${result.value.version}`)
    return { code: 0, reason: null }
  }
  const result = await stageRollback(config, parsed.to)
  await writeJson(runDir, 'rollback.json', result)
  if (result.kind === 'fail') {
    const line = `cd: FAIL rollback: ${result.reason}`
    log(line)
    return { code: 1, reason: line }
  }
  log(`cd: PASS rollback ${parsed.to}`)
  return { code: 0, reason: null }
}

const entry = process.argv[1]
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2), process.env).then(code => process.exit(code))
}
