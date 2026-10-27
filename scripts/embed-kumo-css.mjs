// Copies @cloudflare/kumo/styles/standalone into a TypeScript string.
// Node's test runner and the Worker bundle cannot import a CSS file.
import { readFileSync, writeFileSync } from 'node:fs'
const css = readFileSync(new URL('../node_modules/@cloudflare/kumo/dist/styles/kumo-standalone.css', import.meta.url), 'utf8')
const banner = `// Verbatim stylesheet from @cloudflare/kumo/styles/standalone (kumo 2.16.0).
// Regenerate with: node scripts/embed-kumo-css.mjs
// Do not edit by hand. Tests compare this string to the installed package.
`
writeFileSync(new URL('../src/viewer/kumo-standalone.ts', import.meta.url), `${banner}export const KUMO_STANDALONE_CSS = ${JSON.stringify(css)}\n`)
