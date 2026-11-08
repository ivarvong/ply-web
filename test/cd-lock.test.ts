// The deployment lock (scripts/cd/lock.ts). Run 2026-11-07T18-30-47-501Z ran beside another run and replaced its 0%
// canary b494b751: a second run that writes the deployment must not get past the lock while the first is alive.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireLock, pidIsCd, type LockIo } from '../scripts/cd/lock.ts'

function fakeIo(alive: ReadonlySet<number>, host = 'box'): LockIo {
  return { alive: pid => alive.has(pid), host: () => host, now: () => new Date('2026-11-08T12:00:00Z') }
}

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ply-cd-lock-'))
}

test('a second run is refused while the first holder is alive, and gets the lock once it is released', async () => {
  const path = join(await dir(), 'deploy.lock')
  const io = fakeIo(new Set([101, 202]))
  const first = await acquireLock(path, { command: 'cd --no-bump', cwd: '/w/a', pid: 101 }, io)
  assert.equal(first.ok, true)
  const second = await acquireLock(path, { command: 'cd --no-bump', cwd: '/w/b', pid: 202 }, io)
  assert.equal(second.ok, false)
  if (!second.ok) {
    assert.match(second.reason, /held by a live run: pid 101 on box/)
    assert.match(second.reason, /cwd \/w\/a/)
  }
  if (first.ok) await first.release()
  const third = await acquireLock(path, { command: 'cd --no-bump', cwd: '/w/b', pid: 202 }, io)
  assert.equal(third.ok, true)
})

test('a lock whose pid is gone (or reused by a non-CD process) is stale and taken over, and says so', async () => {
  const path = join(await dir(), 'deploy.lock')
  await acquireLock(path, { command: 'cd', cwd: '/w/a', pid: 101 }, fakeIo(new Set([101])))
  const next = await acquireLock(path, { command: 'cd', cwd: '/w/b', pid: 202 }, fakeIo(new Set([202])))
  assert.equal(next.ok, true)
  if (next.ok) {
    assert.equal(next.tookOver === null, false)
    if (next.tookOver) assert.equal(next.tookOver.pid, 101)
    const body = JSON.parse(await readFile(path, 'utf8')) as { pid: number; cwd: string }
    assert.equal(body.pid, 202)
    assert.equal(body.cwd, '/w/b')
  }
})

test('a lock from another host is never taken over', async () => {
  const path = join(await dir(), 'deploy.lock')
  await acquireLock(path, { command: 'cd', cwd: '/w/a', pid: 101 }, fakeIo(new Set(), 'other-box'))
  const next = await acquireLock(path, { command: 'cd', cwd: '/w/b', pid: 202 }, fakeIo(new Set()))
  assert.equal(next.ok, false)
  if (!next.ok) assert.match(next.reason, /another host/)
})

test('an unreadable lock body is stale, not a permanent block', async () => {
  const path = join(await dir(), 'deploy.lock')
  await writeFile(path, 'not json')
  const next = await acquireLock(path, { command: 'cd', cwd: '/w/b', pid: 202 }, fakeIo(new Set([202])))
  assert.equal(next.ok, true)
})

test('release removes only its own lock', async () => {
  const path = join(await dir(), 'deploy.lock')
  const first = await acquireLock(path, { command: 'cd', cwd: '/w/a', pid: 101 }, fakeIo(new Set()))
  // 101 died; 202 took the lock over. A late release from 101 must not delete 202's lock.
  const second = await acquireLock(path, { command: 'cd', cwd: '/w/b', pid: 202 }, fakeIo(new Set([202])))
  assert.equal(second.ok, true)
  if (first.ok) await first.release()
  const body = JSON.parse(await readFile(path, 'utf8')) as { pid: number }
  assert.equal(body.pid, 202)
})

test('two runs racing for one free lock: exactly one wins', async () => {
  const path = join(await dir(), 'deploy.lock')
  const io = fakeIo(new Set([1, 2, 3, 4, 5, 6, 7, 8]))
  const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(pid => acquireLock(path, { command: 'cd', cwd: '/w', pid }, io)))
  assert.equal(results.filter(result => result.ok).length, 1)
})

test('two runs racing to take over one stale lock: exactly one wins', async () => {
  const path = join(await dir(), 'deploy.lock')
  await acquireLock(path, { command: 'cd', cwd: '/w', pid: 99 }, fakeIo(new Set()))
  const io = fakeIo(new Set([1, 2, 3, 4, 5, 6]))
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map(pid => acquireLock(path, { command: 'cd', cwd: '/w', pid }, io)))
  assert.equal(results.filter(result => result.ok).length, 1)
})

test('pidIsCd: this test process is alive but not a CD run; a dead pid is not alive', async () => {
  assert.equal(pidIsCd(process.pid), false)
  assert.equal(pidIsCd(-1), false)
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', 'scripts/cd/main.ts'], { stdio: 'ignore' })
  try {
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(pidIsCd(Number(child.pid)), true)
  } finally {
    child.kill()
  }
  await new Promise(resolve => child.once('exit', resolve))
  assert.equal(pidIsCd(Number(child.pid)), false)
})
