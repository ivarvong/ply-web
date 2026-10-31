import type { Child } from 'hono/jsx'
import type { BranchInfo, RepoHeader, TagInfo, TraceBar, TraceModel } from './model.ts'
import { PLY_SHA, PLY_WEB_SHA, plyBuildValue } from '../version.ts'

/** Hex digits of each commit shown in the footer. */
const BUILD_SHA_CHARS = 12
import { viewerHref } from './url.ts'
import {
  bannerClass, buttonClass, KUMO_BADGE_DANGER, KUMO_BADGE_INFO, KUMO_BADGE_NEUTRAL, KUMO_BADGE_OUTLINE, KUMO_BADGE_SUCCESS,
  KUMO_BADGE_WARNING, KUMO_BREADCRUMBS, KUMO_BREADCRUMB_CURRENT, KUMO_BREADCRUMB_LINK, KUMO_BREADCRUMB_SEPARATOR,
  KUMO_BUTTON_FOCUS, KUMO_BUTTON_SECONDARY, KUMO_BUTTON_SIZE_SM, KUMO_INPUT_SM, KUMO_LAYER_CARD, KUMO_LAYER_CARD_PRIMARY,
  KUMO_LAYER_CARD_SECONDARY, type BannerTone, type ButtonSize, type ButtonVariant,
} from './kumo-classes.ts'
import { exactTime, formatBytes, formatDuration, percentClass } from './format.ts'
import { repoIdentity } from './identity.ts'
import { LAYOUT } from './layout.ts'
import { VIEWER_CSS_PATH } from './styles.ts'

export function Button(props: { variant: ButtonVariant; size: ButtonSize; type?: 'submit' | 'button'; children: Child }) {
  const tone = props.variant === 'primary' ? 'is-primary' : 'is-secondary'
  return <button type={props.type ?? 'submit'} class={`btn ${tone} ${buttonClass(props.variant, props.size)}`}>{props.children}</button>
}

export function Banner(props: { tone: BannerTone; children: Child }) {
  return <p class={`banner ${bannerClass(props.tone)}`}>{props.children}</p>
}

export function Time(props: { iso: string; tz: string; now: number }) {
  const exact = exactTime(props.iso, props.tz, props.now)
  return <time class="when" datetime={exact.iso} title={exact.label}>{exact.relative}</time>
}

// ── icons ───────────────────────────────────────────────────────────────────────────────────────────────────────
// One inline sprite per page; every icon is a <use> of it (img-src is 'none', so no data: URIs). 16×16 grid.

const ICONS: Record<string, string> = {
  dir: 'M1.5 3.25c0-.69.56-1.25 1.25-1.25h3.4c.33 0 .65.13.88.37L8.2 3.5h5.05c.69 0 1.25.56 1.25 1.25v7.5c0 .69-.56 1.25-1.25 1.25H2.75c-.69 0-1.25-.56-1.25-1.25z',
  file: 'M4 1.5h5.1L12.5 4.9v9.1a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5zM9 1.75V5h3.25',
  link: 'M6.5 9.5l3-3M7.3 4.7l1.1-1.1a2.5 2.5 0 0 1 3.5 3.5l-1.1 1.1M8.7 11.3l-1.1 1.1a2.5 2.5 0 0 1-3.5-3.5l1.1-1.1',
  module: 'M2 4.5L8 1.75l6 2.75v7L8 14.25 2 11.5zM2 4.5l6 2.75 6-2.75M8 7.25v7',
  branch: 'M5 2.5v7.25M5 9.75a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5 2.5a1.5 1.5 0 1 0 0 .01M11 3.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM11 6.75c0 2.5-6 1.5-6 3',
  book: 'M8 3.5C6.8 2.6 5 2.25 2.25 2.25v10c2.75 0 4.55.35 5.75 1.25 1.2-.9 3-1.25 5.75-1.25v-10C11 2.25 9.2 2.6 8 3.5zM8 3.5v10',
  history: 'M2.25 8A5.75 5.75 0 1 0 4 3.9M2.25 2v2.75H5M8 5v3.25l2.25 1.5',
  pulse: 'M1.5 8.5h2.75L6 4l3 8 1.75-3.5h3.75',
  chevron: 'M4.5 6.25L8 9.75l3.5-3.5',
  up: 'M8 13V3.5M4.25 7.25L8 3.5l3.75 3.75',
  raw: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5',
}

