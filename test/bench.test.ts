// The probe workbench (src/bench): its parsers and pages, and whole runs of ply's scenarios through the Worker's run
// path against git http-backend standing in for Artifacts (test/bench-harness.ts). Every runnable scenario but the
// 10-20 s stalls runs here and must meet its stated expectation with its cleanup proven; a server that lies about a
// push is classified server_bug with the exchange and cf-ray that show it; an export carries no credential.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Tracer } from 'ply'
import { SCENARIOS } from 'ply/probes'
import { presentedSecret } from '../src/bench/auth.ts'
import { mintRunId, parseRunSeed, repoNameFor, type RunSeed } from '../src/bench/brand.ts'
import { CATALOGUE } from '../src/bench/catalogue.ts'
import { replayJson, replayTest } from '../src/bench/export.ts'
import { handPack } from '../src/bench/handpack.ts'
import { benchRoute, replayOf, sameOrigin } from '../src/bench/http.ts'
import { createRecorder } from '../src/bench/recorder.ts'
import { runPage, indexPage } from '../src/bench/render.ts'
import { runLive, type RunResult } from '../src/bench/run.ts'
import { buildSeed } from '../src/bench/seed.ts'
import type { StoredRun } from '../src/bench/store.ts'
import { verdictOf } from '../src/bench/verdict.ts'
import { waterfall } from '../src/bench/waterfall.ts'
import { readReceiveRequest } from '../src/bench/wire.ts'
import { startHarness, type Harness } from './bench-harness.ts'

const seedOf = (s: string): RunSeed => { const r = parseRunSeed(s); if (!r.ok) throw new Error(r.error); return r.value }
const SEED = seedOf('t1')
const SLOW = new Set(['interrupted.stall-timeouts#push-request-stall', 'interrupted.stall-timeouts#push-request-stall-10s', 'interrupted.stall-timeouts#fetch-request-stall'])

let h: Harness
before(async () => { h = await startHarness() })
after(async () => { await h.close() })

async function runOne(id: string, upstream: typeof fetch = h.upstream): Promise<{ readonly result: RunResult; readonly stored: StoredRun }> {
  const entry = CATALOGUE.find(e => e.scenario.id === id)
  assert.ok(typeof entry === 'object', id)
  const run = mintRunId()
  const repo = repoNameFor(SEED, run)
  const t0 = Date.now()
  const result = await runLive({ repos: h.repos, upstream, tracer: new Tracer(), parent: null, keepBodies: () => {}, created: async () => {} }, entry.scenario, SEED, repo)
  return { result, stored: { id: run, scenario: id, seed: SEED, repo, startedAt: t0, finishedAt: Date.now(), ply: 'test', result, spans: [] } }
}

test('auth: Bearer, or Basic with the token as the password; nothing else', () => {
  assert.deepEqual(presentedSecret('Bearer abc'), { tag: 'secret', value: 'abc' })
  assert.deepEqual(presentedSecret(`Basic ${btoa('ivar:s3cret')}`), { tag: 'secret', value: 's3cret' })
  assert.deepEqual(presentedSecret(`Basic ${btoa('ivar:')}`), { tag: 'none' })
  assert.deepEqual(presentedSecret('Basic !!'), { tag: 'none' })
  assert.deepEqual(presentedSecret(null), { tag: 'none' })
})

