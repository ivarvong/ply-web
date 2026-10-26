// Node's type stripper does not compile JSX. esbuild does, with Hono as the runtime.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const JSX_IMPORT_SOURCE = 'hono/jsx'

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || (!url.endsWith('.ts') && !url.endsWith('.tsx'))) return nextLoad(url, context)
  const source = readFileSync(fileURLToPath(url), 'utf8')
  const { code } = transformSync(source, {
    loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
    format: 'esm',
    target: 'es2022',
    sourcemap: 'inline',
    sourcefile: fileURLToPath(url),
    jsx: 'automatic',
    jsxImportSource: JSX_IMPORT_SOURCE,
  })
  return { format: 'module', source: code, shortCircuit: true }
}
