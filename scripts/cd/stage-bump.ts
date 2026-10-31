import { readFile, writeFile } from 'node:fs/promises'
import { planBump, pinSpec } from './bump-plan.ts'
import { ROOT } from './cf.ts'
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

export async function stageBump(config: CdConfig, shaArg: string | null): Promise<StageResult<BumpValue>> {
  try {
    const sha = await resolvePlySha(shaArg ?? config.sha)
    const pkgText = await readFile(`${ROOT}/package.json`, 'utf8')
    const spec = (JSON.parse(pkgText) as { dependencies?: { ply?: string } }).dependencies?.ply
    if (typeof spec !== 'string') return fail('bump', 'package.json has no dependencies.ply')
    const plan = planBump(spec, sha)
    if (plan.kind === 'invalid') return fail('bump', plan.reason)
    if (plan.kind === 'unchanged') return pass('bump', { sha, from: null, committed: false, branch: null })
    const dirty = await git(['status', '--porcelain', '--untracked-files=no'])
    if (dirty.code !== 0) return fail('bump', `git status failed: ${dirty.stderr.slice(0, 300)}`)
    if (dirty.stdout.trim()) return fail('bump', 'tracked files are modified; bump wants a clean tree')
    const name = await git(['config', 'user.name'])
    const email = await git(['config', 'user.email'])
    if (name.code !== 0 || !name.stdout.trim() || email.code !== 0 || !email.stdout.trim()) {
      return fail('bump', 'git user.name and user.email must be set')
    }
    const current = await git(['branch', '--show-current'])
    if (current.stdout.trim() !== config.bumpBranch) {
      const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${config.bumpBranch}`])
      if (exists.code === 0) return fail('bump', `branch ${config.bumpBranch} already exists`)
      const created = await git(['checkout', '-b', config.bumpBranch])
      if (created.code !== 0) return fail('bump', `could not create ${config.bumpBranch}: ${created.stderr.slice(0, 300)}`)
    }
    if (!pkgText.includes(spec)) return fail('bump', 'dependencies.ply text was not found in package.json')
    await writeFile(`${ROOT}/package.json`, pkgText.replace(spec, pinSpec(sha)))
    const removeHttps = await ensureHttps()
    try {
      const installed = await run('npm', ['install'], { cwd: ROOT })
      if (installed.code !== 0) {
        await restorePinFiles()
        return fail('bump', `npm install failed: ${installed.stderr.slice(0, 400)}`)
      }
      const lock = JSON.parse(await readFile(`${ROOT}/package-lock.json`, 'utf8')) as {
        packages?: { 'node_modules/ply'?: { resolved?: string } }
      }
      const resolved = lock.packages?.['node_modules/ply']?.resolved ?? ''
      if (!resolved.endsWith(`#${sha}`)) {
        await restorePinFiles()
        return fail('bump', 'package-lock.json did not record the ply pin')
      }
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
          await restorePinFiles()
          return fail('bump', `${cmd} ${args.join(' ')} failed: ${gate.stderr.slice(-400) || gate.stdout.slice(-400)}`)
        }
      }
    } finally {
      await removeHttps()
    }
    const added = await git(['add', 'package.json', 'package-lock.json'])
    if (added.code !== 0) return fail('bump', `git add failed: ${added.stderr.slice(0, 300)}`)
    const committed = await git(['commit', '-m', `Pin ply to ${sha}.`])
    if (committed.code !== 0) return fail('bump', `git commit failed: ${committed.stderr.slice(0, 300)}`)
    return pass('bump', { sha, from: plan.from, committed: true, branch: config.bumpBranch })
  } catch (error) {
    return fail('bump', errorMessage(error))
  }
}
