#!/usr/bin/env node
// Join push.mjs lines with a ply-fresh /watch-result dump: for each push, each region and each target (arm), the lag from
// `git push` returning (on Cloudflare's clock) to the first poll that showed the pushed oid. A poll that started before
// the push finished but saw the new oid counts as lag 0 (the push landed mid-request).
//
//   node bench/fresh/analyse.mjs <pushes.jsonl> <watch-result.json> <arm labels comma-separated>
import { readFileSync } from 'node:fs';

const [pushFile, watchFile, labelArg] = process.argv.slice(2);
const pushes = readFileSync(pushFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const watch = JSON.parse(readFileSync(watchFile, 'utf8'));
const labels = (labelArg || 'a,b').split(',');
const rows = [];
for (const w of watch) {
  const r = w.result;
  if (!r) { console.error(`${w.hint}: no result (${w.state})`); continue; }
  r.changes.forEach((changes, k) => {
    for (const p of pushes) {
      const first = changes.find(c => c.value === p.oid);
      if (!first) { rows.push({ arm: labels[k], hint: w.hint, colo: r.colo, i: p.i, lag: null }); continue; }
      // first.t is when that poll was sent; the page was rendered between t and t + ms.
      rows.push({ arm: labels[k], hint: w.hint, colo: r.colo, i: p.i, lag: Math.max(0, first.t + first.ms - p.cfPushDone), sent: first.t - p.cfPushDone, polls: r.polls[k] });
    }
  });
}
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
function boot(a, b, stat, n = 2000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ra = a.map(() => a[Math.floor(Math.random() * a.length)]).sort((x, y) => x - y);
    const rb = b.map(() => b[Math.floor(Math.random() * b.length)]).sort((x, y) => x - y);
    out.push(stat(rb) - stat(ra));
  }
  out.sort((x, y) => x - y);
  return [out[Math.floor(0.025 * n)], out[Math.floor(0.975 * n)]];
}
const byArm = {};
for (const row of rows) (byArm[row.arm] ||= []).push(row);
for (const [arm, rs] of Object.entries(byArm)) {
  const lags = rs.filter(r => r.lag !== null).map(r => r.lag).sort((a, b) => a - b);
  const missing = rs.filter(r => r.lag === null).length;
  console.log(`${arm}: n ${lags.length} (never seen ${missing}) lag ms p50 ${q(lags, 0.5)} p90 ${q(lags, 0.9)} max ${lags.at(-1)} mean ${Math.round(lags.reduce((s, x) => s + x, 0) / lags.length)}`);
  const byHint = {};
  for (const r of rs) if (r.lag !== null) (byHint[`${r.hint}/${r.colo}`] ||= []).push(r.lag);
  console.log('  ' + Object.entries(byHint).map(([h, l]) => `${h} max ${Math.max(...l)}`).join(', '));
}
if (labels.length === 2 && byArm[labels[0]] && byArm[labels[1]]) {
  const a = byArm[labels[0]].filter(r => r.lag !== null).map(r => r.lag);
  const b = byArm[labels[1]].filter(r => r.lag !== null).map(r => r.lag);
  const med = s => q(s, 0.5), p90 = s => q(s, 0.9), mx = s => s.at(-1);
  console.log(`${labels[1]} - ${labels[0]}: p50 ${med([...b].sort((x, y) => x - y)) - med([...a].sort((x, y) => x - y))} [${boot(a, b, med)}], p90 [${boot(a, b, p90)}], max [${boot(a, b, mx)}]`);
}
if (process.env.ROWS) for (const r of rows) console.log(JSON.stringify(r));
