// The workbench pages, server-rendered (no script): the catalogue with the run form, and one run: its verdict, steps,
// the protocol waterfall, every exchange's metadata, the cleanup counts, its spans and the export links.
import type { Scenario } from 'ply/probes';
import { renderRay } from '../rays.ts';
import type { CatalogueEntry } from './catalogue.ts';
import type { Counts } from './entry.ts';
import { replaySlug } from './export.ts';
import { html, type Html } from './html.ts';
import type { Exchange, Wire } from './recorder.ts';
import type { RunSummary, SpanRow, StoredRun } from './store.ts';
import type { Failure, RunVerdict } from './verdict.ts';
import { answerText, kb, phaseName, shortKind, waterfall } from './waterfall.ts';

export const BENCH_CSS_PATH = '/bench.css';

const iso = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
const short = (oid: string): string => (/^[0-9a-f]{40}$/.test(oid) ? oid.slice(0, 12) : oid);

function layout(title: string, body: Html): Html {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="stylesheet" href="${BENCH_CSS_PATH}"></head><body><header class="top"><a href="/bench">ply probe workbench</a><span class="roles">ply: the client · this Worker: the probe runner · Artifacts: the server under test</span></header><main>${body}</main></body></html>`;
}

const supportText = (e: CatalogueEntry): Html => {
  const s = e.support;
  switch (s.tag) {
    case 'runnable': return html`<span class="ok">runs</span>${s.notes.map(n => html`<div class="note">${n}</div>`)}`;
    case 'git-only': return html`<span class="muted">stock git only</span><div class="note">${s.why}</div>`;
    case 'too-large': return html`<span class="muted">seed too large (${kb(s.bytes)})</span>`;
  }
};
const stepsText = (s: Scenario): string => s.steps.map(st => (st.tag === 'push' || st.tag === 'fetch' ? `${st.tag}${st.fault.tag === 'none' ? '' : ` + ${st.fault.tag}`}` : st.tag)).join(', ');

export function indexPage(catalogue: readonly CatalogueEntry[], runs: readonly RunSummary[], counts: Counts, ply: string, notice: string | null): Html {
  const runnable = catalogue.filter(e => e.support.tag === 'runnable');
  const areas = [...new Set(runnable.map(e => e.scenario.id.split('.')[0] || ''))];
  const options = areas.map(a => html`<optgroup label="${a}">${runnable.filter(e => e.scenario.id.startsWith(`${a}.`)).map(e => html`<option value="${e.scenario.id}">${e.scenario.id}</option>`)}</optgroup>`);
  const recent = runs.map(r => html`<tr><td><a href="/bench/runs/${r.id}">${r.id}</a></td><td>${r.scenario}</td><td>${r.seed}</td><td>${iso(r.startedAt)}</td><td>${Math.round((r.finishedAt - r.startedAt) / 100) / 10} s</td><td><span class="v v-${r.verdict}">${r.verdict}</span>${r.failures > 0 ? ` ${r.failures}` : ''}</td><td>${r.exchanges}</td><td>${r.cleaned ? 'yes' : html`<span class="bad">no</span>`}</td></tr>`);
  const rows = catalogue.map(e => html`<tr><td class="mono">${e.scenario.id}</td><td>${e.scenario.description}<div class="note">${stepsText(e.scenario)}</div></td><td>${supportText(e)}</td></tr>`);
  return layout('ply probe workbench', html`
<h1>Probe workbench</h1>
<p>Run one of ply's probe scenarios (ply <span class="mono">${short(ply)}</span>, <span class="mono">ply/probes</span>) against Artifacts from this Worker. The plan fixes every object id; the seed names the run's repository. ply is the client under test; the Worker records every exchange (timings, bytes, status, headers, cf-ray, the pkt-lines) and reads the repository back. The repository is in the probe namespace and is deleted, with every token revoked, when the run ends.</p>
${notice === null ? null : html`<p class="notice">${notice}</p>`}
<form method="post" action="/bench/runs" class="run">
  <label>Scenario <select name="scenario" required>${options}</select></label>
  <label>Seed <input name="seed" value="a1" pattern="[a-z0-9]{1,16}" maxlength="16" required></label>
  <button type="submit">Run</button>
  <span class="note">One run at a time, ${counts.lastHour} of 20 this hour. The page answers when the run is over (a stall scenario takes about 30 s).</span>
</form>
<p class="note">Repositories created ${counts.created}, cleaned ${counts.cleaned}.</p>
<h2>Recent runs</h2>
${runs.length === 0 ? html`<p class="muted">No runs yet.</p>` : html`<table><thead><tr><th>run</th><th>scenario</th><th>seed</th><th>started</th><th>took</th><th>verdict</th><th>exchanges</th><th>cleaned</th></tr></thead><tbody>${recent}</tbody></table>`}
<h2>Catalogue (${catalogue.length} scenarios, ${runnable.length} run here)</h2>
<table class="catalogue"><thead><tr><th>scenario</th><th>what it probes</th><th>here</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function failureView(f: Failure): Html {
  const d = f.difference;
  const step = f.step === null ? null : html`<div>step ${f.step.index}: ply concluded <b>${f.step.outcome}</b> (${String(f.step.error)})${f.step.expected === null ? null : html`, the scenario states <b>${f.step.expected.outcome}</b> (${String(f.step.expected.error)})`}</div>`;
  const text = f.tag === 'expected_incompatibility' ? f.reason : f.why;
  const evidence = f.evidence.map(e => html`<li><a href="#x${e.exchange}">exchange #${e.exchange}</a> <span class="mono">${e.cfRay}</span>: ${e.says}</li>`);
  return html`<div class="failure f-${f.tag}"><div class="tag">${f.tag}</div><div class="mono">${d.pair} · ${d.field}</div><div class="diff"><div><span class="muted">observed</span> <span class="mono">${d.left}</span></div><div><span class="muted">stated</span> <span class="mono">${d.right}</span></div></div>${step}<p>${text}</p>${f.evidence.length === 0 ? null : html`<ul>${evidence}</ul>`}</div>`;
}
function verdictView(v: RunVerdict): Html {
  switch (v.tag) {
    case 'pass': return html`<div class="verdict v-pass">pass: every one of ${v.compared} steps, the end refs and every landed claim meet the stated expectation</div>`;
    case 'fail': return html`<div class="verdict v-fail">${v.failures.length} difference${v.failures.length === 1 ? '' : 's'} from the stated expectation</div>${v.failures.map(f => failureView(f))}`;
    case 'harness': return html`<div class="verdict v-harness">not observed (${v.stage}): ${v.message}</div>`;
  }
}

const kv = (rows: ReadonlyArray<readonly [string, Html | string | number]>): Html => html`<dl>${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
const headerList = (hs: ReadonlyArray<readonly [string, string]>): Html => (hs.length === 0 ? html`<span class="muted">none</span>` : html`<ul class="mono headers">${hs.map(([k, v]) => html`<li>${k}: ${v}</li>`)}</ul>`);
function wireView(w: Wire): Html {
  switch (w.tag) {
    case 'advertisement': {
      const a = w.advertisement;
      return kv([['protocol', `${a.version}${a.service === null ? '' : ` (${a.service})`}`], ['advertised refs', a.refs.length === 0 ? 'none' : html`<ul class="mono">${a.refs.map(r => html`<li>${r.oid} ${r.ref}</li>`)}</ul>`], ['capabilities', html`<span class="mono">${a.capabilities.join(' ')}</span>`]]);
    }
    case 'receive-pack': {
      const r = w.report;
      const report = r.tag === 'none' ? html`<span class="bad">no report-status</span>: ${r.why}` : html`<ul class="mono"><li>unpack ${r.unpack.tag === 'ok' ? 'ok' : `error ${r.unpack.reason}`}</li>${r.refs.map(s => html`<li>${s.tag === 'ok' ? `ok ${s.ref}` : `ng ${s.ref} ${s.reason}`}</li>`)}</ul>`;
      const band = r.sideband === null ? 'not banded' : `band 1 ${r.sideband.bands.data} B, band 2 ${r.sideband.bands.progress} B, band 3 ${r.sideband.bands.error} B${r.sideband.error.length > 0 ? `: ${r.sideband.error}` : ''}`;
      return kv([['commands', html`<ul class="mono">${w.request.commands.map(c => html`<li>${c.old} ${c.new} ${c.ref}</li>`)}</ul>`], ['capabilities', html`<span class="mono">${w.request.capabilities.join(' ')}</span>`], ['pack', kb(w.request.packBytes)], ['report-status', report], ['side-band', band]]);
    }
    case 'ls-refs':
      return kv([['arguments', html`<span class="mono">${w.request.args.join(' ')}</span>`], ['refs', w.refs.length === 0 ? 'none' : html`<ul class="mono">${w.refs.map(r => html`<li>${r.oid} ${r.ref}</li>`)}</ul>`]]);
    case 'fetch': {
      const sb = w.answer.sideband;
      return kv([['arguments', html`<ul class="mono">${w.request.args.map(a => html`<li>${a}</li>`)}</ul>`], ['sections', w.answer.sections.join(', ')], ['side-band', sb === null ? 'none' : `band 1 ${kb(sb.bands.data)}, band 2 ${sb.bands.progress} B, band 3 ${sb.bands.error} B${sb.error.length > 0 ? `: ${sb.error}` : ''}`]]);
    }
    case 'opaque': return html`<span class="muted">no git payload read</span>`;
  }
}
function exchangeView(run: StoredRun, x: Exchange): Html {
  const timing = `start ${x.startMs} ms · headers ${x.headersMs === null ? '—' : `${x.headersMs} ms (+${x.headersMs - x.startMs})`} · end ${x.endMs} ms (${x.endMs - x.startMs} ms)`;
  const bodies = html`${x.requestBytes > 0 ? html`<a href="/bench/runs/${run.id}/exchanges/${x.i}/request">request body</a> ` : null}${x.responseBytes > 0 ? html`<a href="/bench/runs/${run.id}/exchanges/${x.i}/response">response body</a>` : null}`;
  return html`<details id="x${x.i}" class="exchange ch-${x.channel}"><summary><span class="mono">#${x.i}</span> ${phaseName(x.phase)} · ${x.channel} · ${shortKind(x)} · ${answerText(x)} · ↑${kb(x.requestBytes)} ↓${kb(x.responseBytes)} · ${x.endMs - x.startMs} ms · <span class="mono">${renderRay(x.cfRay)}</span>${x.applied === null ? null : html` · <span class="fault">fault ${x.applied.tag}</span>`}</summary>
${kv([['request', html`<span class="mono">${x.method} ${x.path}</span>`], ['answer', x.answer.tag === 'http' ? String(x.answer.status) : html`<span class="bad">no answer</span>: ${x.answer.error}`], ['cf-ray', html`<span class="mono">${renderRay(x.cfRay)}</span>`], ['timing', timing], ['fault', x.applied === null ? 'none' : html`<span class="mono">${JSON.stringify(x.applied)}</span>`], ['request headers', headerList(x.requestHeaders)], ['response headers', headerList(x.responseHeaders)], ['bodies', bodies]])}
${wireView(x.wire)}</details>`;
}
function spansView(spans: readonly SpanRow[]): Html {
  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs);
  const fill = (s: SpanRow): number => { let d = 0; let p = s.parent; while (p !== null && d < 12) { const up = spans.find(x => x.id === p); if (typeof up !== 'object') break; d++; p = up.parent; } return d; };
  return html`<table class="spans"><thead><tr><th>span</th><th>start</th><th>duration</th><th>status</th><th>attributes</th></tr></thead><tbody>${ordered.map(s => html`<tr><td class="mono d${Math.min(8, fill(s))}">${s.name}</td><td>${s.startMs} ms</td><td>${Math.round(s.durationMs)} ms</td><td>${s.ok ? 'ok' : html`<span class="bad">error</span>`}</td><td class="mono attrs">${Object.entries(s.attrs).filter(([k]) => k.startsWith('bench.') || k.startsWith('probe.') || k === 'cf.ray' || k === 'http.response.status_code' || k.startsWith('git.push') || k === 'error.type').map(([k, v]) => `${k}=${String(v)}`).join(' ')}</td></tr>`)}</tbody></table>`;
}

export function runPage(run: StoredRun, scenario: Scenario | null): Html {
  const r = run.result;
  const c = r.cleanup;
  const slug = replaySlug({ scenario: scenario === null ? ({ id: run.scenario } as Scenario) : scenario, run: run.id });
  const steps = r.steps.map((o, i) => {
    const st = scenario === null ? null : scenario.steps[i];
    const e = scenario === null ? null : scenario.expect[i];
    const stated = typeof e === 'object' && e !== null ? (e.tag === 'one' ? `${e.ply.outcome} (${String(e.ply.error)})` : e.ply.join(', ')) : '';
    const kind = typeof st === 'object' && st !== null ? (st.tag === 'push' || st.tag === 'fetch' ? `${st.tag}${st.fault.tag === 'none' ? '' : ` + ${st.fault.tag}`}` : st.tag) : '';
    return html`<tr><td>${i}</td><td>${kind}</td><td>${o.outcomes.map(x => html`<div><b>${x.outcome}</b> (${String(x.error)}) <span class="note">${x.detail}</span></div>`)}</td><td>${stated}</td></tr>`;
  });
  const end = r.end === null ? html`<p class="muted">not read</p>` : kv([['HEAD', r.end.head === null ? '(none)' : r.end.head], ['refs', Object.keys(r.end.refs).length === 0 ? 'none' : html`<ul class="mono">${Object.entries(r.end.refs).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => html`<li>${k} = ${v}${Object.hasOwn(r.names, v) ? ` (${String(r.names[v])})` : ''}</li>`)}</ul>`], ['objects', String(r.end.objects.length)], ['not compared', 'fsck and merge bases (no git in a Worker)']]);
  return layout(`${run.scenario} · run ${run.id}`, html`