export function Sprite() {
  return (
    <svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">
      {Object.entries(ICONS).map(([id, d]) => <symbol id={`i-${id}`} viewBox="0 0 16 16"><path d={d} /></symbol>)}
    </svg>
  )
}

export function Icon(props: { name: keyof typeof ICONS; class?: string }) {
  return <svg class={`i i-${props.name}${props.class ? ` ${props.class}` : ''}`} width="16" height="16" aria-hidden="true" focusable="false"><use href={`#i-${props.name}`} /></svg>
}

export function IconFolder() { return <Icon name="dir" /> }
export function IconFile() { return <Icon name="file" /> }

// ── page frame ──────────────────────────────────────────────────────────────────────────────────────────────────

export function Document(props: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <title>{props.title}</title>
        <link rel="stylesheet" href={VIEWER_CSS_PATH} />
      </head>
      <body>
        <Sprite />
        <header class="site-header">
          <div class="site-header-inner">
            <a class="brand" href="/view"><span class="mark" aria-hidden="true"></span>ply</a>
            <span class="brand-sub">Public repo viewer</span>
          </div>
        </header>
        <main class="page">{props.children}</main>
      </body>
    </html>
  )
}

/** Kumo LayerCard: an elevated frame, an optional header strip (Secondary), and the raised panel (Primary). */
export function Card(props: { head?: Child; id?: string; class?: string; children: Child }) {
  return (
    <section class={`card ${KUMO_LAYER_CARD}${props.class ? ` ${props.class}` : ''}`} id={props.id}>
      {props.head ? <div class={`card-head ${KUMO_LAYER_CARD_SECONDARY}`}>{props.head}</div> : null}
      <div class={`card-body ${KUMO_LAYER_CARD_PRIMARY}`}>{props.children}</div>
    </section>
  )
}

export function Badge(props: { tone: 'neutral' | 'outline' | 'success' | 'info' | 'warning' | 'danger'; title?: string; children: Child }) {
  const cls = { neutral: KUMO_BADGE_NEUTRAL, outline: KUMO_BADGE_OUTLINE, success: KUMO_BADGE_SUCCESS, info: KUMO_BADGE_INFO, warning: KUMO_BADGE_WARNING, danger: KUMO_BADGE_DANGER }[props.tone]
  return <span class={cls} title={props.title}>{props.children}</span>
}

export function Signed() {
  return <Badge tone="success" title="The commit carries a signature header (not verified here)">Signed</Badge>
}

// ── repository header ───────────────────────────────────────────────────────────────────────────────────────────

function shortRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '')
}

export function RepoIdentity(props: { host: string; repoPath: string; ref?: string | null }) {
  const id = repoIdentity(props.host, props.repoPath)
  const root = viewerHref(props.host, props.repoPath, props.ref ? { ref: props.ref } : {})
  return (
    <div class="repo-id">
      <p class="repo-scope">
        <span class="repo-host" title={id.remote}>{id.hostLabel}</span>
        {id.scope ? <>{id.scopeHref ? <a href={id.scopeHref}>{id.scope}</a> : <span>{id.scope}</span>}<span class="repo-slash" aria-hidden="true">/</span></> : null}
      </p>
      <h1 class="repo-name"><a href={root}>{id.name}</a></h1>
    </div>
  )
}

export function RepoTitle(props: { header: RepoHeader; path: string; branches: readonly BranchInfo[]; tags: readonly TagInfo[] }) {
  return (
    <header class="repo-head">
      <RepoIdentity host={props.header.host} repoPath={props.header.repoPath} ref={props.header.ref} />
      <div class="repo-tools">
        <RefSwitcher header={props.header} path={props.path} branches={props.branches} tags={props.tags} />
      </div>
    </header>
  )
}

/** Kumo Breadcrumbs (sm) for the path inside the repository. The repository name is the first crumb. */
export function PathCrumbs(props: { header: { host: string; repoPath: string; ref: string }; path: string }) {
  if (!props.path) return null
  const id = repoIdentity(props.header.host, props.header.repoPath)
  const parts = props.path.split('/')
  const crumbs: { label: string; href: string }[] = [{ label: id.name, href: viewerHref(props.header.host, props.header.repoPath, { ref: props.header.ref }) }]
  let acc = ''
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part
    crumbs.push({ label: part, href: viewerHref(props.header.host, props.header.repoPath, { ref: props.header.ref, path: acc }) })
  }
  const last = crumbs.length - 1
  return (
    <nav class={`crumbs ${KUMO_BREADCRUMBS}`} aria-label="Path">
      {crumbs.map((crumb, index) => (
        <>
          {index > 0 ? <span class={`sep ${KUMO_BREADCRUMB_SEPARATOR}`} aria-hidden="true">/</span> : null}
          {index === last
            ? <span class={`here ${KUMO_BREADCRUMB_CURRENT}`} aria-current="page">{crumb.label}</span>
            : <a class={`crumb ${KUMO_BREADCRUMB_LINK}`} href={crumb.href}>{crumb.label}</a>}
        </>
      ))}
    </nav>
  )
}

