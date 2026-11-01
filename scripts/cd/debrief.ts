import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { atIndex, chainGet, mapGet } from '../../src/absent.ts'
import { unwrapOr } from '../../src/option.ts'
import { chartPng, type ChartSeries, type Rgb } from './charts.ts'
import { readEvents, type CdEvent } from './log.ts'
import { FAST_BURN } from './slo.ts'

type Measurement = { readonly [key: string]: unknown }

function measurement(event: CdEvent): Measurement | null {
  if (event.kind !== 'observation') return null
  const value = event.payload.measurement
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Measurement
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function field(value: unknown, key: string): unknown {
  return unwrapOr(chainGet(value, key), null)
}

function textOrDash(value: string | null): string {
  return value === null ? '-' : value
}

function numCell(value: unknown): number | string {
  const parsed = num(value)
  return parsed === null ? '-' : parsed
}

function firstNum(...values: readonly unknown[]): number | null {
  for (const value of values) {
    const parsed = num(value)
    if (parsed !== null) return parsed
  }
  return null
}

function numOrZero(...values: readonly unknown[]): number {
  const parsed = firstNum(...values)
  return parsed === null ? 0 : parsed
}

function labelOf(labels: readonly string[], index: number): string {
  return unwrapOr(atIndex(labels, index), '')
}

function findShare<T>(items: readonly T[], keep: (item: T) => boolean): T | null {
  for (const item of items) {
    if (keep(item)) return item
  }
  return null
}

const BURN_FALLBACK: Rgb = [15, 23, 42]

function burnAt(step: object, name: string): number {
  if (!('burns' in step)) return 0
  const value = chainGet(burnsOf(step.burns), name)
  if (value.tag === 'none' || typeof value.value !== 'number') return 0
  return value.value
}

function burnsOf(value: unknown): { readonly [slo: string]: number | null } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: { [slo: string]: number | null } = {}
  for (const [key, burn] of Object.entries(value)) {
    out[key] = burn === null ? null : num(burn)
  }
  return out
}

function summarize(event: CdEvent): string {
  if (event.kind === 'lifecycle') {
    if (event.payload.event === 'run_started') return 'run started'
    if (event.payload.event === 'resumed') return `resumed ${event.payload.sha.slice(0, 12)}`
    return `run finished ${event.payload.verdict}`
  }
  if (event.kind === 'command') return `${event.payload.argv.join(' ')} exit ${event.payload.exitCode}`.slice(0, 120)
  if (event.kind === 'observation') {
    const measured = measurement(event)
    const source = measured === null ? null : field(measured, 'source')
    return typeof source === 'string' ? source : 'measurement'
  }
  if (event.kind === 'decision') return `${event.payload.outcome}: ${event.payload.reason}`
  if (event.kind === 'state_change') {
    const after = event.payload.after.map(share => `${share.percentage}% ${share.versionId.slice(0, 8)}`).join(', ')
    return `traffic → ${after || 'empty'}`
  }
  if (event.kind === 'request') return `${event.payload.method} ${event.payload.status} ${textOrDash(event.payload.version)} ${event.payload.latencyMs}ms`
  if (event.kind === 'annotation') return `${event.payload.note}: ${event.payload.reason}`
  if (event.kind === 'policy') return `policy ${event.payload.sha256.slice(0, 12)}`
  return event.payload.message
}

function link(fromDir: string, file: string): string {
  return relative(fromDir, file).split('\\').join('/')
}

