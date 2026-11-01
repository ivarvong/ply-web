import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { defaultRunRoot, defaultTokenFile, loadConfig } from '../scripts/cd/config.ts'
import { judgeOriginMain, nodeSatisfies, originMainReason, pathWithNodeBin, selectNode } from '../scripts/cd/preflight.ts'

const MAIN = 'f9a3416001e0f89187cbc293738021c31a289c34'
const HEAD = '610913e0aabbccddeeff00112233445566778899'

test('HEAD equal to origin/main may deploy', () => {
  assert.deepEqual(judgeOriginMain(MAIN, MAIN), { ok: true, sha: MAIN })
})

test('any other HEAD is not-on-origin-main', () => {
  const result = judgeOriginMain(HEAD, MAIN)
  assert.deepEqual(result, { ok: false, kind: 'not-on-origin-main', head: HEAD, main: MAIN })
  if (!result.ok) assert.match(originMainReason(result), /^not-on-origin-main: HEAD .+ is not origin\/main .+/)
})

test('engines accept 22.23, 24.22, and 26.12, and a newer image is selected for 22.14', () => {
  const engines = '^22.23.0 || ^24.22.0 || >=26.12.0'
  assert.equal(nodeSatisfies('v22.23.0', engines), true)
  assert.equal(nodeSatisfies('v22.22.9', engines), false)
  assert.equal(nodeSatisfies('v24.22.0', engines), true)
  assert.equal(nodeSatisfies('v24.21.9', engines), false)
  assert.equal(nodeSatisfies('v26.12.0', engines), true)
  assert.equal(nodeSatisfies('v26.11.9', engines), false)
  assert.equal(nodeSatisfies('v27.0.0', engines), true)
  assert.equal(nodeSatisfies('v22.14.0', engines), false)
  const image = '/workspace/node-v24.22.1-linux-x64/bin/node'
  assert.equal(selectNode('v22.14.0', [{ bin: image, version: 'v24.22.1' }], engines), image)
  assert.equal(selectNode('v22.23.4', [{ bin: image, version: 'v24.22.1' }], engines), null)
  assert.equal(selectNode('v22.14.0', [{ bin: image, version: null }], engines), null)
})

test('token file and run dir have documented defaults', () => {
  assert.equal(defaultTokenFile(), join(homedir(), '.ply-token'))
  assert.equal(defaultRunRoot(), join(homedir(), '.local', 'state', 'ply-cd', 'runs'))
  const config = loadConfig({})
  assert.equal(config.tokenFile, defaultTokenFile())
  assert.equal(config.runRoot, defaultRunRoot())
})

test('the chosen node bin is placed first on PATH', () => {
  assert.equal(pathWithNodeBin('/workspace/node-v24.22.1-linux-x64/bin/node', '/usr/bin'), `/workspace/node-v24.22.1-linux-x64/bin${delimiter}/usr/bin`)
  assert.equal(pathWithNodeBin('/opt/node/bin/node', undefined), '/opt/node/bin')
  const wrapper = readFileSync(new URL('../scripts/cd.sh', import.meta.url), 'utf8')
  assert.match(wrapper, /PATH="\$node_dir\$\{PATH:\+:\$PATH\}"/)
})

test('a missing sha is origin-main-unavailable', () => {
  const result = judgeOriginMain('HEAD', MAIN)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.kind, 'origin-main-unavailable')
    assert.match(originMainReason(result), /^origin-main-unavailable: /)
  }
})
