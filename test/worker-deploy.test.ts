import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

test('worker:deploy refuses unless PLY_FORCE_FULL_DEPLOY=1', async () => {
  const env = { ...process.env }
  delete env.PLY_FORCE_FULL_DEPLOY
  const result = await new Promise<{ code: number | null; stderr: string }>(resolve => {
    const child = spawn(process.execPath, ['scripts/worker-deploy.mjs'], { env })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('exit', code => resolve({ code, stderr }))
  })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /PLY_FORCE_FULL_DEPLOY=1/)
})
