// Builds the Worker with `cf build` and copies the bundle that `cf deploy --prebuilt` would upload, so the workerd
// suites run the deployed artifact rather than a test-only bundle.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CF = join(ROOT, 'node_modules', '.bin', 'cf');
// cf's Build Output Specification, version 0. One Worker, named "default" because it is the only one.
const WORKER_OUTPUT = join(ROOT, '.cloudflare', 'output', 'v0', 'workers', 'default');

/** Runs `cf build` once per process and returns the absolute path of the bundled main module. */
let built;
export function cfBundle() {
  built ??= (() => {
    if (!existsSync(CF)) throw new Error(`cf is not installed at ${CF}. Run npm ci.`);
    const run = spawnSync(CF, ['build', '--quiet'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CF_SEND_TELEMETRY: 'false' } });
    if (run.status !== 0) throw new Error(`cf build exited ${run.status}\n${run.stdout}\n${run.stderr}`);
    const { manifest } = JSON.parse(readFileSync(join(WORKER_OUTPUT, 'worker.config.json'), 'utf8'));
    const bundleDir = join(WORKER_OUTPUT, 'bundle');
    const modules = readdirSync(bundleDir).filter(name => name.endsWith('.js'));
    // workerd configs here embed a single module. A split bundle needs every chunk listed; fail loudly instead.
    if (modules.length !== 1 || modules[0] !== manifest.mainModule) {
      throw new Error(`expected one module, ${manifest.mainModule}, in ${bundleDir}; found ${modules.join(', ')}`);
    }
    return join(bundleDir, manifest.mainModule);
  })();
  return built;
}

/** Copies the cf-built bundle to `dest`, the path the workerd config embeds. */
export function copyCfBundle(dest) {
  copyFileSync(cfBundle(), dest);
}
