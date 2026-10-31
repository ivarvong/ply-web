import { readFile, writeFile } from 'node:fs/promises'
import { planBump, pinSpec } from './bump-plan.ts'
import { ROOT } from './cf.ts'
import { fetchOriginMain, originMainReason } from './preflight.ts'
import { errorMessage, run } from './proc.ts'
import { fail, pass, type StageResult } from './result.ts'
import type { CdConfig } from './config.ts'

const INSTEAD = ['ssh://git@github.com/', 'git+ssh://git@github.com/', 'git@github.com:']
const INSTEAD_KEY = 'url.https://github.com/.insteadof'

export type BumpValue = {
  readonly sha: string
  readonly from: string | null
  readonly committed: boolean
  readonly branch: string | null
}

async function git(args: readonly string[], cwd = ROOT): Promise<{ code: number; stdout: string; stderr: string }> {
  return run('git', args, { cwd })
}

export async function resolvePlySha(sha: string | null): Promise<string> {
  if (sha) return sha
  const remote = await git(['ls-remote', 'https://github.com/ivarvong/ply.git', 'refs/heads/main'])
  if (remote.code !== 0) throw new Error(`git ls-remote failed: ${remote.stderr.slice(0, 300)}`)
  const resolved = remote.stdout.trim().split(/\s+/)[0] ?? ''
  if (!/^[0-9a-f]{40}$/.test(resolved)) throw new Error('git ls-remote did not return a ply main sha')
  return resolved
}

async function ensureHttps(): Promise<() => Promise<void>> {
  const current = await git(['config', '--local', '--get-all', INSTEAD_KEY])
  const have = new Set((current.code === 0 ? current.stdout : '').split('\n').map(line => line.trim()).filter(Boolean))
  const added: string[] = []
  for (const value of INSTEAD) {
    if (have.has(value)) continue
    const set = await git(['config', '--local', '--add', INSTEAD_KEY, value])
    if (set.code !== 0) throw new Error(`git config insteadOf failed: ${set.stderr.slice(0, 300)}`)
    added.push(value)
  }
  return async () => {
    for (const value of added) await git(['config', '--local', '--unset', INSTEAD_KEY, value])
  }
}

async function restorePinFiles(): Promise<void> {
  await git(['checkout', '--', 'package.json', 'package-lock.json'])
}

function bumpFail(reason: string) {
  return fail('bump', reason, false, 'harness_fault')
}

async function returnTo(branch: string, head: string): Promise<string | null> {
  const target = branch || head
  if (!target) return null
  const back = await git(['checkout', target])
  return back.code === 0 ? null : (back.stderr || back.stdout).trim().slice(0, 300)
}