/** Informational: smoke ids telemetry never returned, per telemetry stage. Fails the run only when `exceeded`. */
export function telemetryLossSection(events: readonly CdEvent[]): string[] {
  const losses = events.map(measurement).filter((value): value is Measurement => value !== null && field(value, 'source') === 'telemetry-loss')
  if (losses.length === 0) return []
  const lines = ['## Telemetry loss', '', '| stage | missing | total | rate | max | exceeded |', '| --- | --- | --- | --- | --- | --- |']
  for (const loss of losses) {
    const rate = num(loss.rate)
    const max = num(loss.maxLossRate)
    lines.push(`| ${loss.live === true ? 'live' : 'pinned'} | ${numCell(loss.count)} | ${numCell(loss.total)} | ${rate === null ? '-' : `${(rate * 100).toFixed(1)}%`} | ${max === null ? '-' : `${(max * 100).toFixed(1)}%`} | ${loss.exceeded === true ? 'yes' : 'no'} |`)
  }
  lines.push('')
  for (const loss of losses) {
    const ids = Array.isArray(loss.ids) ? loss.ids : []
    for (const item of ids) {
      if (item === null || typeof item !== 'object') continue
      const lost = item as Measurement
      lines.push(`- ${loss.live === true ? 'live' : 'pinned'} ${String(lost.step)} \`${String(lost.id)}\` log ${lost.log === true ? 'missing' : 'ok'}, trace ${lost.trace === true ? 'missing' : 'ok'}`)
    }
  }
  lines.push('')
  return lines
}

/** One point per state_change. The 0% canary is the version that was introduced at 0. */
export function canarySplit(events: readonly CdEvent[]): { readonly percent: number; readonly seen: number }[] {
  const changes = events.filter(event => event.kind === 'state_change')
  let canary: string | null = null
  for (const event of changes) {
    if (event.kind !== 'state_change') continue
    const zero = event.payload.after.find(share => share.percentage === 0)
    if (zero) {
      canary = zero.versionId
      break
    }
  }
  const seenAt = new Map<number, number>()
  for (const step of rampSteps(events)) {
    const percent = num(step.percent)
    const seen = firstNum(step.routedNewShare, step.observedPercent)
    if (percent !== null && seen !== null) seenAt.set(percent, seen)
  }
  return changes.flatMap(event => {
    if (event.kind !== 'state_change') return []
    const matched = canary === null ? null : findShare(event.payload.after, item => item.versionId === canary)
    const other = findShare(event.payload.after, item => item.percentage !== 100)
    const first = unwrapOr(atIndex(event.payload.after, 0), null)
    const share = canary === null ? (other === null ? first : other) : matched
    const percent = share === null ? 0 : share.percentage
    return [{ percent, seen: unwrapOr(mapGet(seenAt, percent), 0) }]
  })
}

function jsonObject(value: unknown): { readonly [key: string]: unknown } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as { readonly [key: string]: unknown }
}

function policyBurn(events: readonly CdEvent[]): number {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!event || event.kind !== 'policy') continue
    const body = jsonObject(event.payload.body)
    const burn = jsonObject(body === null ? null : field(body, 'burn'))
    const fast = burn === null ? null : field(burn, 'fastBurn')
    if (typeof fast === 'number') return fast
  }
  return FAST_BURN
}

function latencyMode(events: readonly CdEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!event || event.kind !== 'policy') continue
    const body = jsonObject(event.payload.body)
    const gates = jsonObject(body === null ? null : field(body, 'gates'))
    const latency = jsonObject(gates === null ? null : field(gates, 'latency'))
    const mode = latency === null ? null : field(latency, 'mode')
    return typeof mode === 'string' ? mode : null
  }
  return null
}

function rampSteps(events: readonly CdEvent[]): Measurement[] {
  return events.flatMap(event => {
    const value = measurement(event)
    return value !== null && field(value, 'source') === 'ramp-step' ? [value] : []
  })
}

/**
 * Markdown plus three PNGs, written beside the run directory so the sealed run stays unchanged.
 * Returns the markdown path.
 */