<h1 class="mono">${run.scenario}</h1>
${scenario === null ? html`<p class="bad">This scenario is not in the catalogue of the running ply.</p>` : html`<p>${scenario.description}</p>`}
${kv([['run', html`<span class="mono">${run.id}</span>`], ['seed', run.seed], ['repository', html`<span class="mono">${run.repo}</span> (probe namespace; deleted)`], ['ply', html`<span class="mono">${run.ply}</span>`], ['started', iso(run.startedAt)], ['took', `${run.finishedAt - run.startedAt} ms, ${r.exchanges.length} exchanges`]])}
<h2>Verdict</h2>
${verdictView(r.verdict)}
<h2>Steps</h2>
<table><thead><tr><th>#</th><th>step</th><th>ply concluded</th><th>stated</th></tr></thead><tbody>${steps}</tbody></table>
<h2>End state, read back by ply</h2>
${end}
<h2>Protocol waterfall</h2>
<p class="note">One row per exchange from the start of the run: light is the wait for the server's headers, dark the answer's body. Blue is ply under test (main), amber the other writer and the seed (side), grey the read-back and cleanup (judge). Each row links to its exchange below.</p>
<div class="wf-wrap">${waterfall(r.exchanges)}</div>
<h2>Exchanges</h2>
${r.exchanges.map(x => exchangeView(run, x))}
<h2>Cleanup</h2>
${kv([['tokens listed', String(c.tokensListed)], ['tokens revoked', String(c.tokensRevoked)], ['revoked token tried', html`${c.revokedStatus === null ? 'no answer' : String(c.revokedStatus)} <span class="mono">${c.revokedRay}</span> ${c.refused ? html`<span class="ok">refused</span>` : html`<span class="bad">not refused</span>`}`], ['repository deleted', c.deleted ? 'yes' : html`<span class="bad">no</span>`], ['repository gone', c.gone ? 'yes' : html`<span class="bad">no</span>`], ['errors', c.errors.length === 0 ? 'none' : c.errors.join('; ')]])}
<h2>Export</h2>
<p>A replay for ply's probe suite: <a href="/bench/runs/${run.id}/${slug}.json">${slug}.json</a> and <a href="/bench/runs/${run.id}/${slug}.test.js">${slug}.test.js</a>. Put both in <span class="mono">test/probes/replay/</span> of a ply checkout; the test runs the plan against git http-backend (the reference) and checks the recorded run against the expectation with that commit's evaluator.</p>
<h2>Spans</h2>
${spansView(run.spans)}`);
}

export function messagePage(title: string, text: string): Html {
  return layout(title, html`<h1>${title}</h1><p>${text}</p><p><a href="/bench">Back to the workbench</a></p>`);
}

export const BENCH_CSS = `
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fff;--muted:#6b7280;--line:#e5e7eb;--main:#2563eb;--side:#d97706;--judge:#6b7280;--bad:#b91c1c;--ok:#047857}
@media (prefers-color-scheme:dark){:root{--fg:#e5e7eb;--bg:#111318;--muted:#9ca3af;--line:#2b2f36}}
body{margin:0;font:14px/1.45 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:1180px;margin:0 auto;padding:12px 20px 60px}
.top{display:flex;gap:16px;align-items:baseline;padding:10px 20px;border-bottom:1px solid var(--line)}
.top a{font-weight:600;color:inherit;text-decoration:none}.roles{color:var(--muted);font-size:12px}
h1{font-size:20px;margin:18px 0 6px}h2{font-size:16px;margin:26px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.muted,.note{color:var(--muted)}.note{font-size:12px}.bad{color:var(--bad)}.ok{color:var(--ok)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:4px 8px;border-bottom:1px solid var(--line)}
dl{display:grid;grid-template-columns:160px 1fr;gap:2px 12px;margin:6px 0}dt{color:var(--muted)}dd{margin:0}
dd ul{margin:0;padding-left:16px}
form.run{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px;border:1px solid var(--line);border-radius:6px}
select{max-width:420px}
.notice{padding:8px;border-left:3px solid var(--side)}
.verdict{padding:8px 10px;border-radius:6px;font-weight:600}.v-pass{background:#ecfdf5;color:#065f46}.v-fail{background:#fef2f2;color:#991b1b}.v-harness{background:#fffbeb;color:#92400e}
.failure{border:1px solid var(--line);border-left-width:4px;border-radius:6px;padding:8px 10px;margin:8px 0}
.failure .tag{font-weight:700;font-family:ui-monospace,monospace}
.f-client_bug{border-left-color:var(--main)}.f-server_bug{border-left-color:var(--bad)}.f-expected_incompatibility{border-left-color:var(--ok)}.f-unresolved{border-left-color:var(--side)}
.diff{margin:4px 0}
.exchange{border:1px solid var(--line);border-left-width:4px;border-radius:4px;margin:4px 0;padding:2px 8px}
.exchange summary{cursor:pointer;font-size:13px}.ch-main{border-left-color:var(--main)}.ch-side{border-left-color:var(--side)}.ch-judge{border-left-color:var(--judge)}
.fault{color:var(--bad);font-weight:600}
.headers{margin:0;padding-left:16px}
.wf-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:6px}
.waterfall text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;fill:var(--fg)}
.waterfall .wf-tick{stroke:var(--line)}.waterfall .wf-tick-label{fill:var(--muted)}
.waterfall .wf-phase{stroke:var(--muted);stroke-dasharray:3 3}.waterfall .wf-phase-label{fill:var(--muted);font-style:italic}
.waterfall .wf-wait{opacity:.35}.waterfall .wf-main{fill:var(--main)}.waterfall .wf-side{fill:var(--side)}.waterfall .wf-judge{fill:var(--judge)}
.waterfall .wf-failed rect{fill:var(--bad)}.waterfall .wf-fault{fill:var(--bad);font-weight:700}.waterfall .wf-ms{fill:var(--muted)}
.waterfall a:hover text.wf-label{text-decoration:underline}
.spans td{padding:2px 8px}.attrs{color:var(--muted);word-break:break-all}
${Array.from({ length: 9 }, (_, i) => `.d${i}{padding-left:${8 + i * 14}px}`).join('')}
`;
