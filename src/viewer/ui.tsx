import type { Child } from 'hono/jsx'
import type { BranchInfo, RepoHeader, TraceBar, TraceModel } from './model.ts'
import { VIEWER_CAPS } from './limits.ts'
import { viewerHref } from './url.ts'
import { bannerClass, buttonClass, KUMO_BADGE, KUMO_BADGE_SUCCESS, KUMO_INPUT, type BannerTone, type ButtonSize, type ButtonVariant } from './kumo-classes.ts'
import { exactTime, formatBytes, formatDuration, percentClass } from './format.ts'
import { LAYOUT } from './layout.ts'

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

export function IconFolder() {
  return (
    <svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M1.5 3.2h4.6l1.2 1.4h7.2v8.2H1.5z" />
    </svg>
  )
}

export function IconFile() {
  return (
    <svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M3.2 1.5h5.4L12.8 5.6V14.5H3.2zM8.4 2.2v3.6h3.6" />
    </svg>
  )
}

export function Document(props: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/view.css" />
      </head>
      <body>
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

type Crumb = { label: string; href?: string }

export function Crumbs(props: { host: string; repoPath: string; ref: string; path: string }) {
  const repo = props.repoPath.replace(/\.git$/, '')
  const bits: Crumb[] = [
    { label: props.host, href: viewerHref(props.host, props.repoPath, { ref: props.ref }) },
    { label: repo, href: viewerHref(props.host, props.repoPath, { ref: props.ref }) },
  ]
  let acc = ''
  for (const part of props.path ? props.path.split('/') : []) {
    acc = acc ? `${acc}/${part}` : part
    bits.push({ label: part, href: viewerHref(props.host, props.repoPath, { ref: props.ref, path: acc }) })
  }
  const last = bits.length - 1
  return (
    <nav class="crumbs" aria-label="Path">
      {bits.map((crumb, index) => {
        const node = index === last || !crumb.href
          ? <span class="here">{crumb.label}</span>
          : <a href={crumb.href}>{crumb.label}</a>
        return index === 0 ? node : <><span class="sep">/</span>{node}</>
      })}
    </nav>
  )
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '')
}

export function RefSwitcher(props: { header: RepoHeader; path: string; branches: readonly BranchInfo[] }) {
  const action = viewerHref(props.header.host, props.header.repoPath, {})
  const known = props.branches.some(branch => branch.name === props.header.ref || shortRef(branch.name) === props.header.ref)
  return (
    <div class="switchers">
      <form class="switch-form" action={action} method="get">
        <label class="switch-label">
          <span>Branch</span>
          <span class="select-wrap">
            <select class={`control viewer-select ${KUMO_INPUT}`} name="ref" aria-label="Branch">
              {known ? null : <option value={props.header.ref} selected>{shortRef(props.header.ref)}</option>}
              {props.branches.map(branch => {
                const label = shortRef(branch.name)
                const selected = branch.name === props.header.ref || label === props.header.ref
                return <option value={branch.name} selected={selected}>{label}{branch.head ? ' (default)' : ''}</option>
              })}
            </select>
          </span>
        </label>
        {props.path ? <input type="hidden" name="path" value={props.path} /> : null}
        <Button variant="secondary" size="base">Switch</Button>
      </form>
      <form class="switch-form" action={action} method="get">
        <label class="switch-label">
          <span>Tag or commit</span>
          <input class={`control ${KUMO_INPUT}`} type="text" name="ref" placeholder="v1.0.0" aria-label="Tag or commit" autocomplete="off" spellcheck={false} />
        </label>
        {props.path ? <input type="hidden" name="path" value={props.path} /> : null}
        <Button variant="secondary" size="base">Open</Button>
      </form>
    </div>
  )
}

export function Protocol(props: { header: RepoHeader }) {
  const server = props.header.server
  const agent = server.agent || 'unknown'
  return (
    <div class="meta-row">
      <span class={KUMO_BADGE}>v{server.protocol}</span>
      <span class={KUMO_BADGE}>{server.objectFormat}</span>
      <span class={KUMO_BADGE}>{server.filterAdvertised ? 'filter advertised' : 'filter not advertised'}</span>
      <span class="agent">agent {agent}</span>
      <details class="proto">
        <summary>Protocol</summary>
        <div class="proto-panel">
          <dl>
            <div><dt>Version</dt><dd>{server.protocol}</dd></div>
            <div><dt>Agent</dt><dd class="mono">{agent}</dd></div>
            <div><dt>Object format</dt><dd class="mono">{server.objectFormat}</dd></div>
            <div><dt>Filter</dt><dd>{server.filterAdvertised ? 'Advertised by the server' : 'Not advertised'}</dd></div>
            <div><dt>Fetch</dt><dd class="mono">{server.fetchFeatures.join(' ') || 'none'}</dd></div>
            <div><dt>Capabilities</dt><dd class="mono">{server.caps.join(' ') || 'none'}</dd></div>
          </dl>
        </div>
      </details>
    </div>
  )
}

