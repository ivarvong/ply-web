// Kumo ships tokens as light-dark() inside @layer theme, then an unlayered
// :root rule pins the light values. Dark values live on [data-mode=dark],
// which needs a script. We copy those custom properties into
// @media (prefers-color-scheme: dark) so the same tokens follow the OS
// with no client JS and no inline style attributes.
import { KUMO_STANDALONE_CSS } from './kumo-standalone.ts'
import { LAYOUT, RADIUS, SPACE } from './layout.ts'

const DARK_MARKER = ':root[data-mode=dark]'
const MIN_DARK_TOKENS = 10

export function colorSchemeBridge(standalone: string): string {
  const markerAt = standalone.indexOf(DARK_MARKER)
  if (markerAt < 0) throw new Error('Kumo stylesheet has no [data-mode=dark] token block')
  const open = standalone.indexOf('{', markerAt)
  const close = standalone.indexOf('}', open)
  if (open < 0 || close < 0) throw new Error('Kumo dark token block is not closed')
  const decls = standalone.slice(open + 1, close).split(';').map(part => part.trim()).filter(part => part.startsWith('--'))
  if (decls.length < MIN_DARK_TOKENS) throw new Error('Kumo dark token block was not recognised')
  return `@media (prefers-color-scheme: dark){:root{${decls.join(';')};}}`
}

function percentRules(): string {
  let css = ''
  for (let step = 0; step <= LAYOUT.percentSteps; step++) css += `.o${step}{left:${step}%}.w${step}{width:${step}%}\n`
  return css
}

const chevron = (stroke: string): string =>
  `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path fill='none' stroke='${stroke}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' d='M2.5 4.5 6 8l3.5-3.5'/></svg>")`