function refOption(name: string, current: string, label: string, note: string) {
  const selected = name === current || shortRef(name) === current
  return <option value={name} selected={selected}>{label}{note}</option>
}

export function RefSwitcher(props: { header: RepoHeader; path: string; branches: readonly BranchInfo[]; tags: readonly TagInfo[] }) {
  const action = viewerHref(props.header.host, props.header.repoPath, {})
  const known = props.branches.some(branch => branch.name === props.header.ref || shortRef(branch.name) === props.header.ref)
    || props.tags.some(tag => tag.name === props.header.ref || shortRef(tag.name) === props.header.ref)
  const current = /^[0-9a-f]{40}$/.test(props.header.ref) ? props.header.ref.slice(0, LAYOUT.shortOid) : shortRef(props.header.ref)
  return (
    <details class="refbox">
      <summary class={`ref-summary ${KUMO_BUTTON_SIZE_SM} ${KUMO_BUTTON_SECONDARY} ${KUMO_BUTTON_FOCUS}`} aria-label={`Ref ${current}. Switch branch or tag`}>
        <Icon name="branch" />
        <span class="ref-v">{current}</span>
        <Icon name="chevron" class="i-sm" />
      </summary>
      <div class="ref-pop">
        <form action={action} method="get">
          <label class="ref-label" for="ref-branch">Branch or tag</label>
          <select id="ref-branch" class={`ref-field ${KUMO_INPUT_SM}`} name="ref">
            {known ? null : <option value={props.header.ref} selected>{current}</option>}
            <optgroup label="Branches">
              {props.branches.map(branch => refOption(branch.name, props.header.ref, shortRef(branch.name), branch.head ? ' (default)' : ''))}
            </optgroup>
            {props.tags.length ? (
              <optgroup label="Tags">
                {props.tags.map(tag => refOption(tag.name, props.header.ref, shortRef(tag.name), ''))}
              </optgroup>
            ) : null}
          </select>
          {props.path ? <input type="hidden" name="path" value={props.path} /> : null}
          <button class={`ref-go ${buttonClass('primary', 'sm')}`} type="submit">Switch</button>
        </form>
        <form action={action} method="get">
          <label class="ref-label" for="ref-oid">Commit</label>
          <input id="ref-oid" class={`ref-field ${KUMO_INPUT_SM}`} type="text" name="ref" placeholder="name or oid" autocomplete="off" spellcheck={false} />
          {props.path ? <input type="hidden" name="path" value={props.path} /> : null}
          <button class={`ref-go ${buttonClass('primary', 'sm')}`} type="submit">Go</button>
        </form>
      </div>
    </details>
  )
}

// ── diagnostics ─────────────────────────────────────────────────────────────────────────────────────────────────

export function Protocol(props: { header: RepoHeader }) {
  const server = props.header.server
  return (
    <dl class="kv">
      <div><dt>Protocol</dt><dd>v{server.protocol} · {server.objectFormat}</dd></div>
      <div><dt>Agent</dt><dd class="mono">{server.agent || 'unknown'}</dd></div>
      <div><dt>Filter</dt><dd>{server.filterAdvertised ? 'advertised' : 'not advertised'}</dd></div>
      <div><dt>Fetch</dt><dd class="mono">{server.fetchFeatures.join(' ') || 'none'}</dd></div>
      <div><dt>Capabilities</dt><dd class="mono">{server.caps.join(' ') || 'none'}</dd></div>
    </dl>
  )
}

function barTone(bar: TraceBar): string {
  if (bar.status === 'error' || (bar.httpStatus !== null && bar.httpStatus >= 400)) return 'c-err'
  if (bar.cache === 'HIT') return 'c-hit'
  if (bar.lines.some(line => line.startsWith('git.fetch.filter.fallback='))) return 'c-fallback'
  if (bar.name.includes('discover') || bar.name.includes('ls-refs')) return 'c-discover'
  return 'c-fetch'
}