function barClass(bar: TraceBar): string {
  if (bar.status === 'error' || (bar.httpStatus !== null && bar.httpStatus >= 400)) return 'c-err'
  if (bar.lines.some(line => line.startsWith('git.fetch.filter.fallback='))) return 'c-fallback'
  if (bar.cache === 'HIT') return 'c-hit'
  if (bar.name.includes('discover')) return 'c-discover'
  if (bar.name.includes('ls-refs')) return 'c-refs'
  return 'c-fetch'
}

function traceLabel(name: string): string {
  return name.replace(/^git\./, '')
}

export function Trace(props: { trace: TraceModel; host: string; repoPath: string; ref: string | null }) {
  const trace = props.trace
  if (!trace.bars.length) return null
  const span = Math.max(trace.totalMs, 1)
  const fallbacks = trace.bars.filter(bar => bar.lines.some(line => line.startsWith('git.fetch.filter.fallback='))).length
  const retry = fallbacks === 0 ? '' : fallbacks === 1 ? ' · 1 retry' : ` · ${fallbacks} retries`
  const pill = `${trace.bars.length} upstream ${trace.bars.length === 1 ? 'call' : 'calls'} · ${formatDuration(trace.totalMs)}${retry}`
  return (
    <details class="disclosure">
      <summary>
        <span class={KUMO_BADGE}>{pill}</span>
      </summary>
      {fallbacks > 0 ? <Banner tone="alert">filter tree:0 was rejected. ply retried with blob:none. The calls are serial, which is why the waterfall is a staircase.</Banner> : null}
      {trace.bars.map(bar => {
        const left = Math.max(0, Math.min(LAYOUT.percentSteps, Math.round((bar.startMs / span) * LAYOUT.percentSteps)))
        let width = Math.max(bar.durMs > 0 ? 1 : 0, Math.round((bar.durMs / span) * LAYOUT.percentSteps))
        if (left + width > LAYOUT.percentSteps) width = Math.max(1, LAYOUT.percentSteps - left)
        const failed = bar.status === 'error' || (bar.httpStatus !== null && bar.httpStatus >= 400)
        const bits = [
          formatDuration(bar.durMs),
          bar.httpStatus === null ? '' : `HTTP ${bar.httpStatus}`,
          bar.bytes === null ? '' : formatBytes(bar.bytes),
          bar.cache && bar.cache !== 'n/a' ? bar.cache : '',
        ].filter(bit => bit.length > 0)
        const tip = `${traceLabel(bar.name)} · ${bits.join(' · ')}`
        return (
          <details class={failed ? 'err' : undefined}>
            <summary class="trace-row">
              <span>
                <span class="trace-name">{traceLabel(bar.name)}</span>
                <span class="trace-meta">
                  {bits.join(' · ')}
                  {bar.packWant && bar.packFilter ? <> <a href={viewerHref(props.host, props.repoPath, { ref: props.ref ?? undefined, want: bar.packWant, filter: bar.packFilter })}>pack map</a></> : null}
                </span>
              </span>
              <span class="track" title={tip}><span class={`bar ${barClass(bar)} ${percentClass('o', left)} ${percentClass('w', width)}`}></span></span>
            </summary>
            <pre class="detail">{bar.lines.join('\n')}</pre>
          </details>
        )
      })}
    </details>
  )
}

export function Footer(props: { trace: TraceModel }) {
  const caps = VIEWER_CAPS
  return (
    <footer class="site-footer">
      <div>cf-ray {props.trace.cfRay || 'n/a'} · request {props.trace.requestId || 'n/a'}</div>
      <details>
        <summary>Limits</summary>
        <p class="note">
          {formatBytes(caps.maxUpstreamBytes)} upstream/page · {formatBytes(caps.maxPackBytes)} pack · {caps.maxPackObjects} objects · {formatBytes(caps.maxFileDisplayBytes)} file · chain {caps.maxDeltaChain} · {caps.maxSubrequests} subrequests · {caps.requestTimeoutMs / LAYOUT.msPerSecond}s/call · {caps.pageTimeoutMs / LAYOUT.msPerSecond}s/page · {caps.ratePerMinute}/min page · {caps.packRatePerMinute}/min pack.
        </p>
      </details>
    </footer>
  )
}

export function Signed() {
  return <span class={KUMO_BADGE_SUCCESS}>Signed</span>
}

export { KUMO_BADGE }