function layoutCss(): string {
  const L = LAYOUT
  const S = SPACE
  const R = RADIUS
  return `
:root { color-scheme: light dark; --viewer-page-max: ${L.pageMaxRem}rem; --viewer-pad: ${L.phonePadPx}px; --viewer-header: ${L.headerPx}px; }
@media (min-width: ${L.desktopMinPx}px) { :root { --viewer-pad: ${L.desktopPadPx}px; } }
*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh;
  font-family: var(--font-sans);
  font-size: ${L.bodyFontPx}px;
  line-height: 1.5;
  background: var(--color-kumo-canvas);
  color: var(--text-color-kumo-default);
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
:focus-visible { outline: 2px solid var(--color-kumo-focus); outline-offset: 2px; }
button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--color-kumo-focus); outline-offset: 2px; }
a { color: var(--text-color-kumo-link); text-underline-offset: 0.15em; }
.site-header {
  position: sticky; top: 0; z-index: 20;
  height: var(--viewer-header);
  background: color-mix(in oklch, var(--color-kumo-base) 92%, transparent);
  border-bottom: 1px solid var(--color-kumo-line);
  backdrop-filter: saturate(1.2) blur(10px);
}
.site-header-inner, .page {
  width: min(100%, var(--viewer-page-max));
  margin-inline: auto;
  padding-inline: var(--viewer-pad);
}
.site-header-inner { height: 100%; display: flex; align-items: center; justify-content: space-between; gap: ${S.md}; }
.brand {
  display: inline-flex; align-items: center; gap: ${S.sm};
  color: var(--text-color-kumo-strong); text-decoration: none;
  font-weight: 600; letter-spacing: -0.03em; font-size: 15px;
}
.brand:hover { text-decoration: none; color: var(--text-color-kumo-strong); }
.mark {
  width: ${L.markPx}px; height: ${L.markPx}px; border-radius: ${L.markRadiusPx}px;
  background: var(--text-color-kumo-brand); flex: none;
}
.brand-sub { color: var(--text-color-kumo-subtle); font-size: ${L.metaFontPx}px; letter-spacing: 0.01em; }
.page { padding-top: ${S.xl}; padding-bottom: ${S.xxl}; min-width: 0; }
.display {
  margin: 0; color: var(--text-color-kumo-strong);
  font-size: ${L.displayPhoneRem}rem; font-weight: 600; letter-spacing: -0.028em; line-height: 1.15;
}
.lede { margin: ${S.sm} 0 0; max-width: 42rem; color: var(--text-color-kumo-subtle); font-size: 15px; line-height: 1.5; }
.stack-form { display: flex; flex-direction: column; gap: ${S.sm}; margin-top: ${S.lg}; }
.stack-form .control { flex: 1; }
.switchers { display: flex; flex-direction: column; gap: ${S.sm}; min-width: 0; }
.switch-form { display: flex; align-items: center; gap: ${S.sm}; min-width: 0; }
.btn { flex: none; }
.is-primary:hover { opacity: ${L.primaryHoverOpacity}; }
.banner { margin: ${S.md} 0 0; }
.switch-label { display: flex; align-items: center; gap: ${S.sm}; min-width: 0; flex: 1; color: var(--text-color-kumo-subtle); font-size: ${L.metaFontPx}px; }
.switch-label span { flex: none; }
.select-wrap { position: relative; flex: 1; min-width: 0; }
.control {
  width: 100%; min-width: 0;
  font-family: var(--font-sans);
  font-size: ${L.inputFontPx}px;
  color: var(--text-color-kumo-default);
  background-color: var(--color-kumo-control);
}
.viewer-select {
  appearance: none;
  padding-right: 2rem;
  background-image: ${chevron('%23737373')};
  background-repeat: no-repeat;
  background-position: right 0.7rem center;
  background-size: ${L.selectChevronPx}px;
}
.repo-head { display: flex; flex-direction: column; gap: ${S.md}; min-width: 0; }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 0.15rem 0; margin: 0 0 ${S.sm}; min-width: 0; font-size: 13px; }
.crumbs a, .crumbs .here { color: var(--text-color-kumo-subtle); text-decoration: none; overflow-wrap: anywhere; }
.crumbs a:hover { color: var(--text-color-kumo-link); text-decoration: underline; }
.crumbs .sep { color: var(--text-color-kumo-inactive); margin: 0 0.28rem; }
.crumbs .here { color: var(--text-color-kumo-default); font-weight: 600; }
h1.repo {
  margin: 0; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.025em; line-height: 1.2;
  color: var(--text-color-kumo-strong); overflow-wrap: anywhere;
}
.meta-row { display: flex; flex-wrap: wrap; align-items: center; gap: ${S.sm}; margin: ${S.md} 0; min-width: 0; }
.meta-row .agent {
  font-family: var(--font-mono); font-size: ${L.metaFontPx}px; color: var(--text-color-kumo-subtle);
  overflow-wrap: anywhere; min-width: 0;
}
.proto { position: relative; }
summary { list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
.proto > summary {
  display: inline-flex; align-items: center; gap: 0.3rem;
  border: 1px solid var(--color-kumo-line); background: var(--color-kumo-base);
  color: var(--text-color-kumo-default); border-radius: ${R.pill};
  padding: 0.15rem 0.6rem; font-size: ${L.metaFontPx}px; font-weight: 600;
}
.proto-panel {
  margin-top: ${S.sm}; padding: ${S.md} ${S.lg};
  background: var(--color-kumo-base); border: 1px solid var(--color-kumo-line);
  border-radius: ${R.lg}; box-shadow: 0 8px 24px var(--color-kumo-shadow-drop);
}
.proto-panel dl { margin: 0; display: grid; gap: ${S.sm}; }
.proto-panel div { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: ${S.sm}; align-items: baseline; }
.proto-panel dt { color: var(--text-color-kumo-subtle); font-size: ${L.metaFontPx}px; }
.proto-panel dd { margin: 0; overflow-wrap: anywhere; font-size: 13px; }
.mono { font-family: var(--font-mono); font-size: 12px; }
.subject {
  margin: 0; font-size: ${L.subjectPx}px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.35;
  color: var(--text-color-kumo-strong); overflow-wrap: anywhere;
}
.prose p { margin: ${S.sm} 0 0; max-width: ${L.proseCh}ch; line-height: 1.55; overflow-wrap: anywhere; }
.commit-bar { padding: ${S.md} ${S.lg}; border-bottom: 1px solid var(--color-kumo-line); display: grid; gap: 0.35rem; }
.commit-by { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.6rem; color: var(--text-color-kumo-subtle); font-size: 13px; min-width: 0; }
.commit-by a { text-decoration: none; }
.commit-by a:hover { text-decoration: underline; }
.when { color: inherit; text-decoration: none; border-bottom: 1px dotted color-mix(in oklch, var(--text-color-kumo-subtle) 70%, transparent); cursor: help; }
.files { width: 100%; border-collapse: collapse; }
.files th, .files td { text-align: left; padding: 0.45rem 0.85rem; border-top: 1px solid var(--color-kumo-line); vertical-align: middle; }
.files th { font-size: ${L.metaFontPx}px; font-weight: 600; color: var(--text-color-kumo-subtle); }
.files tbody tr:hover td { background: var(--color-kumo-tint); }
.files tr.on td, .files tr:target td { background: var(--color-kumo-warning-tint); }
.files td.name a {
  display: flex; align-items: center; gap: 0.45rem; min-width: 0;
  color: var(--text-color-kumo-default); font-weight: 500; text-decoration: none; overflow-wrap: anywhere;
}
.files td.name a:hover { color: var(--text-color-kumo-link); }
.files td.oid, .files th.oid { text-align: right; width: 5.5rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
.files td.oid { font-family: var(--font-mono); font-size: 12px; color: var(--text-color-kumo-subtle); }
.ico { width: 1rem; height: 1rem; flex: none; color: var(--text-color-kumo-subtle); }
.section-label {
  margin: ${S.xl} 0 ${S.sm}; font-size: ${L.metaFontPx}px; font-weight: 600;
  letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-color-kumo-subtle);
}
.log { list-style: none; margin: 0; padding: 0; }
.log li { display: flex; gap: ${S.sm}; align-items: baseline; padding: 0.4rem 0; border-top: 1px solid var(--color-kumo-line); min-width: 0; }
.log li a.sha { font-family: var(--font-mono); font-size: 12px; text-decoration: none; flex: none; }
.log li span.msg { overflow-wrap: anywhere; min-width: 0; flex: 1; }
.log .when { margin-left: auto; flex: none; white-space: nowrap; }
.pad { padding: ${S.md} ${S.lg}; }
.chips { display: flex; flex-wrap: wrap; gap: ${S.sm}; margin-top: ${S.md}; }
.chip {
  display: inline-flex; align-items: center; text-decoration: none;
  border: 1px solid var(--color-kumo-line); background: var(--color-kumo-base);
  color: var(--text-color-kumo-default); border-radius: ${R.pill};
  padding: 0.3rem 0.7rem; font-size: 13px; font-weight: 500;
}
.chip:hover { background: var(--color-kumo-tint); text-decoration: none; color: var(--text-color-kumo-default); }
.card-grid { display: grid; gap: ${S.md}; margin-top: ${S.xl}; }
.card-grid h2 { margin: 0 0 ${S.sm}; font-size: 14px; font-weight: 600; color: var(--text-color-kumo-strong); }
.host-list { display: flex; flex-wrap: wrap; gap: ${S.sm}; list-style: none; margin: 0; padding: 0; }
.host-list li { font-family: var(--font-mono); font-size: 12px; background: var(--color-kumo-recessed); border-radius: ${R.pill}; padding: 0.15rem 0.55rem; }
.limits { margin: 0; display: grid; gap: 0.35rem; }
.limits div { display: flex; justify-content: space-between; gap: ${S.md}; font-size: 13px; }
.limits dt { color: var(--text-color-kumo-subtle); }
.limits dd { margin: 0; font-variant-numeric: tabular-nums; text-align: right; }
.note { color: var(--text-color-kumo-subtle); font-size: 13px; margin: ${S.sm} 0 0; }
.filebar { display: flex; flex-wrap: wrap; gap: ${S.sm} ${S.md}; align-items: center; justify-content: space-between; margin: ${S.md} 0; min-width: 0; }
.filebar p { margin: 0; color: var(--text-color-kumo-subtle); font-size: 13px; overflow-wrap: anywhere; }
.code {
  overflow: auto; max-width: 100%;
  background: var(--color-kumo-recessed);
  border-radius: ${R.md};
  font-family: var(--font-mono);
  font-size: ${L.codeFontPx}px;
  line-height: 1.55;
}
.line { display: flex; min-width: max-content; }
.line:target { background: var(--color-kumo-warning-tint); scroll-margin-top: calc(var(--viewer-header) + ${L.targetGapPx}px); }
.ln {
  position: sticky; left: 0;
  width: ${L.lineGutterRem}rem; flex: none;
  color: var(--text-color-kumo-subtle); text-align: right;
  padding: 0 0.7rem 0 0.2rem; user-select: none; text-decoration: none;
  font-variant-numeric: tabular-nums;
  background: var(--color-kumo-recessed);
}
.line:target .ln { background: var(--color-kumo-warning-tint); }
.src { white-space: pre; padding-right: 0.85rem; }
.md { padding: ${S.lg}; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.md p { margin: 0.45rem 0; }
.md h3, .md h4, .md h5 { margin: 1rem 0 0.3rem; font-size: 15px; letter-spacing: -0.01em; }
.md pre { overflow: auto; padding: ${S.md}; background: var(--color-kumo-recessed); border-radius: ${R.sm}; }
.md code { font-family: var(--font-mono); font-size: 12.5px; }
.md :not(pre) > code { background: var(--color-kumo-recessed); padding: 0.05rem 0.3rem; border-radius: 4px; }
.md ul { padding-left: 1.15rem; margin: 0.4rem 0; }
.scroll-x { overflow-x: auto; max-width: 100%; }
.packbar {
  display: flex; height: ${L.packBarPx}px; width: 100%;
  border-radius: 6px; overflow: hidden; background: var(--color-kumo-fill);
}
.packbar a, .packbar span { display: block; height: 100%; flex: none; }
.packbar a.on, .packbar a:focus-visible { outline: 2px solid var(--color-kumo-focus); outline-offset: -2px; }
.legend { display: flex; flex-wrap: wrap; gap: 0.45rem 0.85rem; margin: ${S.sm} 0 ${S.md}; font-size: ${L.metaFontPx}px; color: var(--text-color-kumo-subtle); }
.sw { display: inline-block; width: ${L.swatchPx}px; height: ${L.swatchPx}px; border-radius: 2px; margin-right: 0.35rem; vertical-align: -1px; }
.stats { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; margin: ${S.sm} 0; font-size: 13px; }
.stats strong { font-variant-numeric: tabular-nums; font-weight: 600; }
.disclosure { margin-top: ${S.xl}; }
.disclosure > summary { display: flex; align-items: center; justify-content: space-between; gap: ${S.sm}; }
.trace-row {
  display: grid; grid-template-columns: minmax(8rem, ${L.traceNameRem}rem) minmax(0, 1fr);
  gap: 0.2rem ${S.md}; align-items: center; padding: 0.5rem 0;
  border-top: 1px solid var(--color-kumo-line);
}
.trace-name { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
.trace-meta { color: var(--text-color-kumo-subtle); font-size: ${L.metaFontPx}px; overflow-wrap: anywhere; }
.track { position: relative; height: 8px; border-radius: ${R.pill}; background: var(--color-kumo-fill); }
.bar { position: absolute; top: 0; bottom: 0; border-radius: inherit; min-width: 2px; }
.c-err { background: var(--color-kumo-danger); }
.c-hit { background: var(--color-kumo-success); }
.c-discover, .c-refs { background: var(--color-kumo-info); }
.c-fetch { background: var(--color-kumo-brand); }
.c-fallback { background: var(--color-kumo-warning); }
.detail { margin: 0.35rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-color-kumo-subtle); font-family: var(--font-mono); font-size: 11px; }
.err .trace-name { color: var(--text-color-kumo-danger); font-weight: 650; }
.site-footer { margin-top: ${S.xxl}; color: var(--text-color-kumo-subtle); font-size: ${L.metaFontPx}px; }
.site-footer summary { cursor: pointer; }
.error-wrap { width: min(100%, ${L.errorMaxRem}rem); }
.error-kicker { margin: 0; font-family: var(--font-mono); font-size: ${L.metaFontPx}px; color: var(--text-color-kumo-subtle); letter-spacing: 0.04em; }
.steps { display: grid; gap: ${S.md}; margin-top: ${S.xl}; }
.step { min-width: 0; }
.step strong { display: block; font-size: 13px; font-weight: 600; color: var(--text-color-kumo-strong); margin-bottom: 0.15rem; }
.step span { color: var(--text-color-kumo-subtle); font-size: 13px; }
@media (min-width: ${L.stackMinPx}px) {
  .stack-form { flex-direction: row; align-items: center; }
  .stack-form .btn { width: auto; }
  .card-grid, .steps { grid-template-columns: 1fr 1fr; }
  .steps { grid-template-columns: 1fr 1fr 1fr; }
}
@media (min-width: ${L.desktopMinPx}px) {
  .display { font-size: ${L.displayDesktopRem}rem; }
  .repo-head { flex-direction: row; align-items: flex-start; justify-content: space-between; gap: ${S.xl}; }
  .switchers { flex-direction: row; justify-content: flex-end; flex: 1; max-width: 40rem; }
  .proto-panel { position: absolute; z-index: 5; left: 0; min-width: 22rem; }
  .card-grid { grid-template-columns: 1.1fr 0.9fr; }
}
@media (max-width: ${L.stackMinPx - 1}px) {
  .stack-form .btn { width: 100%; }
  .trace-row { grid-template-columns: 1fr; }
  .switch-form { flex-wrap: wrap; }
  .switch-label { flex-basis: 100%; }
  .switch-form .btn { width: 100%; }
  h1.repo { font-size: 1.2rem; }
  .page { padding-top: ${S.lg}; }
}
@media (prefers-color-scheme: dark) {
  .viewer-select { background-image: ${chevron('%23a3a3a3')}; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
${percentRules()}
`
}

export const VIEWER_CSS = `${KUMO_STANDALONE_CSS}\n${colorSchemeBridge(KUMO_STANDALONE_CSS)}\n${layoutCss()}`