function callLabel(bar: TraceBar): { name: string; tag: string } {
  const name = bar.name.replace(/^git\.(upload-pack|receive-pack)\s+/, '').replace(/^git\./, '')
  const filter = bar.lines.find(line => line.startsWith('git.fetch.filter.fallback='))?.split('=')[1]
    ?? bar.lines.find(line => line.startsWith('git.fetch.filter='))?.split('=')[1]
  const deepen = bar.lines.find(line => line.startsWith('git.fetch.deepen='))?.split('=')[1]
  const tag = [filter, deepen && deepen !== '0' ? `deepen ${deepen}` : ''].filter(Boolean).join(' · ')
  return { name, tag }
}

export function Waterfall(props: { trace: TraceModel; host: string; repoPath: string; ref: string | null }) {
  const trace = props.trace
  if (!trace.bars.length) return null
  const span = Math.max(trace.totalMs, 1)
  return (
    <div class="wf" role="table" aria-label="Upstream git calls">
      <div class="wf-head" role="row">
        <span role="columnheader">Call</span>
        <span role="columnheader" class="num">Status</span>
        <span role="columnheader" class="num">Size</span>
        <span role="columnheader" class="num">Time</span>
        <span role="columnheader" class="wf-axis"><span>0</span><span>{formatDuration(trace.totalMs)}</span></span>
      </div>
      {trace.bars.map(bar => {
        const left = Math.max(0, Math.min(LAYOUT.percentSteps, Math.round((bar.startMs / span) * LAYOUT.percentSteps)))
        let width = Math.max(bar.durMs > 0 ? 1 : 0, Math.round((bar.durMs / span) * LAYOUT.percentSteps))
        if (left + width > LAYOUT.percentSteps) width = Math.max(1, LAYOUT.percentSteps - left)
        const failed = bar.status === 'error' || (bar.httpStatus !== null && bar.httpStatus >= 400)
        const label = callLabel(bar)
        const packHref = bar.packWant && bar.packFilter
          ? viewerHref(props.host, props.repoPath, { ref: props.ref ?? undefined, want: bar.packWant, filter: bar.packFilter })
          : null
        return (
          <details class={failed ? 'wf-row err' : 'wf-row'} role="row">
            <summary class="wf-sum">
              <span class="wf-name" role="cell"><span class="wf-call">{label.name}</span>{label.tag ? <span class="wf-tag">{label.tag}</span> : null}</span>
              <span class="num wf-status" role="cell">{bar.httpStatus === null ? '—' : String(bar.httpStatus)}</span>
              <span class="num" role="cell">{bar.bytes === null ? '—' : formatBytes(bar.bytes)}{bar.cache === 'HIT' ? <span class="wf-hit" title="Served from Workers Cache"> · hit</span> : null}</span>
              <span class="num wf-ms" role="cell">{formatDuration(bar.durMs)}</span>
              <span class="wf-track" role="cell" title={`${label.name} · starts at ${formatDuration(bar.startMs)} · ${formatDuration(bar.durMs)}`}>
                <span class={`wf-bar ${barTone(bar)} ${percentClass('o', left)} ${percentClass('w', width)}`}></span>
              </span>
            </summary>
            <div class="wf-detail">
              <pre class="detail">{`${bar.name}\n${bar.lines.join('\n')}`}</pre>
              {packHref ? <a class="wf-pack" href={packHref}>Open pack map</a> : null}
            </div>
          </details>
        )
      })}
      <p class="wf-legend" aria-hidden="true">
        <span><i class="dot c-discover"></i>handshake</span>
        <span><i class="dot c-fetch"></i>fetch</span>
        <span><i class="dot c-fallback"></i>blob:none</span>
        <span><i class="dot c-hit"></i>cache hit</span>
        <span><i class="dot c-err"></i>error</span>
      </p>
    </div>
  )
}

function shownId(id: string): string {
  if (!id) return 'n/a'
  if (id.length <= LAYOUT.requestIdShown) return id
  return `${id.slice(0, LAYOUT.requestIdShown)}…`
}

/**
 * Everything about how the page was fetched, collapsed by default (open with ?trace=1): the remote, the git calls
 * as a waterfall on one shared timeline, the protocol the server spoke, pack-map links, and request ids.
 */