export async function writeDebrief(runDir: string, outDir = join(dirname(runDir), `${basename(runDir)}.debrief`)): Promise<string> {
  const events = await readEvents(runDir)
  await mkdir(outDir, { recursive: true })
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const started = events.find(event => event.kind === 'lifecycle' && event.payload.event === 'run_started')
  const finished = events.find(event => event.kind === 'lifecycle' && event.payload.event === 'run_finished')
  const firstEvent = unwrapOr(atIndex(events, 0), null)
  const lines: string[] = [`# Debrief ${firstEvent === null ? basename(runDir) : firstEvent.run_id}`, '']
  if (started && started.kind === 'lifecycle' && started.payload.event === 'run_started') {
    const payload = started.payload
    const pair = payload.release ? ` Release \`${payload.release.ply}+${payload.release.web}\`.` : ''
    lines.push(`${payload.host} ran ply \`${textOrDash(payload.plySha)}\` on ply-web \`${payload.plyWebSha}\`.${pair}`)
    lines.push('')
    lines.push(`Tools: node ${payload.tools.node}, ${payload.tools.cf}, ${payload.tools.git}.`)
    lines.push('')
  }
  const policies = events.filter(event => event.kind === 'policy')
  if (policies.length > 0) {
    lines.push('## Policy', '')
    for (const event of policies) {
      if (event.kind !== 'policy') continue
      const pair = event.payload.release
        ? `ply \`${event.payload.release.ply}\` ply-web \`${event.payload.release.web}\``
        : null
      lines.push(`\`${event.payload.sha256}\``, '', event.payload.path, ...(pair ? ['', pair] : []), '', '```json', JSON.stringify(event.payload.body, null, 2), '```', '')
    }
  }
  if (finished && finished.kind === 'lifecycle' && finished.payload.event === 'run_finished') {
    const payload = finished.payload
    lines.push(`Verdict **${payload.verdict}**${payload.reason ? `: ${payload.reason}` : ''}.`)
    lines.push('')
    lines.push(`Version ${textOrDash(payload.versionId)}. Rolled back: ${payload.rolledBack ? 'yes' : 'no'}${payload.rollbackReason ? ` (${payload.rollbackReason})` : ''}.`)
    lines.push('')
    lines.push(`Smoke ${payload.smoke.passed} passed, ${payload.smoke.failed} failed. Live at ${textOrDash(payload.liveAt)}.`)
    lines.push('')
    if (payload.plyMergedAt) lines.push(`ply merged at ${payload.plyMergedAt}.`, '')
  }
  lines.push('## Timeline', '', '| seq | time | stage | kind | what |', '| --- | --- | --- | --- | --- |')
  for (const event of events) {
    lines.push(`| ${event.seq} | ${event.ts} | ${event.stage} | ${event.kind} | ${summarize(event).replace(/\|/g, '/')} |`)
  }
  lines.push('', '## Decisions', '')
  const decisions = events.filter(event => event.kind === 'decision')
  if (decisions.length === 0) lines.push('No decisions were recorded.', '')
  for (const event of decisions) {
    if (event.kind !== 'decision') continue
    lines.push(`### ${event.seq}. ${event.payload.outcome}`, '', event.payload.reason, '')
    lines.push('Rules:')
    for (const rule of event.payload.rules) lines.push(`- \`${rule.name}\` = ${rule.value}`)
    lines.push('', 'Inputs:')
    for (const input of event.payload.inputs) {
      const source = bySeq.get(input)
      const path = source && source.kind === 'observation' ? source.payload.responsePath : ''
      lines.push(`- event ${input}${path ? ` ([${path}](${link(outDir, join(runDir, path))}))` : ''}: ${source ? summarize(source) : 'missing'}`)
    }
    lines.push('')
  }
  lines.push(...telemetryLossSection(events))
  lines.push('## Traffic', '', '| seq | before | after | deployment |', '| --- | --- | --- | --- |')
  const changes = events.filter(event => event.kind === 'state_change')
  if (changes.length === 0) lines.push('| - | - | - | - |')
  for (const event of changes) {
    if (event.kind !== 'state_change') continue
    const show = (shares: readonly { versionId: string; percentage: number }[]) => shares.map(share => `${share.percentage}% ${share.versionId}`).join(', ') || '-'
    lines.push(`| ${event.seq} | ${show(event.payload.before)} | ${show(event.payload.after)} | ${textOrDash(event.payload.deploymentId)} |`)
  }
  const steps = rampSteps(events)
  const labels = steps.map((step, index) => {
    const percent = num(step.percent)
    return String(percent === null ? index + 1 : percent)
  })
  const splitPoints = canarySplit(events)
  const split: ChartSeries[] = splitPoints.length > 0
    ? [
      { name: 'cfg', rgb: [194, 65, 12], points: splitPoints.map(point => ({ x: String(point.percent), y: point.percent })) },
      { name: 'seen', rgb: [15, 118, 110], points: splitPoints.map(point => ({ x: String(point.percent), y: point.seen })) },
    ]
    : [
      { name: 'cfg', rgb: [194, 65, 12], points: steps.map((step, index) => ({ x: labelOf(labels, index), y: numOrZero(step.percent) })) },
      { name: 'seen', rgb: [15, 118, 110], points: steps.map((step, index) => ({ x: labelOf(labels, index), y: numOrZero(step.routedNewShare, step.observedPercent) })) },
    ]
  const latency: ChartSeries[] = [
    { name: 'new', rgb: [194, 65, 12], points: steps.map((step, index) => ({ x: labelOf(labels, index), y: numOrZero(step.nextWallP99) })) },
    { name: 'old', rgb: [29, 78, 216], points: steps.map((step, index) => ({ x: labelOf(labels, index), y: numOrZero(step.previousWallP99) })) },
  ]
  const finishedSteps = finished && finished.kind === 'lifecycle' && finished.payload.event === 'run_finished' ? finished.payload.steps : []
  const burnSource = finishedSteps.length ? finishedSteps : steps
  const burnLabels = burnSource.map((step, index) => {
    const percent = num(step.percent)
    return String(percent === null ? index + 1 : percent)
  })
  const burnNames = ['availability', 'read_latency', 'write_latency', 'correctness'] as const
  const burnColors = [[185, 28, 28], [194, 65, 12], [180, 83, 9], [21, 128, 61]] as const
  const burn: ChartSeries[] = burnNames.map((name, index) => ({
    name: name === 'read_latency' ? 'read' : name === 'write_latency' ? 'write' : name === 'availability' ? 'avail' : 'correct',
    rgb: unwrapOr(atIndex(burnColors, index), BURN_FALLBACK),
    points: burnSource.map((step, stepIndex) => ({
      x: labelOf(burnLabels, stepIndex),
      y: burnAt(step, name),
    })),
  }))
  const fastBurn = policyBurn(events)
  const mode = latencyMode(events)
  await writeFile(join(outDir, 'split.png'), chartPng({ title: 'split percent', series: split }))
  await writeFile(join(outDir, 'latency.png'), chartPng({ title: 'wall p99 ms', series: latency }))
  await writeFile(join(outDir, 'burn.png'), chartPng({ title: 'burn rate', series: burn, hLine: { y: fastBurn, rgb: [185, 28, 28] } }))
  lines.push('', '## Charts', '')
  lines.push('Every state_change, including the 0% canary, against `routedNewShare`: the percent of telemetry invocations the new version served. The band around that share is `toleranceLow`..`toleranceHigh` on the ramp observation. An older run stored `observedPercent` from pinned probes; that field is the fallback. Seen is 0 when that change was not a ramp step.', '')
  lines.push('![Configured and routed split](split.png)', '')
  const latencyCaption = mode
    ? `Wall-time p99 and CPU p99 are recorded on each ramp observation. Latency mode for this run is ${mode}.`
    : 'Wall-time p99, new version and old version. Informational unless a policy event sets latency to gate.'
  lines.push(`${latencyCaption} A carried old sample is the last step that still had one.`, '')
  lines.push('![Latency by version](latency.png)', '')
  lines.push(`Burn rate per SLO. The horizontal line is the fast-burn multiple ${fastBurn}. A null burn (no samples, or correctness on a ramp step) is drawn as 0.`, '')
  lines.push('![Burn rate per step](burn.png)', '')
  lines.push('## Raw files', '')
  lines.push(`- [events.jsonl](${link(outDir, join(runDir, 'events.jsonl'))})`)
  lines.push(`- [manifest.json](${link(outDir, join(runDir, 'manifest.json'))})`)
  for (const event of events) {
    if (event.kind === 'observation') lines.push(`- [${event.payload.responsePath}](${link(outDir, join(runDir, event.payload.responsePath))})`)
    if (event.kind === 'command') {
      lines.push(`- [${event.payload.stdoutPath}](${link(outDir, join(runDir, event.payload.stdoutPath))})`)
      lines.push(`- [${event.payload.stderrPath}](${link(outDir, join(runDir, event.payload.stderrPath))})`)
    }
  }
  lines.push('')
  const markdownPath = join(outDir, 'debrief.md')
  await writeFile(markdownPath, lines.join('\n'))
  return markdownPath
}
