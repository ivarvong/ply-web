// The protocol waterfall: one row per exchange, on one time axis from the start of the run. Each bar is the wait for
// the server's headers (light) then the answer's body (dark); a row with no answer is hatched to where it gave up. Rows
// are grouped by phase (seed, each step, judge, cleanup) and coloured by channel (main is ply under test, side the
// other writer, judge the read-back). A fault is marked on its row. Pure: exchanges in, inline SVG out.
import { renderRay } from '../rays.ts';
import { html, type Html } from './html.ts';
import type { Exchange, Phase } from './recorder.ts';

const WIDTH = 1100;
const LABEL = 420;
const ROW = 22;
const BAR = 12;
const TOP = 28;
const TICKS = 6;
const PAD = 12;

export const phaseName = (p: Phase): string => {
  switch (p.tag) {
    case 'seed': return 'seed';
    case 'step': return `step ${p.index}`;
    case 'judge': return 'judge';
    case 'cleanup': return 'cleanup';
  }
};
export const kb = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(2)} MiB`);
export const shortKind = (x: Exchange): string => {
  switch (x.kind) {
    case 'advertise-upload': return 'GET info/refs upload-pack';
    case 'advertise-receive': return 'GET info/refs receive-pack';
    case 'ls-refs': return 'POST upload-pack ls-refs';
    case 'fetch': return 'POST upload-pack fetch';
    case 'receive-pack': return 'POST receive-pack';
    case 'other': return `${x.method} ${x.path.split('?')[0] || ''}`;
  }
};
export const answerText = (x: Exchange): string => (x.answer.tag === 'http' ? String(x.answer.status) : 'no answer');

export function waterfall(xs: readonly Exchange[]): Html {
  const total = Math.max(1, ...xs.map(x => x.endMs));
  const plot = WIDTH - LABEL - PAD;
  const at = (ms: number): number => LABEL + (ms / total) * plot;
  const height = TOP + xs.length * ROW + PAD;
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) => Math.round((total * i) / TICKS));
  let last = '';
  const rows = xs.map((x, r) => {
    const y = TOP + r * ROW;
    const ph = phaseName(x.phase);
    const band = ph === last ? null : html`<line class="wf-phase" x1="0" x2="${WIDTH}" y1="${y}" y2="${y}"/><text class="wf-phase-label" x="${WIDTH - PAD}" y="${y + 11}" text-anchor="end">${ph}</text>`;
    last = ph;
    const x0 = at(x.startMs);
    const xh = x.headersMs === null ? at(x.endMs) : at(x.headersMs);
    const x1 = Math.max(at(x.endMs), xh + 1);
    const wait = html`<rect class="wf-wait wf-${x.channel}" x="${x0.toFixed(1)}" y="${y + 5}" width="${Math.max(1, xh - x0).toFixed(1)}" height="${BAR}"/>`;
    const body = x.headersMs === null ? null : html`<rect class="wf-body wf-${x.channel}" x="${xh.toFixed(1)}" y="${y + 5}" width="${Math.max(1, x1 - xh).toFixed(1)}" height="${BAR}"/>`;
    const fault = x.applied === null ? null : html`<text class="wf-fault" x="${(x1 + 4).toFixed(1)}" y="${y + 15}">⚡ ${x.applied.tag}</text>`;
    const failed = x.answer.tag === 'no-response' ? ' wf-failed' : '';
    const label = `#${x.i} ${x.channel} ${shortKind(x)} ${answerText(x)}  ↑${kb(x.requestBytes)} ↓${kb(x.responseBytes)}`;
    const ms = `${Math.round(x.endMs - x.startMs)} ms · ray ${renderRay(x.cfRay)}`;
    return html`${band}<a href="#x${x.i}"><g class="wf-row${failed}"><title>${label} · ${ms}</title><text class="wf-label" x="4" y="${y + 15}">${label}</text>${wait}${body}${fault}<text class="wf-ms" x="${(x1 + 4).toFixed(1)}" y="${y + (x.applied === null ? 15 : 26)}">${x.applied === null ? `${Math.round(x.endMs - x.startMs)} ms` : null}</text></g></a>`;
  });
  const axis = ticks.map(t => html`<line class="wf-tick" x1="${at(t).toFixed(1)}" x2="${at(t).toFixed(1)}" y1="${TOP - 6}" y2="${height - PAD}"/><text class="wf-tick-label" x="${at(t).toFixed(1)}" y="${TOP - 10}" text-anchor="middle">${t} ms</text>`);
  return html`<svg class="waterfall" role="img" aria-label="protocol waterfall, ${xs.length} exchanges over ${total} ms" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" xmlns="http://www.w3.org/2000/svg">${axis}${rows}</svg>`;
}