export function Diagnostics(props: { trace: TraceModel; header?: RepoHeader; host?: string; repoPath?: string; ref?: string | null; open?: boolean }) {
  const trace = props.trace
  const host = props.header?.host ?? props.host ?? ''
  const repoPath = props.header?.repoPath ?? props.repoPath ?? ''
  const ref = props.header?.ref ?? props.ref ?? null
  const wide = trace.bars.filter(bar => bar.lines.some(line => line.startsWith('git.fetch.filter.fallback=')))
  // learned=true: this page saw the 400 and retried. learned=false: the isolate already knew, so it asked for blob:none.
  // A refusal on this page (any call: the history window is often the first to ask for tree:0) counts as a retry here.
  const refusedHere = trace.bars.some(bar => bar.lines.includes('http.response.status_code=400') && bar.lines.some(line => line.startsWith('git.fetch.filter=') && line !== 'git.fetch.filter=blob:none'))
  const fallbacks = wide.filter(bar => bar.lines.includes('git.fetch.filter.learned=true')).length || (refusedHere ? wide.length : 0)
  const known = wide.length - fallbacks
  const retry = fallbacks === 0 ? '' : fallbacks === 1 ? ' · 1 retry' : ` · ${fallbacks} retries`
  const calls = trace.bars.length
  const pill = calls ? `${calls} git ${calls === 1 ? 'call' : 'calls'} · ${formatDuration(trace.totalMs)}${retry}` : 'no git calls'
  const id = host && repoPath ? repoIdentity(host, repoPath) : null
  return (
    <section class="diag" id="diagnostics">
      <details class="diag-box" open={props.open}>
        <summary class="diag-sum">
          <Icon name="pulse" />
          <span class="diag-title">Diagnostics</span>
          <span class="diag-pill">{pill}</span>
          <Icon name="chevron" class="i-sm diag-chev" />
        </summary>
        <div class="diag-body">
          {fallbacks > 0 ? <Banner tone="alert">filter tree:0 was rejected. ply retried with blob:none. The calls are serial, which is why the waterfall is a staircase.</Banner> : null}
          {fallbacks === 0 && known > 0 ? <Banner tone="info">This server refuses filter tree:0 (learned earlier in this isolate), so ply asked for blob:none directly. That brings every tree under the commit, not just one.</Banner> : null}
          {host ? <Waterfall trace={trace} host={host} repoPath={repoPath} ref={ref} /> : null}
          <dl class="kv">
            {id ? <div><dt>Remote</dt><dd class="mono">{id.remote}</dd></div> : null}
            {ref ? <div><dt>Ref</dt><dd class="mono">{ref}</dd></div> : null}
            {props.header ? <div><dt>Commit</dt><dd class="mono">{props.header.commit}</dd></div> : null}
            <div><dt>cf-ray</dt><dd class="mono">{trace.cfRay || 'n/a'}</dd></div>
            <div><dt>Request</dt><dd class="mono" title={trace.requestId || 'n/a'}>{shownId(trace.requestId)}</dd></div>
          </dl>
          {props.header ? <Protocol header={props.header} /> : null}
          {props.header ? (
            <p class="diag-links">
              Pack maps for this commit:{' '}
              <a href={viewerHref(host, repoPath, { ref: ref ?? undefined, want: props.header.commit, filter: 'tree:0' })}>tree:0</a>
              {' · '}
              <a href={viewerHref(host, repoPath, { ref: ref ?? undefined, want: props.header.commit, filter: 'blob:none' })}>blob:none</a>
            </p>
          ) : null}
        </div>
      </details>
      <footer class="site-footer">
        <span>ply · read-only, no credentials</span>
        {/* Abbreviated commits, one unbreakable token each, so a narrow footer wraps between them (never at "ply-web").
            The full value is the title and the x-ply-build header. */}
        <span class="mono build" title={`${plyBuildValue()} (ply commit and ply-web commit this deploy was built from)`}>
          <span>ply={PLY_SHA.slice(0, BUILD_SHA_CHARS)}</span> <span>ply-web={PLY_WEB_SHA.slice(0, BUILD_SHA_CHARS)}</span>
        </span>
        <a href="/view#limits">Limits</a>
      </footer>
    </section>
  )
}

/** Old name kept for the pages that only need the footer. */
export function Footer(props: { trace: TraceModel; header?: RepoHeader; host?: string; repoPath?: string; ref?: string | null; open?: boolean }) {
  return <Diagnostics {...props} />
}
