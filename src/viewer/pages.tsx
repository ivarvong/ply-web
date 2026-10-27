import { rawSafe } from './safehtml.ts'
import { ALLOWED_HOSTS, viewerHref } from './url.ts'
import { VIEWER_CAPS } from './limits.ts'
import { renderMarkdown } from './markdown.ts'
import type { CommitInfo, RepoHeader, TraceModel } from './model.ts'
import type { PackObjectView } from './packmap.ts'
import type { FileLoaded, PackLoaded, TreeLoaded, ViewerDocument } from './document.ts'
import { commitProse, formatBytes, percentClass, portions, shortOid } from './format.ts'
import { LAYOUT } from './layout.ts'
import { KUMO_INPUT, KUMO_SURFACE } from './kumo-classes.ts'
import { Banner, Button, Document, Footer, IconFile, IconFolder, Protocol, Signed, Time, Toolbar } from './ui.tsx'

const EXAMPLES = [
  ['octocat/Hello-World', '/view/github.com/octocat/Hello-World'],
  ['sindresorhus/is', '/view/github.com/sindresorhus/is'],
  ['tj/commander.js', '/view/github.com/tj/commander.js'],
] as const

const PACK_SWATCH: Record<string, string> = {
  header: 'bg-kumo-fill',
  commit: 'bg-kumo-info',
  tree: 'bg-kumo-success',
  blob: 'bg-neutral-500',
  tag: 'bg-kumo-badge-purple',
  ofs_delta: 'bg-kumo-warning',
  ref_delta: 'bg-kumo-danger',
  trailer: 'bg-kumo-fill',
}

function repoName(repoPath: string): string {
  return repoPath.replace(/\.git$/, '')
}

function Home(props: { error: string | null }) {
  const caps = VIEWER_CAPS
  return (
    <>
      <p class="note">Read-only · no credentials</p>
      <h1 class="display">Read a public git repository</h1>
      <p class="lede">Paste a URL, <span class="mono">github.com/owner/repo</span>, or <span class="mono">owner/repo</span>. A username or password in the URL is rejected and never forwarded.</p>
      {props.error ? <Banner tone="error">{props.error}</Banner> : null}
      <form class="stack-form" action="/view" method="get">
        <input class={`control ${KUMO_INPUT}`} type="text" name="remote" required placeholder="octocat/Hello-World" aria-label="Git URL" autofocus autocomplete="off" spellcheck={false} />
        <Button variant="primary" size="base">Open</Button>
      </form>
      <nav class="chips" aria-label="Example repositories">
        {EXAMPLES.map(([label, href]) => <a class="chip" href={href}>{label}</a>)}
      </nav>
      <div class="steps">
        <div class="step"><strong>Paste</strong><span>A public https URL on an allowlisted host.</span></div>
        <div class="step"><strong>Browse</strong><span>Branches, trees, and files, rendered on the server.</span></div>
        <div class="step"><strong>Inspect</strong><span>The pack map shows how the server deltified the objects.</span></div>
      </div>
      <div class="card-grid">
        <section class={`${KUMO_SURFACE} pad`}>
          <h2>Supported hosts</h2>
          <ul class="host-list">{ALLOWED_HOSTS.map(host => <li>{host}</li>)}</ul>
          <p class="note">https, no username or password, port 443. A trailing dot or a lookalike host is rejected.</p>
        </section>
        <section class={`${KUMO_SURFACE} pad`} id="limits">
          <h2>Limits</h2>
          <dl class="limits">
            <div><dt>Upstream</dt><dd>{formatBytes(caps.maxUpstreamBytes)} / page</dd></div>
            <div><dt>Pack</dt><dd>{formatBytes(caps.maxPackBytes)} · {caps.maxPackObjects} objects</dd></div>
            <div><dt>File</dt><dd>{formatBytes(caps.maxFileDisplayBytes)}</dd></div>
            <div><dt>Calls</dt><dd>{caps.maxSubrequests} · {caps.requestTimeoutMs / LAYOUT.msPerSecond}s each</dd></div>
            <div><dt>Page</dt><dd>{caps.pageTimeoutMs / LAYOUT.msPerSecond}s</dd></div>
            <div><dt>Rate</dt><dd>{caps.ratePerMinute}/min · packs {caps.packRatePerMinute}/min</dd></div>
          </dl>
        </section>
      </div>
    </>
  )
}

