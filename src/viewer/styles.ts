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
.page { padding-top: ${S.lg}; padding-bottom: ${S.xxl}; min-width: 0; }
.display {
  margin: 0; color: var(--text-color-kumo-strong);
  font-size: ${L.displayPhoneRem}rem; font-weight: 600; letter-spacing: -0.028em; line-height: 1.15;
}
.lede { margin: ${S.sm} 0 0; max-width: 42rem; color: var(--text-color-kumo-subtle); font-size: 15px; line-height: 1.5; }
.stack-form { display: flex; flex-direction: column; gap: ${S.sm}; margin-top: ${S.lg}; }
.stack-form .control { flex: 1; }
.stack-form .control, .stack-form .btn { height: ${L.controlPx}px; font-size: ${L.inputFontPx}px; }
.btn { flex: none; }
.is-primary:hover { opacity: ${L.primaryHoverOpacity}; }
.banner { margin: ${S.md} 0 0; }
.control {
  width: 100%; min-width: 0;
  font-family: var(--font-sans);
  font-size: ${L.inputFontPx}px;
  color: var(--text-color-kumo-default);
  background-color: var(--color-kumo-control);
}
.toolbar { display: flex; align-items: center; gap: ${S.sm}; min-width: 0; margin-bottom: ${S.lg}; }
.refbox { position: relative; flex: none; max-width: 100%; }
.ref-summary {
  display: inline-flex; align-items: center; gap: ${S.xs};
  height: ${L.compactControlPx}px; padding: 0 ${S.sm};
  border: 1px solid var(--color-kumo-line); border-radius: ${R.sm};
  background: var(--color-kumo-control); color: var(--text-color-kumo-default);
  font-size: ${L.metaFontPx}px;
}
.ref-k { color: var(--text-color-kumo-subtle); }
.ref-v { font-weight: 600; max-width: ${L.refSummaryRem}rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seg {
  display: none; align-items: stretch; width: max-content;
  height: ${L.compactControlPx}px;
  border: 1px solid var(--color-kumo-line); border-radius: ${R.sm};
  background: var(--color-kumo-control); overflow: hidden;
}
.seg:focus-within { box-shadow: 0 0 0 ${L.focusRingPx}px var(--color-kumo-focus); }
.seg .seg-field, .seg .seg-go {
  height: ${L.compactControlPx}px; min-width: 0;
  border: 0; border-radius: 0; box-shadow: none; background-color: transparent;
  font-family: var(--font-sans); font-size: ${L.compactFontPx}px;
  color: var(--text-color-kumo-default);
}
.seg .seg-field { padding: 0 ${S.sm}; }
.seg .viewer-select {
  width: ${L.segSelectRem}rem; flex: none; appearance: none;
  padding-right: ${S.lg};
  border-right: 1px solid var(--color-kumo-line);
  background-image: ${chevron('%23737373')};
  background-repeat: no-repeat; background-position: right ${S.sm} center; background-size: ${L.selectChevronPx}px;
}
.seg input.seg-field { width: ${L.segInputRem}rem; flex: 1 1 ${L.segInputRem}rem; }
.seg .seg-go {
  flex: none; padding: 0 ${S.md}; cursor: pointer; font-weight: 600;
  border-left: 1px solid var(--color-kumo-line); color: var(--text-color-kumo-strong);
}
.seg .seg-go:hover { background: var(--color-kumo-tint); }
.crumbs { display: flex; flex-wrap: nowrap; align-items: center; gap: 0; margin: 0; min-width: 0; flex: 1; overflow: hidden; font-size: ${L.metaFontPx}px; }
.crumbs a, .crumbs .here { color: var(--text-color-kumo-subtle); text-decoration: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumbs a:hover { color: var(--text-color-kumo-link); text-decoration: underline; }
.crumbs .sep { color: var(--text-color-kumo-inactive); margin: 0 ${S.xs}; flex: none; }
.crumbs .here { color: var(--text-color-kumo-default); font-weight: 600; }
h1.repo {
  margin: 0 0 ${S.md}; font-size: ${L.repoTitleRem}rem; font-weight: 600; letter-spacing: -0.025em; line-height: 1.25;
  color: var(--text-color-kumo-strong); overflow-wrap: anywhere;
}
summary { list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
details:not([open]) > :not(summary) { display: none; }
.quiet { margin: 0 0 ${S.md}; min-width: 0; }
.quiet > summary {
  display: flex; flex-wrap: nowrap; align-items: center; gap: ${S.sm}; min-width: 0;
  color: var(--text-color-kumo-subtle); font-size: ${L.metaFontPx}px; font-weight: 500;
}
.quiet > summary::before {
  content: ""; flex: none; width: 0.3rem; height: 0.3rem;
  border-right: ${L.focusRingPx}px solid currentColor; border-bottom: ${L.focusRingPx}px solid currentColor;
  transform: translateY(-1px) rotate(-45deg);
}
.quiet[open] > summary::before { transform: translateY(1px) rotate(45deg); }
.quiet-k { color: var(--text-color-kumo-default); font-weight: 600; flex: none; }
.quiet-rest { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proto-dl { margin: ${S.sm} 0 0; display: grid; gap: ${S.sm}; max-width: 100%; }
.proto-dl div { display: grid; grid-template-columns: ${L.protoLabelRem}rem minmax(0, 1fr); gap: ${S.sm}; align-items: baseline; }
.proto-dl dt, .proto-dl dd { min-width: 0; }
.proto-dl dt { color: var(--text-color-kumo-subtle); font-size: ${L.metaFontPx}px; }
.proto-dl dd { margin: 0; overflow-wrap: anywhere; font-size: ${L.metaFontPx}px; }
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
.files tr.on td, .files tr:target td, .pack-row.on, .pack-row:target { background: var(--color-kumo-warning-tint); }
.pack-list { display: flex; flex-direction: column; }
.pack-row {
  display: grid;
  grid-template-columns: ${L.packOffsetRem}rem minmax(0, 1fr) auto;
  column-gap: ${S.md};
  align-items: baseline;
  padding: ${S.sm} ${S.lg};
  border-top: 1px solid var(--color-kumo-line);
}
.pack-row:hover { background: var(--color-kumo-tint); }
.pack-row .sub { grid-column: 1 / -1; color: var(--text-color-kumo-subtle); font-size: ${L.metaFontPx}px; }
.pack-row .oid { font-family: var(--font-mono); font-size: 12px; color: var(--text-color-kumo-subtle); text-align: right; }
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
.code-surface {
  border: 1px solid var(--color-kumo-line); border-radius: ${R.lg};
  background: var(--color-kumo-base); overflow: hidden;
}
.code-surface + .proto { margin-top: ${S.md}; }
.file-head {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "path raw" "meta meta";
  align-items: center; gap: ${S.xs} ${S.md}; min-width: 0;
  padding: ${S.sm} ${S.md};
  border-bottom: 1px solid var(--color-kumo-line);
  background: var(--color-kumo-base);
}
.file-path { grid-area: path; font-family: var(--font-mono); font-size: ${L.metaFontPx}px; font-weight: 600; color: var(--text-color-kumo-strong); min-width: 0; overflow-wrap: anywhere; }
.file-meta { grid-area: meta; display: flex; flex-wrap: wrap; align-items: baseline; gap: ${S.xs} ${S.sm}; color: var(--text-color-kumo-subtle); font-size: ${L.metaFontPx}px; }
.meta-k { font-weight: 500; margin-right: ${S.xs}; }
.meta-dot { color: var(--text-color-kumo-inactive); }
.raw-link {
  grid-area: raw; justify-self: end;
  display: inline-flex; align-items: center; height: ${L.compactControlPx}px; padding: 0 ${S.sm};
  border: 1px solid var(--color-kumo-line); border-radius: ${R.sm};
  background: var(--color-kumo-control); color: var(--text-color-kumo-default);
  text-decoration: none; font-weight: 600;
}
.raw-link:hover { background: var(--color-kumo-tint); text-decoration: none; color: var(--text-color-kumo-default); }
.file-note { padding: ${S.md}; }
.code {
  overflow: auto; max-width: 100%; margin: 0;
  background: var(--color-kumo-recessed); border-radius: 0;
  font-family: var(--font-mono); font-size: ${L.codeFontPx}px; line-height: 1.55;
}
.line { display: flex; min-width: max-content; }
.line:target { background: var(--color-kumo-warning-tint); scroll-margin-top: calc(var(--viewer-header) + ${L.targetGapPx}px); }
.ln {
  position: sticky; left: 0;
  width: ${L.lineGutterRem}rem; flex: none;
  border-right: 1px solid var(--color-kumo-line);
  color: var(--text-color-kumo-subtle); text-align: right;
  padding: 0 ${S.sm} 0 ${S.xs}; user-select: none; text-decoration: none;
  font-variant-numeric: tabular-nums;
  background: var(--color-kumo-recessed);
}
.ln:hover { color: var(--text-color-kumo-link); }
.line:target .ln { background: var(--color-kumo-warning-tint); }
.src { white-space: pre; padding-right: ${S.md}; }
.md { padding: ${S.lg}; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.md p { margin: 0.45rem 0; }
.md h3, .md h4, .md h5 { margin: 1rem 0 0.3rem; font-size: 15px; letter-spacing: -0.01em; }
.md pre { overflow: auto; padding: ${S.md}; background: var(--color-kumo-recessed); border-radius: ${R.sm}; }
.md code { font-family: var(--font-mono); font-size: 12.5px; }
.md :not(pre) > code { background: var(--color-kumo-recessed); padding: 0.05rem 0.3rem; border-radius: 4px; }
.md ul { padding-left: 1.15rem; margin: 0.4rem 0; }
.scroll-x { overflow-x: auto; max-width: 100%; }
.scroll-x .files { width: max-content; min-width: 100%; }
.scroll-x .files th, .scroll-x .files td { white-space: nowrap; }
main section + section { margin-top: ${S.lg}; }
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
.site-footer .quiet { margin: 0 0 ${S.sm}; }
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
.err .trace-name { color: var(--text-color-kumo-danger); font-weight: 600; }
.site-footer {
  margin-top: ${S.xl}; padding-top: ${S.md};
  border-top: 1px solid var(--color-kumo-line);
  color: var(--text-color-kumo-subtle); font-size: ${L.metaFontPx}px;
}
.foot-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: ${S.sm} ${S.lg}; }
.foot-row a { color: var(--text-color-kumo-subtle); text-decoration: none; font-weight: 600; }
.foot-row a:hover { color: var(--text-color-kumo-link); text-decoration: underline; }
.error-card { padding: ${S.xl}; }
.error-card .host-list { margin-top: ${S.md}; }
.error-kicker { margin: 0 0 ${S.sm}; font-family: var(--font-mono); font-size: ${L.metaFontPx}px; color: var(--text-color-kumo-subtle); letter-spacing: 0.04em; }
.reason { margin-top: ${S.lg}; }
.reason > summary { color: var(--text-color-kumo-subtle); font-size: ${L.metaFontPx}px; font-weight: 600; }
.reason p { margin: ${S.sm} 0 0; color: var(--text-color-kumo-subtle); font-size: ${L.metaFontPx}px; overflow-wrap: anywhere; }
.steps { display: grid; gap: ${S.md}; margin-top: ${S.xl}; }
.step { min-width: 0; }
.step strong { display: block; font-size: 13px; font-weight: 600; color: var(--text-color-kumo-strong); margin-bottom: 0.15rem; }
.step span { color: var(--text-color-kumo-subtle); font-size: 13px; }
@media (min-width: ${L.stackMinPx}px) {
  .stack-form { flex-direction: row; align-items: center; }
  .stack-form .btn { width: auto; }
  .card-grid, .steps { grid-template-columns: 1fr 1fr; }
  .steps { grid-template-columns: 1fr 1fr 1fr; }
  .ref-disclosure { display: none; }
  .refbox > .seg { display: flex; width: 100%; }
  .refbox { width: calc(${L.segSelectRem}rem + ${L.segInputRem}rem + ${L.segButtonRem}rem); height: ${L.compactControlPx}px; }
  .file-head { grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: "path meta raw"; }
}
@media (min-width: ${L.desktopMinPx}px) {
  .display { font-size: ${L.displayDesktopRem}rem; }
  .card-grid { grid-template-columns: 1.1fr 0.9fr; }
  .page {
    background: var(--color-kumo-base);
    box-shadow: 0 0 0 1px var(--color-kumo-line);
    min-height: calc(100vh - var(--viewer-header));
  }
}
@media (min-width: ${L.desktopMinPx}px) and (prefers-color-scheme: dark) {
  .page { background: var(--color-kumo-elevated); }
}
@media (max-width: ${L.stackMinPx - 1}px) {
  .stack-form .btn { width: 100%; }
  .trace-row { grid-template-columns: 1fr; }
  .refbox:has(.ref-disclosure[open]) > .seg {
    display: flex; position: absolute; z-index: 6; top: calc(100% + ${S.sm}); right: 0;
    width: min(${L.segPopoverRem}rem, calc(100vw - ${L.phonePadPx * 2}px));
    max-width: none;
    background: var(--color-kumo-base);
    box-shadow: 0 8px 24px var(--color-kumo-shadow-drop);
  }
}
@media (prefers-color-scheme: dark) {
  .seg .viewer-select { background-image: ${chevron('%23a3a3a3')}; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
${percentRules()}
`
}

export const VIEWER_CSS = `${KUMO_STANDALONE_CSS}\n${colorSchemeBridge(KUMO_STANDALONE_CSS)}\n${layoutCss()}`
