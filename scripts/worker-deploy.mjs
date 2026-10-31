import { spawn } from 'node:child_process'

if (process.env.PLY_FORCE_FULL_DEPLOY !== '1') {
  console.error('npm run worker:deploy uploads the Worker straight to 100%. Set PLY_FORCE_FULL_DEPLOY=1 to run it.')
  process.exit(1)
}

const child = spawn('cf', ['deploy', ...process.argv.slice(2)], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
