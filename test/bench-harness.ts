// A stand-in for the Artifacts namespace binding, for the workbench tests: each create is `git init --bare` behind
// git http-backend (test/server.js) with the policy ply's probe suite gives its reference (test/probes/runner.mjs
// REFERENCE_POLICY), a write token that the upstream fetch honours until it is revoked (403 after, as Artifacts
// answers), and a cf-ray on every answer. Nothing leaves 127.0.0.1.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGitServer } from './server.js'
import type { ProbeRepos } from '../src/bench/run.ts'

const POLICY: ReadonlyArray<readonly [string, string]> = [
  ['http.receivepack', 'true'], ['receive.fsckObjects', 'true'], ['transfer.fsckObjects', 'true'],
  ['uploadpack.allowFilter', 'true'], ['uploadpack.allowReachableSHA1InWant', 'true'], ['uploadpack.allowAnySHA1InWant', 'false'],
  ['receive.maxInputSize', String(64 * 1024 * 1024)], ['receive.advertiseAtomic', 'true'], ['gc.auto', '0'], ['maintenance.auto', 'false'],
]

export type Harness = {
  readonly repos: ProbeRepos
  readonly upstream: typeof fetch
  readonly made: string[]
  readonly deleted: string[]
  readonly revoked: string[]
  readonly close: () => Promise<void>
}

export async function startHarness(config: (name: string) => ReadonlyArray<readonly [string, string]> = () => []): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ply-bench-'))
  const srv = await startGitServer(root)
  const tokens = new Map<string, { readonly repo: string; active: boolean }>()
  const made: string[] = []
  const deleted: string[] = []
  const revoked: string[] = []
  let n = 0
  const repos: ProbeRepos = {
    async create(name) {
      const dir = join(root, `${name}.git`)
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir])
      for (const [k, v] of [...POLICY, ...config(name)]) execFileSync('git', ['config', k, v], { cwd: dir })
      const token = `art_v1_${String(n++).padStart(40, '0')}`
      tokens.set(token, { repo: name, active: true })
      made.push(name)
      return { name, remote: `${srv.url}/${name}.git`, token }
    },
    async get(name) {
      if (!made.includes(name) || deleted.includes(name)) throw Object.assign(new Error(`repository ${name}: NOT_FOUND`), { code: 'NOT_FOUND' })
      return {
        async listTokens() { return { tokens: [...tokens].filter(([, t]) => t.repo === name).map(([id, t]) => ({ id, state: t.active ? 'active' : 'revoked' })) } },
        async revokeToken(id: string) { const t = tokens.get(id); if (typeof t !== 'object' || !t.active) return false; t.active = false; revoked.push(id); return true },
      }
    },
    async delete(name) { if (!made.includes(name) || deleted.includes(name)) return false; rmSync(join(root, `${name}.git`), { recursive: true, force: true }); deleted.push(name); return true },
  }
  let ray = 0
  const upstream: typeof fetch = async (input, init) => {
    const req = new Request(input, init)
    const auth = String(req.headers.get('authorization'))
    const t = tokens.get(auth.replace(/^Bearer /, ''))
    const id = `${(0xabc000 + ray++).toString(16).padStart(16, '0')}-SJC`
    if (typeof t !== 'object' || !t.active) return new Response('forbidden\n', { status: 403, headers: { 'cf-ray': id } })
    // A streamed body is read here first: git http-backend's CGI child would wait forever on a body cut halfway (the
    // recorder's cut-request), keeping this process alive, so a cut body never reaches the stand-in server at all.
    const body = req.body === null ? null : new Uint8Array(await req.arrayBuffer())
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body, redirect: 'manual' })
    const headers = new Headers(res.headers)
    headers.set('cf-ray', id)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
  return { repos, upstream, made, deleted, revoked, close: async () => { await srv.close(); rmSync(root, { recursive: true, force: true }) } }
}
