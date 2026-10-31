// /view.css = Kumo's theme, base and the Kumo utilities this viewer uses + a dark-mode bridge + the viewer layer.
//
// Kumo ships tokens as light-dark() inside @layer theme, then an unlayered :root rule pins the light values. Dark values
// live on [data-mode=dark], which needs a script. We copy those custom properties into @media (prefers-color-scheme:
// dark) so the same tokens follow the OS with no client JS and no inline style attributes.
//
// The standalone sheet is 142 KB, 113 KB of it utilities for every Kumo component. The viewer server-renders Kumo's
// component class strings from kumo-classes.ts, so only those utilities are kept (kumoSubset). The theme, base and
// keyframe layers are kept whole; the selection is per utility class, so nothing a used class needs is lost.
import * as KUMO from './kumo-classes.ts'
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

type CssNode = { prelude: string; body: string | null }

/** Split a stylesheet (or a block body) into top-level statements and rules. Strings and comments are skipped. */
export function cssNodes(css: string): CssNode[] {
  const out: CssNode[] = []
  let i = 0
  let start = 0
  while (i < css.length) {
    const ch = css[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '/' && css[i + 1] === '*') { const end = css.indexOf('*/', i + 2); i = end === -1 ? css.length : end + 2; continue }
    if (ch === '"' || ch === "'") { i++; while (i < css.length && css[i] !== ch) i += css[i] === '\\' ? 2 : 1; i++; continue }
    if (ch === ';') { const prelude = css.slice(start, i).trim(); if (prelude) out.push({ prelude, body: null }); start = ++i; continue }
    if (ch === '{') {
      let depth = 1
      let j = i + 1
      while (j < css.length && depth > 0) {
        const c = css[j]
        if (c === '\\') { j += 2; continue }
        if (c === '/' && css[j + 1] === '*') { const end = css.indexOf('*/', j + 2); j = end === -1 ? css.length : end + 2; continue }
        if (c === '"' || c === "'") { j++; while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1; j++; continue }
        if (c === '{') depth++
        else if (c === '}') depth--
        j++
      }
      out.push({ prelude: css.slice(start, i).trim(), body: css.slice(i + 1, j - 1) })
      start = i = j
      continue
    }
    i++
  }
  return out
}

/** Class names a selector mentions, unescaped (`.h-6\.5` → `h-6.5`). */
export function selectorClasses(selector: string): string[] {
  return [...selector.matchAll(/\.((?:\\.|[\w-])+)/g)].map(m => (m[1] ?? '').replace(/\\(.)/g, '$1'))
}

function serialise(nodes: readonly CssNode[]): string {
  return nodes.map(node => node.body === null ? `${node.prelude};` : `${node.prelude}{${node.body}}`).join('')
}

function keepUtilities(body: string, used: ReadonlySet<string>): string {
  const kept: CssNode[] = []
  for (const node of cssNodes(body)) {
    if (node.body === null) { kept.push(node); continue }
    if (node.prelude.startsWith('@')) {
      const inner = keepUtilities(node.body, used)
      if (inner) kept.push({ prelude: node.prelude, body: inner })
      continue
    }
    if (selectorClasses(node.prelude).some(name => used.has(name))) kept.push(node)
  }
  return serialise(kept)
}

/** The standalone sheet with only the utility rules whose class is in `used`. */
export function kumoSubset(standalone: string, used: ReadonlySet<string>): string {
  return serialise(cssNodes(standalone).map(node => (
    node.body !== null && node.prelude === '@layer utilities' ? { prelude: node.prelude, body: keepUtilities(node.body, used) } : node
  )))
}

/** Every class token in kumo-classes.ts: the Kumo utilities the pages can emit. */
export const KUMO_USED: ReadonlySet<string> = new Set(
  (Object.values(KUMO) as unknown[]).filter((value): value is string => typeof value === "string").flatMap(value => value.split(/\s+/)).filter(Boolean),
)

function percentRules(): string {
  let css = ''
  for (let step = 0; step <= LAYOUT.percentSteps; step++) css += `.o${step}{left:${step}%}.w${step}{width:${step}%}`
  return css
}

