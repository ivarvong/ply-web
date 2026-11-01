import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { chartPng, type ChartSeries } from './charts.ts'
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
    const source = measurement(event)?.source
    return typeof source === 'string' ? source : 'measurement'
  }
  if (event.kind === 'decision') return `${event.payload.outcome}: ${event.payload.reason}`
  if (event.kind === 'state_change') {
    const after = event.payload.after.map(share => `${share.percentage}% ${share.versionId.slice(0, 8)}`).join(', ')
    return `traffic → ${after || 'empty'}`
  }
  if (event.kind === 'request') return `${event.payload.method} ${event.payload.status} ${event.payload.version ?? '-'} ${event.payload.latencyMs}ms`
  if (event.kind === 'annotation') return `${event.payload.note}: ${event.payload.reason}`
  if (event.kind === 'policy') return `policy ${event.payload.sha256.slice(0, 12)}`
  return event.payload.message
}

function link(fromDir: string, file: string): string {
  return relative(fromDir, file).split('\\').join('/')
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
    const seen = num(step.routedNewShare) ?? num(step.observedPercent)
    if (percent !== null && seen !== null) seenAt.set(percent, seen)
  }
  return changes.flatMap(event => {
    if (event.kind !== 'state_change') return []
    const share = canary
      ? event.payload.after.find(item => item.versionId === canary)
      : event.payload.after.find(item => item.percentage !== 100) ?? event.payload.after[0]
    const percent = share?.percentage ?? 0
    return [{ percent, seen: seenAt.get(percent) ?? 0 }]
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
    const burn = jsonObject(jsonObject(event.payload.body)?.burn)
    const fast = burn?.fastBurn
    if (typeof fast === 'number') return fast
  }
  return FAST_BURN
}

function latencyMode(events: readonly CdEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!event || event.kind !== 'policy') continue
    const latency = jsonObject(jsonObject(jsonObject(event.payload.body)?.gates)?.latency)
    return typeof latency?.mode === 'string' ? latency.mode : null
  }
  return null
}

function rampSteps(events: readonly CdEvent[]): Measurement[] {
  return events.flatMap(event => {
    const value = measurement(event)
    return value?.source === 'ramp-step' ? [value] : []
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
  const lines: string[] = [`# Debrief ${events[0]?.run_id ?? basename(runDir)}`, '']
  if (started && started.kind === 'lifecycle' && started.payload.event === 'run_started') {
    const payload = started.payload
    lines.push(`${payload.host} ran ply \`${payload.plySha ?? '-'}\` on ply-web \`${payload.plyWebSha}\`.`)
    lines.push('')
    lines.push(`Tools: node ${payload.tools.node}, ${payload.tools.cf}, ${payload.tools.git}.`)
    lines.push('')
  }
  const policies = events.filter(event => event.kind === 'policy')
  if (policies.length > 0) {
    lines.push('## Policy', '')
    for (const event of policies) {
      if (event.kind !== 'policy') continue
      lines.push(`\`${event.payload.sha256}\``, '', event.payload.path, '', '```json', JSON.stringify(event.payload.body, null, 2), '```', '')
    }
  }
  if (finished && finished.kind === 'lifecycle' && finished.payload.event === 'run_finished') {
    const payload = finished.payload
    lines.push(`Verdict **${payload.verdict}**${payload.reason ? `: ${payload.reason}` : ''}.`)
    lines.push('')
    lines.push(`Version ${payload.versionId ?? '-'}. Rolled back: ${payload.rolledBack ? 'yes' : 'no'}${payload.rollbackReason ? ` (${payload.rollbackReason})` : ''}.`)
    lines.push('')
    lines.push(`Smoke ${payload.smoke.passed} passed, ${payload.smoke.failed} failed. Live at ${payload.liveAt ?? '-'}.`)
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
  lines.push('## Traffic', '', '| seq | before | after | deployment |', '| --- | --- | --- | --- |')
  const changes = events.filter(event => event.kind === 'state_change')
  if (changes.length === 0) lines.push('| - | - | - | - |')
  for (const event of changes) {
    if (event.kind !== 'state_change') continue
    const show = (shares: readonly { versionId: string; percentage: number }[]) => shares.map(share => `${share.percentage}% ${share.versionId}`).join(', ') || '-'
    lines.push(`| ${event.seq} | ${show(event.payload.before)} | ${show(event.payload.after)} | ${event.payload.deploymentId ?? '-'} |`)
  }
  const steps = rampSteps(events)
  const labels = steps.map((step, index) => String(num(step.percent) ?? index + 1))
  const splitPoints = canarySplit(events)
  const split: ChartSeries[] = splitPoints.length > 0
    ? [
      { name: 'cfg', rgb: [194, 65, 12], points: splitPoints.map(point => ({ x: String(point.percent), y: point.percent })) },
      { name: 'seen', rgb: [15, 118, 110], points: splitPoints.map(point => ({ x: String(point.percent), y: point.seen })) },
    ]
    : [
      { name: 'cfg', rgb: [194, 65, 12], points: steps.map((step, index) => ({ x: labels[index] ?? '', y: num(step.percent) ?? 0 })) },
      { name: 'seen', rgb: [15, 118, 110], points: steps.map((step, index) => ({ x: labels[index] ?? '', y: num(step.routedNewShare) ?? num(step.observedPercent) ?? 0 })) },
    ]
  const latency: ChartSeries[] = [
    { name: 'new', rgb: [194, 65, 12], points: steps.map((step, index) => ({ x: labels[index] ?? '', y: num(step.nextWallP99) ?? 0 })) },
    { name: 'old', rgb: [29, 78, 216], points: steps.map((step, index) => ({ x: labels[index] ?? '', y: num(step.previousWallP99) ?? 0 })) },
  ]
  const finishedSteps = finished && finished.kind === 'lifecycle' && finished.payload.event === 'run_finished' ? finished.payload.steps : []
  const burnLabels = (finishedSteps.length ? finishedSteps : steps).map((step, index) => String(num('percent' in step ? step.percent : step.percent) ?? index + 1))
  const burnNames = ['availability', 'read_latency', 'write_latency', 'correctness'] as const
  const burnColors = [[185, 28, 28], [194, 65, 12], [180, 83, 9], [21, 128, 61]] as const
  const burn: ChartSeries[] = burnNames.map((name, index) => ({
    name: name === 'read_latency' ? 'read' : name === 'write_latency' ? 'write' : name === 'availability' ? 'avail' : 'correct',
    rgb: burnColors[index] ?? [15, 23, 42],
    points: (finishedSteps.length ? finishedSteps : steps).map((step, stepIndex) => ({
      x: burnLabels[stepIndex] ?? '',
      y: burnsOf('burns' in step ? step.burns : undefined)[name] ?? 0,
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