test('routes: only the listed paths, run ids are 16 hex', () => {
  assert.deepEqual(benchRoute('GET', '/bench'), { tag: 'index' })
  assert.deepEqual(benchRoute('POST', '/bench/runs'), { tag: 'start' })
  assert.deepEqual(benchRoute('GET', '/bench/runs/0123456789abcdef'), { tag: 'run', id: '0123456789abcdef' })
  assert.deepEqual(benchRoute('GET', '/bench/runs/0123456789abcdef/exchanges/3/response'), { tag: 'body', id: '0123456789abcdef', i: 3, which: 'response' })
  assert.deepEqual(benchRoute('GET', '/bench/runs/0123456789abcdef/push-x-01234567.test.js'), { tag: 'export', id: '0123456789abcdef', file: 'test' })
  assert.equal(benchRoute('GET', '/bench/runs/../etc'), null)
  assert.equal(benchRoute('DELETE', '/bench/runs/0123456789abcdef'), null)
  const post = (h2: Record<string, string>): Request => new Request('https://ply.example/bench/runs', { method: 'POST', headers: h2 })
  assert.equal(sameOrigin(post({ 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(sameOrigin(post({ 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(sameOrigin(post({ origin: 'https://evil.example' })), false)
  assert.equal(sameOrigin(post({})), false)
})

test('recorder: cf-ray, status, timings and bytes per exchange; the credential never kept', async () => {
  const token = 'art_v1_secretsecret'
  const rec = createRecorder({
    upstream: async () => new Response('001e# service=git-upload-pack\n0000', { status: 200, headers: { 'cf-ray': '0123456789abcdef-SJC', 'x-echo': `Bearer ${token}` } }),
    now: () => 0, scrub: s => s.split(token).join('[token]'), tracer: new Tracer(), keepBodies: () => {},
  })
  const res = await rec.fetchFor('main')(`https://h.example/git/ns/r.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${token}`, 'git-protocol': 'version=2' } })
  assert.equal(res.status, 200)
  const [x] = rec.exchanges
  assert.ok(typeof x === 'object')
  assert.equal(x.kind, 'advertise-upload')
  assert.deepEqual(x.cfRay, { kind: 'id', id: '0123456789abcdef-SJC' })
  assert.ok(!JSON.stringify(rec.exchanges).includes(token), 'no token in the record')
  assert.ok(!x.requestHeaders.some(([k]) => k === 'authorization'))
})

test('hand packs: the damage each plan names', async () => {
  const s = SCENARIOS.find(x => x.id === 'pack.push-corrupt-pack-refused#bad-trailer')
  assert.ok(typeof s === 'object')
  const built = await buildSeed(s.seed)
  assert.ok(built.ok)
  const st = s.steps[0]
  assert.ok(st.tag === 'push' && st.push.pack.tag === 'hand')
  const p = await handPack(built.value, [...built.value.objects.values()].slice(0, 2), st.push.pack)
  assert.ok(p.ok)
  assert.deepEqual([...p.value.subarray(0, 4)], [0x50, 0x41, 0x43, 0x4b])
})

for (const e of CATALOGUE.filter(x => x.support.tag === 'runnable' && !SLOW.has(x.scenario.id))) {
  test(`run ${e.scenario.id} against the stand-in: meets the expectation, every exchange has a ray, cleanup proven`, async () => {
    const { result } = await runOne(e.scenario.id)
    assert.equal(result.verdict.tag, 'pass', JSON.stringify(result.verdict).slice(0, 600))
    assert.ok(result.exchanges.length > 0)
    for (const x of result.exchanges) assert.ok(x.answer.tag === 'no-response' || x.cfRay.kind === 'id', `#${x.i} has a cf-ray`)
    const c = result.cleanup
    assert.ok(c.tokensListed >= 1 && c.tokensRevoked === c.tokensListed, 'every token revoked')
    assert.equal(c.revokedStatus, 403)
    assert.ok(c.refused && c.deleted && c.gone, JSON.stringify(c))
  })
}

test('a server that reports ok and does not apply the push is a server_bug, with the exchange and its ray', async () => {
  const pkt = (s: string | Uint8Array): Uint8Array<ArrayBuffer> => { const b = typeof s === 'string' ? new TextEncoder().encode(s) : s; const out = new Uint8Array(b.length + 4); out.set(new TextEncoder().encode((b.length + 4).toString(16).padStart(4, '0'))); out.set(b, 4); return out }
  const cat = (...p: Uint8Array[]): Uint8Array<ArrayBuffer> => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let a = 0; for (const x of p) { o.set(x, a); a += x.length } return o }
  let lied = 0
  const liar: typeof fetch = async (input, init) => {
    const req = new Request(input, init)
    if (req.method === 'POST' && req.url.endsWith('/git-receive-pack') && lied === 0) {
      const body = new Uint8Array(await req.arrayBuffer())
      const cmds = readReceiveRequest(body).commands
      if (cmds.length > 0 && cmds.every(c => c.ref === 'refs/heads/new')) {
        lied++
        const report = cat(pkt('unpack ok\n'), ...cmds.map(c => pkt(`ok ${c.ref}\n`)), new TextEncoder().encode('0000'))
        const banded = cat(pkt(cat(Uint8Array.of(1), report)), new TextEncoder().encode('0000'))
        return new Response(banded, { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result', 'cf-ray': 'feedfacefeedface-SJC' } })
      }
      return h.upstream(req.url, { method: 'POST', headers: req.headers, body })
    }
    return h.upstream(req)
  }
  const { result, stored } = await runOne('push.create-ref#plain', liar)
  assert.equal(lied, 1)
  assert.equal(result.verdict.tag, 'fail')
  const v = result.verdict
  assert.ok(v.tag === 'fail')
  const bug = v.failures.find(f => f.tag === 'server_bug')
  assert.ok(typeof bug === 'object', JSON.stringify(v.failures.map(f => [f.tag, f.difference.field])))
  assert.ok(bug.evidence.some(x => x.cfRay === 'feedfacefeedface-SJC'))
  assert.ok(result.cleanup.gone)
  // the export: the plan verbatim, the observation, the differences; no credential, no URL of the server
  const replay = replayOf(stored)
  assert.ok(replay !== null)
  const json = replayJson(replay)
  const file = replayTest(replay)
  const leak = /art_v1_|Bearer|127\.0\.0\.1:|server_bug|client_bug/.exec(json + file)
  assert.equal(leak, null, String(leak && (json + file).slice(Math.max(0, leak.index - 80), leak.index + 40)))
  assert.equal(JSON.parse(json).differences.length, v.failures.length)
  // the run page and the waterfall render, escaped, with a row per exchange
  const page = runPage(stored, replay.scenario).text
  assert.ok(page.includes('server_bug') && page.includes('feedfacefeedface-SJC'))
  assert.equal((waterfall(result.exchanges).text.match(/class="wf-row/g) || []).length, result.exchanges.length)
  assert.ok(!page.includes('<script'))
})

test('client_bug: ply concluding landed when the report on the same exchange says ng', () => {
  const s = SCENARIOS.find(x => x.id === 'push.create-ref#plain')
  assert.ok(typeof s === 'object')
  const obs = { steps: [{ outcomes: [{ outcome: 'landed' as const, error: null, detail: '' }] as const }], end: { head: 'refs/heads/main', refs: {}, objects: [], trees: {}, ancestry: [], mergeBases: {}, fsck: [] } }
  const x = {
    i: 4, phase: { tag: 'step' as const, index: 0 }, channel: 'main' as const, method: 'POST', path: '/r.git/git-receive-pack', kind: 'receive-pack' as const, answer: { tag: 'http' as const, status: 200 },
    startMs: 0, headersMs: 1, endMs: 2, requestBytes: 1, responseBytes: 1, cfRay: { kind: 'missing' as const }, requestHeaders: [], responseHeaders: [], applied: null,
    wire: { tag: 'receive-pack' as const, request: { commands: [], capabilities: [], shallow: [], packBytes: 0 }, report: { tag: 'report' as const, unpack: { tag: 'ok' as const }, refs: [{ tag: 'ng' as const, ref: 'refs/heads/topic', reason: 'denied' }], sideband: null } },
  }
  const v = verdictOf(s, obs, {}, [x])
  assert.ok(v.tag === 'fail')
  assert.ok(v.failures.some(f => f.tag === 'client_bug' && f.evidence.some(e => e.exchange === 4)), JSON.stringify(v.failures.map(f => f.tag)))
})

test('index page: every catalogue scenario listed, the runnable ones offered', () => {
  const text = indexPage(CATALOGUE, [], { created: 0, cleaned: 0, lastHour: 0 }, 'test', null).text
  for (const e of CATALOGUE) assert.ok(text.includes(e.scenario.id), e.scenario.id)
  assert.equal((text.match(/<option /g) || []).length, CATALOGUE.filter(e => e.support.tag === 'runnable').length)
})