function layoutCss(): string {
  const L = LAYOUT
  const S = SPACE
  const R = RADIUS
  const phone = `@media (max-width: ${L.stackMinPx - 1}px)`
  const wide = `@media (min-width: ${L.stackMinPx}px)`
  return `
:root { color-scheme: light dark; --viewer-page-max: ${L.pageMaxRem}rem; --viewer-pad: ${L.phonePadPx}px; --viewer-header: ${L.headerPx}px; --row: 44px; }
@media (min-width: ${L.desktopMinPx}px) { :root { --viewer-pad: ${L.desktopPadPx}px; --row: 38px; } }
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-padding-top: calc(var(--viewer-header) + ${S.lg}); }
body {
  margin: 0; min-height: 100vh; font-family: var(--font-sans); font-size: var(--text-base); line-height: 1.5;
  background: var(--color-kumo-canvas); color: var(--text-color-kumo-default);
  text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; overflow-wrap: break-word;
}
:focus-visible { outline: 2px solid var(--color-kumo-focus); outline-offset: 2px; }
a { color: var(--text-color-kumo-link); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 0.15em; }
summary { list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
.sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
.i { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; color: var(--text-color-kumo-subtle); }
.i-sm { width: 12px; height: 12px; }
.i-dir { fill: currentColor; stroke: none; color: var(--text-color-kumo-info); opacity: 0.85; }
.mono, .sha, .oid { font-family: var(--font-mono); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }

/* frame */
.site-header {
  position: sticky; top: 0; z-index: 20; height: var(--viewer-header);
  background: color-mix(in oklch, var(--color-kumo-canvas) 85%, transparent);
  border-bottom: 1px solid var(--color-kumo-hairline);
  -webkit-backdrop-filter: saturate(1.4) blur(12px); backdrop-filter: saturate(1.4) blur(12px);
}
.site-header-inner, .page { width: min(100%, var(--viewer-page-max)); margin-inline: auto; padding-inline: max(var(--viewer-pad), env(safe-area-inset-left)); }
.site-header-inner { height: 100%; display: flex; align-items: center; justify-content: space-between; gap: ${S.md}; }
.brand { display: inline-flex; align-items: center; gap: ${S.sm}; color: var(--text-color-kumo-strong); font-weight: 600; letter-spacing: -0.02em; font-size: var(--text-lg); }
.brand:hover { text-decoration: none; }
.mark { width: 10px; height: 10px; border-radius: 3px; background: var(--text-color-kumo-brand); flex: none; }
.brand-sub { color: var(--text-color-kumo-subtle); font-size: var(--text-xs); }
.page { padding-top: ${S.xl}; padding-bottom: ${S.xxl}; display: flex; flex-direction: column; gap: ${S.lg}; min-width: 0; }
.page > * { min-width: 0; }

/* repository header */
.repo-head { display: flex; align-items: flex-end; justify-content: space-between; gap: ${S.md}; }
.repo-id { min-width: 0; flex: 1 1 auto; }
.repo-scope { margin: 0 0 2px; font-size: var(--text-sm); color: var(--text-color-kumo-subtle); display: flex; flex-wrap: wrap; gap: ${S.xs}; }
.repo-host { color: var(--text-color-kumo-subtle); }
.repo-host::after { content: "·"; margin-left: ${S.xs}; color: var(--text-color-kumo-inactive); }
.repo-scope a { color: inherit; }
.repo-slash { color: var(--text-color-kumo-inactive); }
.repo-name { margin: 0; font-size: var(--text-2xl); line-height: 1.15; font-weight: 600; letter-spacing: -0.025em; overflow-wrap: anywhere; }
.repo-name a { color: var(--text-color-kumo-strong); }
.repo-tools { display: flex; align-items: center; gap: ${S.sm}; flex: none; }
.refbox { position: relative; }
.ref-summary { height: 32px; padding-inline: 10px; gap: 6px; font-size: var(--text-sm); }
.ref-summary .i { color: var(--text-color-kumo-subtle); }
.ref-v { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: var(--text-xs); font-weight: 600; }
.ref-pop {
  position: absolute; z-index: 30; top: calc(100% + 6px); right: 0; width: min(18rem, calc(100vw - 2 * var(--viewer-pad)));
  display: grid; gap: 6px; padding: ${S.md}; border-radius: ${R.lg};
  background: var(--color-kumo-base); box-shadow: 0 0 0 1px var(--color-kumo-line), 0 12px 32px var(--color-kumo-shadow-drop);
}
.ref-label { font-size: var(--text-xs); font-weight: 500; color: var(--text-color-kumo-subtle); }
.ref-field { width: 100%; height: 34px; font-size: var(--text-base); }
.ref-go { margin-top: ${S.xs}; height: 34px; width: 100%; }
.crumbs { margin-top: -${S.xs}; height: auto; min-height: 28px; flex-wrap: wrap; white-space: normal; row-gap: 2px; font-size: var(--text-sm); }
.crumbs .crumb { color: var(--text-color-kumo-link); }
.crumbs .sep { padding-inline: 4px; }
.crumbs .here { overflow-wrap: anywhere; }

/* cards (Kumo LayerCard) */
.card { padding: 0 2px 2px; }
.card-head { min-height: 44px; padding: 10px ${S.md}; flex-wrap: wrap; font-size: var(--text-sm); }
.card-head .i { color: var(--text-color-kumo-subtle); }
.card-title { color: var(--text-color-kumo-strong); font-weight: 600; }
a.card-title:hover { color: var(--text-color-kumo-link); }
.card-count { margin-left: auto; font-size: var(--text-xs); color: var(--text-color-kumo-subtle); font-variant-numeric: tabular-nums; }
.card-body { min-width: 0; }
.pad { padding: ${S.md}; }
.empty { margin: 0; padding: ${S.md} ${S.lg}; color: var(--text-color-kumo-subtle); font-size: var(--text-sm); border-top: 1px solid var(--color-kumo-hairline); }
.card-body > .empty:first-child { border-top: 0; }

/* latest commit (the file card's header) */
.lc { width: 100%; min-width: 0; display: grid; gap: 6px; }
.lc-by { display: flex; align-items: center; gap: ${S.sm}; min-width: 0; font-size: var(--text-sm); }
.avatar {
  width: 22px; height: 22px; flex: none; border-radius: 999px; display: inline-grid; place-items: center;
  background: var(--color-kumo-fill); color: var(--text-color-kumo-strong); font-size: 10px; font-weight: 600; letter-spacing: 0.02em;
}
.lc-author { color: var(--text-color-kumo-strong); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lc-by .when { color: var(--text-color-kumo-subtle); font-weight: 400; white-space: nowrap; }
.lc-right { margin-left: auto; display: inline-flex; align-items: center; gap: ${S.sm}; flex: none; }
.lc-right .sha { color: var(--text-color-kumo-subtle); }
.lc-right .sha:hover { color: var(--text-color-kumo-link); }
.lc-subject { color: var(--text-color-kumo-default); font-weight: 500; font-size: var(--text-base); line-height: 1.4; overflow-wrap: anywhere; }
.lc-only { margin: 0; }
.lc-msg > summary { display: flex; align-items: flex-start; gap: ${S.sm}; }
.lc-msg > summary .lc-subject { flex: 1; min-width: 0; }
.more {
  flex: none; margin-top: 1px; height: 20px; padding: 0 7px; border-radius: 6px; display: inline-flex; align-items: center;
  background: var(--color-kumo-fill); color: var(--text-color-kumo-strong); font-weight: 700; font-size: 12px; letter-spacing: 0.08em;
}
.lc-msg > summary:hover .more { background: var(--color-kumo-fill-hover); }
.lc-msg[open] .more { box-shadow: inset 0 0 0 1px var(--color-kumo-line); }
.msg-body { margin-top: ${S.sm}; padding-top: ${S.sm}; border-top: 1px dashed var(--color-kumo-line); }
.msg-p { margin: 0 0 ${S.sm}; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-color-kumo-default); font-weight: 400; font-size: var(--text-sm); line-height: 1.55; max-width: ${L.proseCh + 15}ch; }
.trailers { margin: ${S.sm} 0 0; display: grid; gap: 2px; font-size: var(--text-xs); color: var(--text-color-kumo-subtle); font-weight: 400; }
.trailers div { display: flex; gap: ${S.sm}; min-width: 0; }
.trailers dt { flex: none; }
.trailers dt::after { content: ":"; }
.trailers dd { margin: 0; min-width: 0; overflow-wrap: anywhere; color: var(--text-color-kumo-strong); }
.trailers a { color: inherit; text-decoration: underline; text-decoration-color: var(--color-kumo-line); }
.when { cursor: help; }

/* file list */
.files { list-style: none; margin: 0; padding: 0; }
.files li + li { border-top: 1px solid var(--color-kumo-hairline); }
.files .row { display: flex; align-items: center; gap: 10px; min-height: var(--row); padding: 0 ${S.md}; color: var(--text-color-kumo-default); }
.files .row:hover { background: var(--color-kumo-tint); text-decoration: none; }
.files .row:hover .name { color: var(--text-color-kumo-link); text-decoration: underline; text-underline-offset: 0.15em; }
.files .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.files .oid { color: var(--text-color-kumo-inactive); }
${phone} { .files .oid { display: none; } }

/* recent commits */
.log { list-style: none; margin: 0; padding: 0; }
.log li + li { border-top: 1px solid var(--color-kumo-hairline); }
.log-row { display: grid; gap: 3px; padding: 10px ${S.md}; color: var(--text-color-kumo-default); min-width: 0; }
.log-row:hover { background: var(--color-kumo-tint); text-decoration: none; }
.log-row:hover .log-subject { color: var(--text-color-kumo-link); }
.log-subject { font-weight: 500; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.log-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; font-size: var(--text-xs); color: var(--text-color-kumo-subtle); }
.log-meta .sha { color: var(--text-color-kumo-link); }
.dot-sep { color: var(--text-color-kumo-inactive); }
${wide} {
  .log-row { grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; column-gap: ${S.lg}; }
  .log-subject { -webkit-line-clamp: 1; }
}

/* markdown */
.md { padding: ${S.lg} ${S.lg} ${S.xl}; font-size: 15px; line-height: 1.65; color: var(--text-color-kumo-default); min-width: 0; }
${wide} { .md { padding: ${S.xl} 2rem 2rem; } }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p, .md ul, .md ol, .md blockquote, .md .md-code, .md .md-table { margin: 0 0 ${S.lg}; }
.md h2, .md h3, .md h4, .md h5, .md h6 { color: var(--text-color-kumo-strong); line-height: 1.25; letter-spacing: -0.015em; margin: 1.75em 0 0.6em; font-weight: 600; scroll-margin-top: calc(var(--viewer-header) + ${S.lg}); }
.md h2 { font-size: 1.6em; letter-spacing: -0.025em; padding-bottom: 0.3em; border-bottom: 1px solid var(--color-kumo-hairline); }
.md h3 { font-size: 1.3em; padding-bottom: 0.25em; border-bottom: 1px solid var(--color-kumo-hairline); }
.md h4 { font-size: 1.1em; }
.md h5 { font-size: 1em; }
.md h6 { font-size: 0.9em; color: var(--text-color-kumo-subtle); }
.md strong { font-weight: 600; color: var(--text-color-kumo-strong); }
.md a { color: var(--text-color-kumo-link); text-decoration: underline; text-decoration-color: color-mix(in oklch, currentColor 35%, transparent); text-underline-offset: 0.18em; }
.md a:hover { text-decoration-color: currentColor; }
.md hr { border: 0; height: 1px; background: var(--color-kumo-line); margin: ${S.xl} 0; }
.md ul, .md ol { padding-left: 1.5em; }
.md li + li { margin-top: 0.3em; }
.md li > ul, .md li > ol { margin: 0.3em 0 0; }
.md li > p { margin: 0 0 0.5em; }
.md li::marker { color: var(--text-color-kumo-subtle); }
.md .task-item { list-style: none; margin-left: -1.5em; display: flex; gap: 0.55em; align-items: baseline; }
.md .task-item > ul { flex-basis: 100%; }
.md .task-item { flex-wrap: wrap; }
.md .task { flex: none; width: 1em; height: 1em; transform: translateY(0.15em); border-radius: 4px; border: 1.5px solid var(--color-kumo-line); display: inline-grid; place-items: center; font-size: 0.7em; font-weight: 700; line-height: 1; }
.md .task.done { background: var(--color-kumo-brand); border-color: var(--color-kumo-brand); color: #fff; }
.md blockquote { padding: 0.1em 0 0.1em 1em; border-left: 3px solid var(--color-kumo-line); color: var(--text-color-kumo-subtle); }
.md blockquote > :last-child { margin-bottom: 0; }
.md code { font-family: var(--font-mono); font-size: 0.86em; }
.md :not(pre) > code { background: var(--color-kumo-recessed); border: 1px solid var(--color-kumo-hairline); padding: 0.1em 0.35em; border-radius: 5px; overflow-wrap: anywhere; }
.md .md-code { border: 1px solid var(--color-kumo-hairline); border-radius: ${R.md}; background: var(--color-kumo-recessed); overflow: hidden; }
.md .md-code-lang { padding: 6px ${S.md}; font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.03em; color: var(--text-color-kumo-subtle); border-bottom: 1px solid var(--color-kumo-hairline); }
.md pre { margin: 0; padding: ${S.md} ${S.lg}; overflow-x: auto; font-size: 13px; line-height: 1.55; tab-size: 2; }
.md pre code { font-size: inherit; }
.md .md-table { overflow-x: auto; border: 1px solid var(--color-kumo-hairline); border-radius: ${R.md}; }
.md table { border-collapse: collapse; min-width: 100%; font-size: var(--text-sm); line-height: 1.45; }
.md th, .md td { padding: 8px 12px; text-align: left; vertical-align: top; border-top: 1px solid var(--color-kumo-hairline); min-width: 4.5rem; }
.md th + th, .md td + td { border-left: 1px solid var(--color-kumo-hairline); }
.md thead th { border-top: 0; background: var(--color-kumo-elevated); font-weight: 600; color: var(--text-color-kumo-strong); white-space: nowrap; }
.md tbody tr:nth-child(even) td { background: color-mix(in oklch, var(--color-kumo-elevated) 55%, transparent); }
.md td code { overflow-wrap: normal; word-break: keep-all; }
.md td:not(:first-child), .md th:not(:first-child) { min-width: 9rem; }
.md .al-c { text-align: center; } .md .al-r { text-align: right; }
.md .md-img { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; border: 1px dashed var(--color-kumo-line); font-size: var(--text-sm); }
.md .md-img::before { content: "image"; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-color-kumo-subtle); }
${phone} {
  .md { font-size: 15px; padding: ${S.lg} 14px ${S.xl}; }
  .md pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: ${S.md}; font-size: 12.5px; }
  .md th, .md td { padding: 7px 10px; }
}

/* file view */
.file-meta { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; color: var(--text-color-kumo-subtle); font-weight: 400; font-variant-numeric: tabular-nums; }
.raw-link { margin-left: auto; height: 28px; gap: 4px; color: var(--text-color-kumo-default); }
.raw-link:hover { text-decoration: none; color: var(--text-color-kumo-default); }
.raw-link .i { width: 14px; height: 14px; }
.seg-tabs { display: inline-flex; padding: 2px; gap: 2px; border-radius: 8px; background: var(--color-kumo-recessed); margin-left: auto; }
.seg-tabs + .raw-link { margin-left: 0; }
.tab { padding: 3px 10px; border-radius: 6px; font-size: var(--text-xs); font-weight: 500; color: var(--text-color-kumo-subtle); }
.tab:hover { text-decoration: none; color: var(--text-color-kumo-default); }
.anchor { display: block; height: 0; scroll-margin-top: calc(var(--viewer-header) + 80px); }
.has-md .code-wrap { display: none; }
.has-md:has(#code:target, .line:target) .code-wrap { display: block; }
.has-md:has(#code:target, .line:target) .md-view { display: none; }
.has-md:not(:has(#code:target, .line:target)) .tab-preview,
.has-md:has(#code:target, .line:target) .tab-code { background: var(--color-kumo-base); color: var(--text-color-kumo-strong); box-shadow: 0 0 0 1px var(--color-kumo-hairline); }
.code { overflow-x: auto; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.6; padding: ${S.sm} 0; tab-size: 4; }
.line { display: flex; min-width: max-content; }
.line:target { background: var(--color-kumo-warning-tint); }
.ln {
  position: sticky; left: 0; width: ${L.lineGutterRem}rem; flex: none; padding: 0 ${S.md} 0 ${S.sm};
  color: var(--text-color-kumo-inactive); text-align: right; user-select: none; -webkit-user-select: none;
  font-variant-numeric: tabular-nums; background: var(--color-kumo-base);
}
.ln:hover { color: var(--text-color-kumo-link); text-decoration: none; }
.line:target .ln { background: var(--color-kumo-warning-tint); color: var(--text-color-kumo-strong); }
.src { white-space: pre; padding-right: ${S.lg}; }
${phone} {
  .code { font-size: 12px; }
  .line { min-width: 0; }
  .ln { position: static; width: 2.75rem; padding-right: 10px; }
  .src { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; flex: 1; padding-right: ${S.md}; }
}

/* diagnostics + waterfall */
.diag { margin-top: ${S.md}; }
.diag-box { border-radius: ${R.lg}; background: var(--color-kumo-elevated); box-shadow: inset 0 0 0 1px var(--color-kumo-hairline); }
.diag-sum { display: flex; align-items: center; gap: ${S.sm}; min-height: 44px; padding: 0 ${S.md}; font-size: var(--text-sm); }
.diag-title { font-weight: 600; color: var(--text-color-kumo-strong); }
.diag-pill { color: var(--text-color-kumo-subtle); font-variant-numeric: tabular-nums; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diag-chev { margin-left: auto; transition: transform 0.15s; }
.diag-box[open] .diag-chev { transform: rotate(180deg); }
.diag-body { padding: 0 ${S.md} ${S.md}; display: grid; gap: ${S.md}; min-width: 0; }
.diag-body .banner { margin: 0; }
.kv { margin: 0; display: grid; gap: 4px; font-size: var(--text-xs); min-width: 0; }
.kv div { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr); gap: ${S.sm}; align-items: baseline; }
.kv dt { color: var(--text-color-kumo-subtle); }
.kv dd { margin: 0; overflow-wrap: anywhere; min-width: 0; }
.diag-links { margin: 0; font-size: var(--text-xs); color: var(--text-color-kumo-subtle); }
.wf { border-radius: ${R.md}; background: var(--color-kumo-base); box-shadow: 0 0 0 1px var(--color-kumo-hairline); font-size: var(--text-xs); min-width: 0; overflow: hidden; }
.wf-head, .wf-sum { display: grid; grid-template-columns: minmax(0, 1fr) 2.75rem 5.25rem 4rem; column-gap: ${S.sm}; align-items: center; padding: 0 ${S.md}; }
.wf-head { min-height: 32px; color: var(--text-color-kumo-subtle); font-weight: 500; background: var(--color-kumo-elevated); border-bottom: 1px solid var(--color-kumo-hairline); }
.wf-axis { display: none; justify-content: space-between; font-variant-numeric: tabular-nums; font-weight: 400; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.wf-row + .wf-row { border-top: 1px solid var(--color-kumo-hairline); }
.wf-sum { row-gap: 6px; padding-top: 9px; padding-bottom: 10px; }
.wf-sum:hover { background: var(--color-kumo-tint); }
.wf-name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; min-width: 0; }
.wf-call { font-family: var(--font-mono); font-weight: 600; color: var(--text-color-kumo-strong); }
.wf-tag { color: var(--text-color-kumo-subtle); font-family: var(--font-mono); font-size: 11px; }
.wf-ms { color: var(--text-color-kumo-strong); font-weight: 600; }
.wf-hit { color: var(--text-color-kumo-success); }
.err .wf-call, .err .wf-status { color: var(--text-color-kumo-danger); }
.wf-track { grid-column: 1 / -1; position: relative; height: 6px; border-radius: 999px; background: var(--color-kumo-recessed); }
.wf-bar { position: absolute; top: 0; bottom: 0; border-radius: inherit; min-width: 3px; }
.c-err { background: var(--color-kumo-danger); }
.c-hit { background: var(--color-kumo-success); }
.c-discover { background: var(--color-kumo-info); }
.c-fetch { background: var(--color-kumo-badge-purple); }
.c-fallback { background: var(--color-kumo-warning); }
.wf-detail { padding: 0 ${S.md} ${S.md}; }
.detail { margin: 0; padding: ${S.sm} ${S.md}; border-radius: ${R.sm}; background: var(--color-kumo-recessed); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-color-kumo-subtle); font-family: var(--font-mono); font-size: 11px; line-height: 1.5; }
.wf-pack { display: inline-block; margin-top: ${S.sm}; font-weight: 500; }
.wf-legend { margin: 0; padding: ${S.sm} ${S.md}; display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--text-color-kumo-subtle); border-top: 1px solid var(--color-kumo-hairline); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0; }
${wide} {
  .wf-head, .wf-sum { grid-template-columns: minmax(9rem, 13rem) 3rem 5.5rem 4rem minmax(0, 1fr); column-gap: ${S.md}; }
  .wf-axis { display: flex; }
  .wf-track { grid-column: auto; height: 8px; }
  .wf-sum { padding-top: 8px; padding-bottom: 8px; }
}
.site-footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: ${S.sm}; padding: ${S.md} 2px 0; font-size: var(--text-xs); color: var(--text-color-kumo-subtle); }
.site-footer a { color: inherit; font-weight: 500; }

/* home */
.hero { padding: ${S.lg} 0 0; }
.kicker { margin: 0 0 ${S.sm}; font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-color-kumo-brand); }
.display { margin: 0; color: var(--text-color-kumo-strong); font-size: 1.75rem; font-weight: 650; letter-spacing: -0.03em; line-height: 1.12; }
.lede { margin: ${S.sm} 0 0; max-width: 40rem; color: var(--text-color-kumo-subtle); font-size: 15px; line-height: 1.55; }
.stack-form { display: flex; flex-direction: column; gap: ${S.sm}; margin-top: ${S.lg}; }
.stack-form .control { flex: none; height: 44px; padding: 0 14px; border-radius: 10px; line-height: normal; font-size: 16px; width: 100%; min-width: 0; -webkit-appearance: none; appearance: none; }
.stack-form .btn { height: 44px; padding: 0 20px; border-radius: 10px; font-size: var(--text-base); }
.is-primary:hover { opacity: ${L.primaryHoverOpacity}; }
.banner { margin: 0; }
.chips { display: flex; flex-wrap: wrap; gap: ${S.sm}; margin-top: ${S.md}; }
.chip { display: inline-flex; align-items: center; height: 30px; padding: 0 12px; border-radius: 999px; background: var(--color-kumo-base); box-shadow: 0 0 0 1px var(--color-kumo-line); color: var(--text-color-kumo-default); font-size: var(--text-sm); font-weight: 500; }
.chip:hover { background: var(--color-kumo-tint); text-decoration: none; }
.repo-list { list-style: none; margin: 0; padding: 0; }
.repo-list li + li { border-top: 1px solid var(--color-kumo-hairline); }
.repo-list a { display: flex; align-items: center; gap: 10px; min-height: var(--row); padding: 0 ${S.md}; color: var(--text-color-kumo-default); font-weight: 500; }
.repo-list a:hover { background: var(--color-kumo-tint); text-decoration: none; color: var(--text-color-kumo-link); }
.repo-list .go { margin-left: auto; color: var(--text-color-kumo-inactive); font-size: var(--text-xs); font-weight: 400; }
.card-grid { display: grid; gap: ${S.lg}; }
.host-list { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0; padding: 0; }
.host-list li { font-family: var(--font-mono); font-size: var(--text-xs); background: var(--color-kumo-recessed); border-radius: 999px; padding: 2px 9px; }
.note { color: var(--text-color-kumo-subtle); font-size: var(--text-sm); margin: ${S.sm} 0 0; }
.limits { margin: 0; display: grid; gap: 6px; }
.limits div { display: flex; justify-content: space-between; gap: ${S.md}; font-size: var(--text-sm); }
.limits dt { color: var(--text-color-kumo-subtle); }
.limits dd { margin: 0; font-variant-numeric: tabular-nums; text-align: right; }
.steps { display: grid; gap: ${S.md}; }
.step strong { display: block; font-size: var(--text-sm); font-weight: 600; color: var(--text-color-kumo-strong); margin-bottom: 2px; }
.step span { color: var(--text-color-kumo-subtle); font-size: var(--text-sm); }
.error-card { padding: ${S.xl}; display: grid; gap: ${S.md}; }
.error-kicker { margin: 0; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-color-kumo-subtle); letter-spacing: 0.04em; }
.reason > summary { color: var(--text-color-kumo-subtle); font-size: var(--text-xs); font-weight: 600; }
.reason p { margin: ${S.sm} 0 0; color: var(--text-color-kumo-subtle); font-size: var(--text-xs); overflow-wrap: anywhere; }
${wide} {
  .stack-form { flex-direction: row; align-items: center; }
  .stack-form .control { flex: 1 1 auto; }
  .card-grid { grid-template-columns: 1.1fr 0.9fr; }
  .steps { grid-template-columns: 1fr 1fr 1fr; }
  .display { font-size: 2.25rem; }
  .repo-name { font-size: 1.75rem; }
}

/* pack map */
.section-title { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--text-color-kumo-strong); }
.pack-list { display: flex; flex-direction: column; }
.pack-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; column-gap: ${S.md}; align-items: baseline; padding: ${S.sm} ${S.lg}; border-top: 1px solid var(--color-kumo-hairline); }
.pack-row:first-child { border-top: 0; }
.pack-row.on, .pack-row:target { background: var(--color-kumo-warning-tint); }
.pack-row:hover { background: var(--color-kumo-tint); }
.pack-off { color: var(--text-color-kumo-subtle); white-space: nowrap; font-variant-numeric: tabular-nums; }
.pack-row .sub { grid-column: 1 / -1; color: var(--text-color-kumo-subtle); font-size: var(--text-xs); }
.meta-k { font-weight: 500; margin-right: ${S.xs}; }
.subject { margin: 0; font-size: var(--text-base); font-weight: 600; color: var(--text-color-kumo-strong); overflow-wrap: anywhere; }
.section-label { margin: ${S.sm} 0 0; font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-color-kumo-subtle); }
.plain-list { list-style: none; margin: 0; padding: 0; font-size: var(--text-sm); }
.plain-list li { display: flex; gap: ${S.sm}; padding: 6px 0; border-top: 1px solid var(--color-kumo-hairline); }
.packbar { display: flex; height: ${L.packBarPx}px; width: 100%; border-radius: 6px; overflow: hidden; background: var(--color-kumo-fill); }
.packbar a, .packbar span { display: block; height: 100%; flex: none; }
.packbar a.on, .packbar a:focus-visible { outline: 2px solid var(--color-kumo-focus); outline-offset: -2px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: var(--text-xs); color: var(--text-color-kumo-subtle); }
.sw { display: inline-block; width: ${L.swatchPx}px; height: ${L.swatchPx}px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.stats { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: var(--text-sm); }
.stats strong { font-variant-numeric: tabular-nums; font-weight: 600; }
.surface-pad { padding: ${S.md} ${S.lg}; }
@media (prefers-reduced-motion: reduce) { .diag-chev { transition: none; } }
${percentRules()}
`
}

const KUMO_SHEET = kumoSubset(KUMO_STANDALONE_CSS, KUMO_USED)

export const VIEWER_CSS = `${KUMO_SHEET}\n${colorSchemeBridge(KUMO_STANDALONE_CSS)}\n${layoutCss()}`
