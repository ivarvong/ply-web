// Micro-benchmark of the viewer's README render (renderMarkdown) on real READMEs, against a previous copy of
// src/viewer/markdown.ts given as argv[2] (a path inside src/viewer so its imports resolve). Output must be identical.
// Run: node --experimental-strip-types --import ./test/register-tsx.mjs bench/markdown.bench.ts src/viewer/<old>.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderMarkdown } from '../src/viewer/markdown.ts';

const old = (await import(pathToFileURL(resolve(process.argv[2] as string)).href)) as { renderMarkdown: typeof renderMarkdown };
const docs = ['README.md', '../ply/README.md'].map(p => readFileSync(p, 'utf8').slice(0, 20_000));
for (const d of docs) if (String(old.renderMarkdown(d)) !== String(renderMarkdown(d))) throw new Error('output changed');

function run(name: string, fn: (s: string) => unknown, n: number) {
  for (let i = 0; i < 50; i++) for (const d of docs) fn(d);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) for (const d of docs) fn(d);
  console.log(`${name}: ${((performance.now() - t0) / n).toFixed(3)} ms per (2 READMEs, 20 KB each)`);
}
for (let r = 0; r < 3; r++) { run('old', old.renderMarkdown, 300); run('new', renderMarkdown, 300); }