/** Commit the pin onto `branch`, whose parent is `base` (origin/main), not the checkout we started on. */
async function commitOnMain(branch: string, base: string, sha: string, spec: string, from: string): Promise<StageResult<BumpValue>> {
  const current = await git(['branch', '--show-current'])
  const startedBranch = current.stdout.trim()
  const started = await git(['rev-parse', 'HEAD'])
  const startedHead = started.stdout.trim()
  const onBump = startedBranch === branch
  const name = await git(['config', 'user.name'])
  const email = await git(['config', 'user.email'])
  if (name.code !== 0 || !name.stdout.trim() || email.code !== 0 || !email.stdout.trim()) {
    return bumpFail( 'git user.name and user.email must be set')
  }
  if (onBump) {
    const reset = await git(['reset', '--hard', base])
    if (reset.code !== 0) return bumpFail( `could not reset ${branch} onto origin/main: ${reset.stderr.slice(0, 300)}`)
  } else {
    const detached = await git(['checkout', '--detach', base])
    if (detached.code !== 0) return bumpFail( `could not detach at origin/main: ${detached.stderr.slice(0, 300)}`)
  }
  let failure: string | null = null
  let removeHttps: (() => Promise<void>) | null = null
  try {
    const pkgText = await readFile(`${ROOT}/package.json`, 'utf8')
    if (!pkgText.includes(spec)) failure = 'dependencies.ply text was not found in package.json'
    if (!failure) await writeFile(`${ROOT}/package.json`, pkgText.replace(spec, pinSpec(sha)))
    if (!failure) removeHttps = await ensureHttps()
    if (!failure) {
      const installed = await run('npm', ['install'], { cwd: ROOT })
      if (installed.code !== 0) failure = `npm install failed: ${installed.stderr.slice(0, 400)}`
    }
    if (!failure) {
      const lock = JSON.parse(await readFile(`${ROOT}/package-lock.json`, 'utf8')) as {
        packages?: { 'node_modules/ply'?: { resolved?: string } }
      }
      const resolved = lock.packages?.['node_modules/ply']?.resolved ?? ''
      if (!resolved.endsWith(`#${sha}`)) failure = 'package-lock.json did not record the ply pin'
    }
    if (!failure) {
      const gateEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'ply-web',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'ply-web@example.com',
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME || 'ply-web',
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL || 'ply-web@example.com',
      }
      for (const [cmd, args] of [
        ['npm', ['run', 'typecheck']],
        ['npx', ['oxlint']],
        ['npm', ['test']],
      ] as const) {
        const gate = await run(cmd, args, { cwd: ROOT, env: gateEnv })
        if (gate.code !== 0) {
          failure = `${cmd} ${args.join(' ')} failed: ${gate.stderr.slice(-400) || gate.stdout.slice(-400)}`
          break
        }
      }
    }
    if (!failure) {
      const added = await git(['add', 'package.json', 'package-lock.json'])
      if (added.code !== 0) failure = `git add failed: ${added.stderr.slice(0, 300)}`
    }
    if (!failure) {
      const committed = await git(['commit', '-m', `Pin ply to ${sha}.`])
      if (committed.code !== 0) failure = `git commit failed: ${committed.stderr.slice(0, 300)}`
    }
  } catch (error) {
    failure = errorMessage(error)
  } finally {
    if (removeHttps) await removeHttps()
  }
  if (failure) {
    await restorePinFiles()
    if (!onBump) {
      const back = await returnTo(startedBranch, startedHead)
      if (back) failure = `${failure}; also could not return to the previous checkout: ${back}`
    }
    return bumpFail( failure)
  }
  if (!onBump) {
    const forced = await git(['branch', '-f', branch, 'HEAD'])
    if (forced.code !== 0) {
      const back = await returnTo(startedBranch, startedHead)
      const reason = `could not point ${branch} at the pin commit: ${forced.stderr.slice(0, 300)}`
      return bumpFail( back ? `${reason}; also could not return to the previous checkout: ${back}` : reason)
    }
    const onto = await git(['checkout', branch])
    if (onto.code !== 0) return bumpFail( `pin is committed but checkout ${branch} failed: ${onto.stderr.slice(0, 300)}`)
  }
  return pass('bump', { sha, from, committed: true, branch })
}

export async function stageBump(config: CdConfig, shaArg: string | null): Promise<StageResult<BumpValue>> {
  try {
    const sha = await resolvePlySha(shaArg ?? config.sha)
    const dirty = await git(['status', '--porcelain', '--untracked-files=no'])
    if (dirty.code !== 0) return bumpFail( `git status failed: ${dirty.stderr.slice(0, 300)}`)
    if (dirty.stdout.trim()) return bumpFail( 'tracked files are modified; bump wants a clean tree')
    const base = await fetchOriginMain(ROOT)
    if (!base.ok) return bumpFail( originMainReason(base))
    const shown = await git(['show', `${base.sha}:package.json`])
    if (shown.code !== 0) return bumpFail( 'origin/main has no package.json')
    const spec = (JSON.parse(shown.stdout) as { dependencies?: { ply?: string } }).dependencies?.ply
    if (typeof spec !== 'string') return bumpFail( 'package.json has no dependencies.ply')
    const plan = planBump(spec, sha)
    if (plan.kind === 'invalid') return bumpFail( plan.reason)
    if (plan.kind === 'unchanged') return pass('bump', { sha, from: null, committed: false, branch: null })
    return await commitOnMain(config.bumpBranch, base.sha, sha, spec, plan.from)
  } catch (error) {
    return bumpFail( errorMessage(error))
  }
}
