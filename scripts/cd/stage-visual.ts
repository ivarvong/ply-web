import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT } from './cf.ts'
import type { CdConfig } from './config.ts'
import { activeLog } from './log.ts'
import { run } from './proc.ts'
import { fail, pass, type StageResult } from './result.ts'
import { writeJson } from './run-dir.ts'

export type VisualValue = {
  readonly pages: number
  readonly outdir: string
  /** Set when the check could not run here (no Chrome). Not a pass of the pages, not a Worker fault. */
  readonly skipped: string | null
}

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/** The run is 9 pages × 4 viewports; a healthy one takes about 15 s. */
const VISUAL_TIMEOUT_MS = 120_000

type Row = Readonly<Record<string, unknown>>

function rows(stdout: string): Row[] {
  const out: Row[] = []
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      out.push(JSON.parse(line) as Row)
    } catch {
      continue
    }
  }
  return out
}

/**
 * The CDP visual smoke (scripts/visual-smoke.mjs) against the live URL after promotion: 375 and
 * 1280 px, light and dark. A page assertion that fails is a Worker failure. A run that never
 * printed its summary line (Chrome missing or crashed) is a harness fault, never a rollback.
 */
export async function stageVisual(config: CdConfig, opts: { readonly runDir: string; readonly version: string }): Promise<StageResult<VisualValue>> {
  const outdir = join(opts.runDir, 'visual')
  await mkdir(outdir, { recursive: true })
  const chrome = process.env.CHROME || DEFAULT_CHROME
  const log = activeLog()
  const started = Date.now()
  if (!existsSync(chrome)) {
    const skipped = `no Chrome at ${chrome}; set CHROME to run the visual smoke`
    await writeJson(opts.runDir, 'visual.json', { kind: 'skipped', reason: skipped })
    if (log) await log.observation({ measurement: { source: 'visual-smoke', skipped }, query: { source: 'visual-smoke' }, from: started, to: Date.now(), raw: skipped })
    return pass('visual', { pages: 0, outdir, skipped })
  }
  const result = await run(process.execPath, [join(ROOT, 'scripts/visual-smoke.mjs'), config.baseUrl, outdir], {
    cwd: ROOT,
    timeout: VISUAL_TIMEOUT_MS,
    // Every page must come from the version just promoted: a straggler on the old one during propagation fails it.
    env: { ...process.env, PLY_VERSION: opts.version },
  })
  const parsed = rows(result.stdout)
  const pages = parsed.filter(row => typeof row.url === 'string')
  const summaries = parsed.filter(row => typeof row.failed === 'boolean')
  const broken = pages.filter(row => row.ok === false).map(row => `${String(row.url)} ${String(row.w)} ${String(row.scheme)}: ${Array.isArray(row.problems) ? row.problems.join('; ') : ''}`)
  const verdict = summaries.length === 0
    ? { kind: 'harness_fault' as const, reason: `visual smoke exited ${result.code} without a summary: ${result.stderr.trim().split('\n').slice(-1).join('')}` }
    : broken.length > 0 || summaries.some(row => row.failed === true)
      ? { kind: 'fail' as const, reason: `visual smoke: ${broken.length}/${pages.length} views broken${broken.length ? `: ${broken.slice(0, 3).join(' | ')}` : ''}` }
      : { kind: 'pass' as const, reason: `visual smoke: ${pages.length}/${pages.length} views ok` }
  await writeJson(opts.runDir, 'visual.json', { ...verdict, version: opts.version, pages: pages.length, broken, outdir, exitCode: result.code, durationMs: Date.now() - started })
  if (log) {
    const ref = await log.observation({
      measurement: { source: 'visual-smoke', pages: pages.length, broken: broken.length, exitCode: result.code },
      query: { source: 'visual-smoke', base: config.baseUrl },
      from: started,
      to: Date.now(),
      raw: JSON.stringify({ broken }),
    })
    await log.decision({
      inputs: [ref],
      rules: [{ name: 'visual_smoke', value: verdict.kind }],
      outcome: verdict.kind === 'pass' ? 'advance' : verdict.kind === 'harness_fault' ? 'harness_fault' : 'rollback',
      reason: verdict.reason,
    })
  }
  if (verdict.kind === 'harness_fault') return fail('visual', verdict.reason, false, 'harness_fault')
  if (verdict.kind === 'fail') return fail('visual', verdict.reason)
  return pass('visual', { pages: pages.length, outdir, skipped: null })
}