function CommitBlock(props: { commit: CommitInfo; header: RepoHeader; now: number }) {
  const prose = commitProse(props.commit.message)
  const subject = prose.subject || '(no message)'
  return (
    <header class="commit-bar">
      <div class="commit-by">
        <a class="mono" href={viewerHref(props.header.host, props.header.repoPath, { ref: props.commit.oid })}>{shortOid(props.commit.oid)}</a>
        <span>{props.commit.authorName}</span>
        <Time iso={props.commit.authorTime} tz={props.commit.authorTz} now={props.now} />
        {props.commit.signed ? <Signed /> : null}
      </div>
      <h2 class="subject">{subject}</h2>
      {prose.paragraphs.length ? <div class="prose">{prose.paragraphs.map(paragraph => <p>{paragraph}</p>)}</div> : null}
    </header>
  )
}

function TreePage(props: { loaded: TreeLoaded; trace: TraceModel; now: number }) {
  const { header } = props.loaded
  const more = props.loaded.entriesTruncated
    ? <p class="note pad">Showing {props.loaded.entries.length} of {props.loaded.entries.length + props.loaded.entriesTruncated} entries.</p>
    : null
  return (
    <Document title={`${repoName(header.repoPath)} at ${header.ref}`}>
      <Toolbar header={header} path={props.loaded.path} branches={props.loaded.branches} />
      <h1 class="repo">{repoName(header.repoPath)}</h1>
      <div class="meta-row">
        <Protocol header={header} />
        <nav class="pack-links" aria-label="Pack maps">
          <a href={viewerHref(header.host, header.repoPath, { ref: header.ref, want: header.commit, filter: 'tree:0' })}>tree:0 pack</a>
          <span aria-hidden="true">·</span>
          <a href={viewerHref(header.host, header.repoPath, { ref: header.ref, want: header.commit, filter: 'blob:none' })}>blob:none pack</a>
        </nav>
      </div>
      <section class={KUMO_SURFACE}>
        <CommitBlock commit={props.loaded.commit} header={header} now={props.now} />
        {more}
        {props.loaded.entries.length === 0 ? <p class="note pad">This directory is empty.</p> : (
          <table class="files">
            <thead><tr><th>Name</th><th class="oid">Object</th></tr></thead>
            <tbody>
              {props.loaded.entries.map(entry => {
                const child = props.loaded.path ? `${props.loaded.path}/${entry.name}` : entry.name
                const label = entry.type === 'tree' ? `${entry.name}/` : entry.name
                return (
                  <tr>
                    <td class="name">
                      <a href={viewerHref(header.host, header.repoPath, { ref: header.ref, path: child })}>
                        {entry.type === 'tree' ? <IconFolder /> : <IconFile />}
                        {label}
                      </a>
                    </td>
                    <td class="oid">{shortOid(entry.oid)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
      <Readme loaded={props.loaded} />
      <Log loaded={props.loaded} now={props.now} />
      <Footer trace={props.trace} host={header.host} repoPath={header.repoPath} ref={header.ref} />
    </Document>
  )
}

function Readme(props: { loaded: TreeLoaded }) {
  const readme = props.loaded.readme
  if (!readme) return null
  if ('tooBig' in readme) {
    return (
      <section class={`${KUMO_SURFACE} pad`}>
        <h2 class="subject">{readme.name}</h2>
        <Banner tone="alert">This README is binary or larger than {formatBytes(VIEWER_CAPS.maxFileDisplayBytes)}, so it is not rendered. Open the file to see the size.</Banner>
      </section>
    )
  }
  return (
    <section class={KUMO_SURFACE}>
      <div class="pad"><h2 class="subject">{readme.name}</h2></div>
      <div class="md">{rawSafe(renderMarkdown(readme.text))}</div>
    </section>
  )
}

function Log(props: { loaded: TreeLoaded; now: number }) {
  if (!props.loaded.log.length && !props.loaded.logStopped) return null
  return (
    <section>
      <h2 class="section-label">Recent commits</h2>
      {props.loaded.logStopped ? <p class="note">Log stopped: the subrequest budget was spent, or the server only honours blob:none.</p> : null}
      <ul class="log">
        {props.loaded.log.map(commit => (
          <li>
            <a class="sha" href={viewerHref(props.loaded.header.host, props.loaded.header.repoPath, { ref: commit.oid })}>{shortOid(commit.oid)}</a>
            <span class="msg">{(commit.message.split('\n')[0] ?? '').slice(0, LAYOUT.logSubjectChars)}</span>
            <Time iso={commit.authorTime} tz={commit.authorTz} now={props.now} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function FilePage(props: { loaded: FileLoaded; trace: TraceModel; now: number }) {
  const { header } = props.loaded
  const rawHref = viewerHref(header.host, header.repoPath, { ref: header.ref, path: props.loaded.path, raw: '1' })
  return (
    <Document title={props.loaded.path}>
      <Toolbar header={header} path={props.loaded.path} branches={[]} />
      <section class="code-surface">
        <header class="file-head">
          <span class="file-path">{props.loaded.path}</span>
          <span class="file-meta">
            <span><span class="meta-k">mode</span> <span class="mono">{props.loaded.mode}</span></span>
            <span class="meta-dot" aria-hidden="true">·</span>
            <span>{formatBytes(props.loaded.size)}</span>
            <span class="meta-dot" aria-hidden="true">·</span>
            <span><span class="meta-k">blob</span> <span class="mono" title={props.loaded.blob}>{shortOid(props.loaded.blob)}</span></span>
          </span>
          <a class="raw-link" href={rawHref}>Raw</a>
        </header>
        <FileBody loaded={props.loaded} rawHref={rawHref} />
      </section>
      <Protocol header={header} />
      <Footer trace={props.trace} host={header.host} repoPath={header.repoPath} ref={header.ref} />
    </Document>
  )
}

function FileBody(props: { loaded: FileLoaded; rawHref: string }) {
  const loaded = props.loaded
  if (loaded.note === 'submodule') return <div class="file-note"><Banner tone="info">This is a submodule (gitlink) {loaded.blob}. The blob is not in this repository.</Banner></div>
  if (loaded.note === 'too-big') return <div class="file-note"><Banner tone="alert">This file is {formatBytes(loaded.size)}, over the {formatBytes(VIEWER_CAPS.maxFileDisplayBytes)} display cap. It was not buffered. Open a smaller file, or fetch it with git.</Banner></div>
  if (loaded.note === 'binary') return <div class="file-note"><Banner tone="alert">Binary file, {formatBytes(loaded.size)}. Not shown as text. <a href={props.rawHref}>Download raw bytes</a> (not HTML).</Banner></div>
  const lines = (loaded.text ?? '').split('\n')
  if (loaded.text?.endsWith('\n')) lines.pop()
  const shown = lines.slice(0, VIEWER_CAPS.maxLineRows)
  return (
    <div class="code-wrap">
      {lines.length > shown.length ? <p class="note file-note">Showing {shown.length} of {lines.length} lines.</p> : null}
      <div class="code" role="table" aria-label="File contents">
        {shown.map((line, index) => {
          const n = index + 1
          return (
            <div class="line" id={`L${n}`}>
              <a class="ln" href={`#L${n}`} title={`Permalink to line ${n}`}>{n}</a>
              <span class="src">{line}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PackPage(props: { loaded: PackLoaded; trace: TraceModel; now: number }) {
  const map = props.loaded.map
  const header = props.loaded.header
  const selected = props.loaded.offset === null ? null : map.objects.find(obj => obj.offset === props.loaded.offset) ?? null
  const lengths = [map.headerLength, ...map.objects.map(obj => obj.length), map.trailerLength]
  const widths = portions(lengths)
  const choice = map.ofsDelta === 0 && map.refDelta === 0
    ? 'The server sent full objects only — no ofs-delta and no ref-delta.'
    : `The server used ${map.ofsDelta} ofs-delta and ${map.refDelta} ref-delta object${map.refDelta === 1 ? '' : 's'}.`
  const legend = ['header', 'commit', 'tree', 'blob', 'tag', 'ofs_delta', 'ref_delta', 'trailer'] as const
  return (
    <Document title={`pack ${shortOid(props.loaded.want)}`}>
      <Toolbar header={header} path="" branches={[]} />
      <h1 class="repo">Pack map</h1>
      <Protocol header={header} />
      <div class="stats">
        <span><strong>{map.count}</strong> {map.count === 1 ? 'object' : 'objects'}</span>
        <span><strong>{formatBytes(map.bytes)}</strong></span>
        <span>version {map.version}</span>
        <span>max chain {map.maxChain}</span>
        <span>{map.thin ? 'thin pack' : 'not thin'}</span>
      </div>
      <p class="note">want <span class="mono">{shortOid(props.loaded.want)}</span> · asked {props.loaded.filterRequested} · honoured {props.loaded.filterHonoured} · client asked for ofs-delta and did not ask for a thin pack</p>
      <p class="note">{choice} Choose a segment to jump to its row.</p>
      <div class="legend">
        {legend.map(name => <span><i class={`sw ${PACK_SWATCH[name] ?? ''}`}></i>{name.replace('_', ' ')}</span>)}
      </div>
      <div class="packbar" role="img" aria-label="Pack layout by object type">
        <PackSegment cls={PACK_SWATCH.header ?? ''} width={widths[0] ?? 0} offset={null} tip={`pack header · ${formatBytes(map.headerLength)}`} />
        {map.objects.map((obj, index) => (
          <PackSegment
            cls={PACK_SWATCH[obj.wireType] ?? ''}
            width={widths[index + 1] ?? 0}
            offset={obj.offset}
            on={selected?.offset === obj.offset}
            tip={`${obj.wireType.replaceAll('_', ' ')} @${obj.offset} · ${formatBytes(obj.compressed)} compressed · ${formatBytes(obj.inflated)} inflated${obj.baseOffset !== null ? ` · base @${obj.baseOffset}` : ''}`}
          />
        ))}
        <PackSegment cls={PACK_SWATCH.trailer ?? ''} width={widths[widths.length - 1] ?? 0} offset={null} tip={`checksum trailer · ${formatBytes(map.trailerLength)}`} />
      </div>
      {selected ? <ObjectDetail obj={selected} /> : <p class="note">Select a region to inspect that object.</p>}
      <section class={KUMO_SURFACE}>
        <div class="pack-list">
          {map.objects.map(obj => {
            const wire = obj.wireType.replaceAll('_', ' ')
            const resolved = obj.resolvedType && obj.resolvedType !== obj.wireType ? obj.resolvedType : ''
            const object = obj.oid ? shortOid(obj.oid) : obj.baseOid ? `base ${shortOid(obj.baseOid)}` : obj.baseOffset !== null ? `@${obj.baseOffset}` : ''
            return (
              <div id={`o${obj.offset}`} data-base={obj.baseOffset !== null ? String(obj.baseOffset) : undefined} class={selected?.offset === obj.offset ? 'pack-row on' : 'pack-row'}>
                <a class="pack-off" href={`#o${obj.offset}`}><span class="meta-k">offset</span>{obj.offset}</a>
                <span>{wire}{resolved ? ` · ${resolved}` : ''}</span>
                <span class="oid">{object}</span>
                <span class="sub">{formatBytes(obj.compressed)} compressed · {formatBytes(obj.inflated)} inflated · chain {obj.chain}</span>
              </div>
            )
          })}
        </div>
      </section>
      <h2 class="section-label">Delta chains</h2>
      <ul class="log">
        {map.links.length === 0 ? <li><span class="note">no deltas</span></li> : map.links.map(link => (
          <li>
            <a href={`#o${link.deltaOffset}`}>delta @{link.deltaOffset}</a>
            <span class="msg">{link.baseOffset !== null ? <a href={`#o${link.baseOffset}`}>base @{link.baseOffset}</a> : <>base {shortOid(link.baseOid ?? '')}</>} · depth {link.depth}</span>
          </li>
        ))}
      </ul>
      <Footer trace={props.trace} host={header.host} repoPath={header.repoPath} ref={header.ref} />
    </Document>
  )
}

function PackSegment(props: { cls: string; width: number; offset: number | null; tip: string; on?: boolean }) {
  if (!props.width) return null
  const klass = `${props.cls} ${percentClass('w', props.width)}${props.on ? ' on' : ''}`
  if (props.offset === null) return <span class={klass} title={props.tip}></span>
  return <a class={klass} href={`#o${props.offset}`} title={props.tip} aria-label={props.tip}></a>
}

function ObjectDetail(props: { obj: PackObjectView }) {
  const obj = props.obj
  const preview = obj.preview
  return (
    <section class={`${KUMO_SURFACE} pad`} id={`detail-${obj.offset}`}>
      <h2 class="subject">Object at {obj.offset}</h2>
      <p>wire {obj.wireType.replace('_', ' ')} · resolved {obj.resolvedType ?? 'unresolved'} · oid <span class="mono">{obj.oid ?? 'n/a'}</span></p>
      <p class="note">header {formatBytes(obj.headerBytes)} · compressed {formatBytes(obj.compressed)} · inflated {formatBytes(obj.inflated)} · chain {obj.chain}{obj.baseOffset !== null ? ` · base @${obj.baseOffset}` : ''}{obj.baseOid ? ` · base ${shortOid(obj.baseOid)}` : ''}</p>
      {preview?.kind === 'commit' ? <p>{preview.summary}<span class="note"> tree {shortOid(preview.tree)} · parents {preview.parents.map(shortOid).join(' ') || 'none'}</span></p> : null}
      {preview?.kind === 'tree' ? <p class="note">{preview.names.join(', ') || '(empty tree)'}</p> : null}
      {preview?.kind === 'blob' ? (preview.text !== null ? <pre class="detail">{preview.text}</pre> : <p>Binary or large blob, {formatBytes(obj.inflated)} inflated.</p>) : null}
      {preview?.kind === 'tag' ? <pre class="detail">{preview.text}</pre> : null}
      {preview?.kind === 'unresolved' ? <p>The delta base is not in this pack.</p> : null}
    </section>
  )
}

function errorTitle(code: string, status: number): string {
  if (code === 'rate_limited' || status === 429) return 'Too many requests'
  if (code === 'not_found' || status === 404) return 'Not found'
  if (code === 'limit_exceeded' || status === 413) return 'Too big for this viewer'
  if (code === 'timeout' || status === 504) return 'The git host timed out'
  if (code === 'unavailable' || status === 503) return 'Viewer unavailable'
  if (code === 'bad_request' || status === 400) return 'That URL is not supported'
  return 'Something went wrong'
}

function errorHint(code: string, status: number, message: string): string {
  if (code === 'rate_limited' || status === 429) return 'Wait for the retry window, then open the repository again. The limit is per client.'
  if (code === 'unavailable' || status === 503) return 'The rate limiter is not available, so the viewer stops rather than fetching without a limit.'
  if (code === 'limit_exceeded' || status === 413) return 'Open a smaller path or a single file. Huge repositories and packs are refused on purpose.'
  if (code === 'timeout' || status === 504) return 'The git host did not answer in time. Try the same URL again.'
  if (code === 'not_found' || status === 404) return 'Check the owner, repository, branch, and path. Private repositories are not visible here.'
  if (/credentials/.test(message)) return 'Remove the username and password from the URL and paste it again. Credentials are never forwarded.'
  if (/allowlisted|Supported hosts/.test(message)) return 'Use one of the supported hosts. owner/repo by itself means github.com.'
  return 'Go back to the viewer and paste a public repository URL.'
}

function errorTone(code: string, status: number): 'alert' | 'info' {
  if (code === 'not_found' || status === 404) return 'info'
  return 'alert'
}

function supportedHosts(message: string): readonly string[] {
  const marker = 'Supported hosts:'
  const at = message.indexOf(marker)
  if (at < 0) return []
  return message.slice(at + marker.length).replace(/\.$/, '').split(',').map(host => host.trim()).filter(host => host.length > 0)
}

function ErrorPage(props: Extract<ViewerDocument, { kind: 'error' }>) {
  const title = errorTitle(props.code, props.status)
  const hosts = supportedHosts(props.message)
  return (
    <Document title={title}>
      <article class={`${KUMO_SURFACE} error-card`}>
        <p class="error-kicker">HTTP {props.status}</p>
        <h1 class="display">{title}</h1>
        <Banner tone={errorTone(props.code, props.status)}>{errorHint(props.code, props.status, props.message)}</Banner>
        {hosts.length ? <ul class="host-list" aria-label="Supported hosts">{hosts.map(host => <li>{host}</li>)}</ul> : null}
        <p class="lede"><a href="/view">Back to the viewer</a></p>
        <details class="reason">
          <summary>Why this was refused</summary>
          <p>{props.message}</p>
        </details>
      </article>
      <Footer trace={props.trace} host={props.host} repoPath={props.repoPath} ref={props.ref} />
    </Document>
  )
}

export function ViewerPage(props: { doc: ViewerDocument }) {
  const doc = props.doc
  if (doc.kind === 'home') {
    return (
      <Document title="ply viewer">
        <Home error={doc.error} />
      </Document>
    )
  }
  if (doc.kind === 'tree') return <TreePage loaded={doc.loaded} trace={doc.trace} now={doc.now} />
  if (doc.kind === 'file') return <FilePage loaded={doc.loaded} trace={doc.trace} now={doc.now} />
  if (doc.kind === 'pack') return <PackPage loaded={doc.loaded} trace={doc.trace} now={doc.now} />
  return <ErrorPage {...doc} />
}
