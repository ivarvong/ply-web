import { rawSafe } from './safehtml.ts'
import { ALLOWED_HOSTS, viewerHref } from './url.ts'
import { VIEWER_CAPS } from './limits.ts'
import { classifyHref, renderMarkdown, type MarkdownOptions } from './markdown.ts'
import type { CommitInfo, RepoHeader, TraceModel, TreeEntry } from './model.ts'
import type { PackObjectView } from './packmap.ts'
import type { FileLoaded, PackLoaded, TreeLoaded, ViewerDocument } from './document.ts'
import { commitProse, formatBytes, percentClass, portions, shortOid } from './format.ts'
import { LAYOUT } from './layout.ts'
import { KUMO_BUTTON_FOCUS, KUMO_BUTTON_SECONDARY, KUMO_BUTTON_SIZE_SM, KUMO_INPUT, KUMO_SURFACE } from './kumo-classes.ts'
import { repoIdentity } from './identity.ts'
import { Badge, Banner, Button, Card, Diagnostics, Document, Footer, Icon, PathCrumbs, RepoIdentity, RepoTitle, Signed, Time } from './ui.tsx'
import { PUBLIC_NAMESPACE } from '../public.ts'

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

function PublicRepos(props: { repos: readonly string[] }) {
  return (
    <Card id="public" head={<><Icon name="book" /><span class="card-title">Public repositories</span><span class="card-count">{PUBLIC_NAMESPACE}</span></>}>
      {props.repos.length
        ? <ul class="repo-list">{props.repos.map(name => <li><a href={`/r/${encodeURIComponent(name)}`}><Icon name="dir" />{name}<span class="go">/r/{name}</span></a></li>)}</ul>
        : <p class="empty">The repository list is unavailable right now. Try <a href="/r/ply">/r/ply</a>.</p>}
      <p class="empty">Served read-only from the <span class="mono">{PUBLIC_NAMESPACE}</span> Artifacts namespace. No token needed.</p>
    </Card>
  )
}

function Home(props: { error: string | null; publicRepos: readonly string[] }) {
  const caps = VIEWER_CAPS
  return (
    <>
      <div class="hero">
        <p class="kicker">Read-only · no credentials</p>
        <h1 class="display">Read a public git repository</h1>
        <p class="lede">Paste a URL, <span class="mono">github.com/owner/repo</span>, or <span class="mono">owner/repo</span>. Pages are rendered on the server straight from the git wire protocol, with no clone.</p>
        <form class="stack-form" action="/view" method="get">
          <input class={`control ${KUMO_INPUT}`} type="text" name="remote" required placeholder="octocat/Hello-World" aria-label="Git URL" autocomplete="off" autocapitalize="off" spellcheck={false} />
          <Button variant="primary" size="base">Open</Button>
        </form>
        {props.error ? <div class="note"><Banner tone="error">{props.error}</Banner></div> : null}
        <nav class="chips" aria-label="Example repositories">
          {EXAMPLES.map(([label, href]) => <a class="chip" href={href}>{label}</a>)}
        </nav>
      </div>
      <PublicRepos repos={props.publicRepos} />
      <div class="steps">
        <div class="step"><strong>Paste</strong><span>A public https URL on an allowlisted host. A username or password in the URL is rejected and never forwarded.</span></div>
        <div class="step"><strong>Browse</strong><span>Branches, trees, files and READMEs, rendered on the server.</span></div>
        <div class="step"><strong>Inspect</strong><span>Every page lists its git round trips; the pack map shows how the server deltified objects.</span></div>
      </div>
      <div class="card-grid">
        <Card head={<span class="card-title">Supported hosts</span>}>
          <div class="pad">
            <ul class="host-list">{ALLOWED_HOSTS.map(host => <li>{host}</li>)}</ul>
            <p class="note">https, no username or password, port 443. A trailing dot or a lookalike host is rejected.</p>
          </div>
        </Card>
        <Card id="limits" head={<span class="card-title">Limits</span>}>
          <dl class="limits pad">
            <div><dt>Upstream</dt><dd>{formatBytes(caps.maxUpstreamBytes)} / page</dd></div>
            <div><dt>Pack</dt><dd>{formatBytes(caps.maxPackBytes)} · {caps.maxPackObjects} objects</dd></div>
            <div><dt>File</dt><dd>{formatBytes(caps.maxFileDisplayBytes)}</dd></div>
            <div><dt>Calls</dt><dd>{caps.maxSubrequests} · {caps.requestTimeoutMs / LAYOUT.msPerSecond}s each</dd></div>
            <div><dt>Page</dt><dd>{caps.pageTimeoutMs / LAYOUT.msPerSecond}s</dd></div>
            <div><dt>Rate</dt><dd>{caps.ratePerMinute}/min · packs {caps.packRatePerMinute}/min</dd></div>
          </dl>
        </Card>
      </div>
    </>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(part => part.length > 0)
  const first = parts[0]?.[0] ?? '?'
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : ''
  return (first + last).toUpperCase()
}

function Avatar(props: { name: string }) {
  return <span class="avatar" aria-hidden="true">{initials(props.name)}</span>
}

function TrailerValue(props: { value: string }) {
  const email = /^(.*?)\s*<[^>]+>$/.exec(props.value)
  if (email?.[1]) return <span title={props.value}>{email[1]}</span>
  const href = /^https:\/\/\S+$/.test(props.value) ? classifyHref(props.value) : null
  return href ? <a href={href} rel="noopener noreferrer nofollow">{props.value}</a> : <span>{props.value}</span>
}

function CommitMessage(props: { message: string }) {
  const prose = commitProse(props.message)
  if (!prose.paragraphs.length && !prose.trailers.length) return null
  return (
    <div class="msg-body">
      {prose.paragraphs.map(paragraph => <p class="msg-p">{paragraph}</p>)}
      {prose.trailers.length ? (
        <dl class="trailers">
          {prose.trailers.map(trailer => <div><dt>{trailer.key}</dt><dd><TrailerValue value={trailer.value} /></dd></div>)}
        </dl>
      ) : null}
    </div>
  )
}

/** The card header: who, when, which commit; the subject, and the full message one tap away. */
function CommitHead(props: { commit: CommitInfo; header: RepoHeader; now: number }) {
  const prose = commitProse(props.commit.message)
  const subject = prose.subject || '(no message)'
  const hasBody = prose.paragraphs.length > 0 || prose.trailers.length > 0
  return (
    <div class="lc" data-commit={props.commit.oid}>
      <div class="lc-by">
        <Avatar name={props.commit.authorName} />
        <span class="lc-author">{props.commit.authorName || 'unknown'}</span>
        <Time iso={props.commit.authorTime} tz={props.commit.authorTz} now={props.now} />
        <span class="lc-right">
          {props.commit.signed ? <Signed /> : null}
          <a class="sha" href={viewerHref(props.header.host, props.header.repoPath, { ref: props.commit.oid })} title={props.commit.oid}>{shortOid(props.commit.oid)}</a>
        </span>
      </div>
      {hasBody ? (
        <details class="lc-msg">
          <summary><span class="lc-subject">{subject}</span><span class="more" aria-label="Show the full message">···</span></summary>
          <CommitMessage message={props.commit.message} />
        </details>
      ) : <p class="lc-subject lc-only">{subject}</p>}
    </div>
  )
}

function EntryIcon(props: { entry: TreeEntry }) {
  if (props.entry.type === 'tree') return <Icon name="dir" />
  if (props.entry.mode === '160000') return <Icon name="module" class="i-module" />
  if (props.entry.mode === '120000') return <Icon name="link" />
  return <Icon name="file" />
}

function EntryNote(props: { entry: TreeEntry }) {
  if (props.entry.mode === '160000') return <Badge tone="neutral">submodule</Badge>
  if (props.entry.mode === '120000') return <Badge tone="neutral">symlink</Badge>
  if (props.entry.mode === '100755') return <Badge tone="neutral">exec</Badge>
  return null
}

function parentPath(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

function TreePage(props: { loaded: TreeLoaded; trace: TraceModel; now: number }) {
  const { header } = props.loaded
  const id = repoIdentity(header.host, header.repoPath)
  const path = props.loaded.path
  const count = props.loaded.entries.length + props.loaded.entriesTruncated
  return (
    <Document title={path ? `${path} · ${id.name}` : `${id.scope ? `${id.scope}/` : ''}${id.name}`}>
      <RepoTitle header={header} path={path} branches={props.loaded.branches} tags={props.loaded.tags} />
      <PathCrumbs header={header} path={path} />
      <Card head={<CommitHead commit={props.loaded.commit} header={header} now={props.now} />} class="tree-card">
        {props.loaded.entries.length === 0 && !path ? <p class="empty">This directory is empty.</p> : (
          // Stable scraping contract (README "Machine-readable markup"): one li[data-oid] per entry shown.
          <ul class="files" aria-label={`${count} ${count === 1 ? 'entry' : 'entries'}`} data-path={path} data-entries={String(count)} data-shown={String(props.loaded.entries.length)}>
            {path ? (
              <li><a class="row" href={viewerHref(header.host, header.repoPath, { ref: header.ref, path: parentPath(path) || undefined })} aria-label="Parent directory">
                <Icon name="up" /><span class="name">..</span>
              </a></li>
            ) : null}
            {props.loaded.entries.map(entry => {
              const child = path ? `${path}/${entry.name}` : entry.name
              return (
                <li data-oid={entry.oid} data-mode={entry.mode} data-type={entry.type} data-name={entry.name}><a class="row" href={viewerHref(header.host, header.repoPath, { ref: header.ref, path: child })}>
                  <EntryIcon entry={entry} />
                  <span class="name">{entry.name}</span>
                  <EntryNote entry={entry} />
                  <span class="oid" title={entry.oid}>{shortOid(entry.oid)}</span>
                </a></li>
              )
            })}
          </ul>
        )}
        {props.loaded.entriesTruncated ? <p class="empty">Showing {props.loaded.entries.length} of {count} entries.</p> : null}
      </Card>
      <Readme loaded={props.loaded} />
      <Log loaded={props.loaded} now={props.now} />
      <Diagnostics trace={props.trace} header={header} open={props.trace.expanded} />
    </Document>
  )
}

function markdownOptions(header: RepoHeader, docPath: string): MarkdownOptions {
  return {
    base: parentPath(docPath),
    resolve: (path, kind) => viewerHref(header.host, header.repoPath, { ref: header.ref, path: path || undefined, raw: kind === 'image' ? '1' : undefined }),
  }
}

function Readme(props: { loaded: TreeLoaded }) {
  const readme = props.loaded.readme
  if (!readme) return null
  const header = props.loaded.header
  const docPath = props.loaded.path ? `${props.loaded.path}/${readme.name}` : readme.name
  const head = (
    <>
      <Icon name="book" />
      <a class="card-title" href={viewerHref(header.host, header.repoPath, { ref: header.ref, path: docPath })}>{readme.name}</a>
    </>
  )
  if ('tooBig' in readme) {
    return (
      <Card head={head}>
        <div class="pad"><Banner tone="alert">This README is binary or larger than {formatBytes(VIEWER_CAPS.maxFileDisplayBytes)}, so it is not rendered. Open the file to see the size.</Banner></div>
      </Card>
    )
  }
  return (
    <Card head={head}>
      <article class="md">{rawSafe(renderMarkdown(readme.text, markdownOptions(header, docPath)))}</article>
    </Card>
  )
}

function subjectOf(message: string): string {
  return (message.split('\n')[0] ?? '').slice(0, LAYOUT.logSubjectChars) || '(no message)'
}

function Log(props: { loaded: TreeLoaded; now: number }) {
  const log = props.loaded.log
  if (!log.length) return null
  const header = props.loaded.header
  return (
    <Card head={<><Icon name="history" /><span class="card-title">Recent commits</span><span class="card-count">{log.length}</span></>}>
      <ol class="log">
        {log.map(commit => (
          <li><a class="log-row" href={viewerHref(header.host, header.repoPath, { ref: commit.oid })}>
            <span class="log-subject">{subjectOf(commit.message)}</span>
            <span class="log-meta">
              <span class="sha">{shortOid(commit.oid)}</span>
              <span class="dot-sep" aria-hidden="true">·</span>
              <span class="log-author">{commit.authorName}</span>
              <span class="dot-sep" aria-hidden="true">·</span>
              <Time iso={commit.authorTime} tz={commit.authorTz} now={props.now} />
            </span>
          </a></li>
        ))}
      </ol>
      {props.loaded.logStopped ? <p class="empty">Older history is not loaded on this page. Open the oldest commit above to keep going.</p> : null}
    </Card>
  )
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path)
}

function FilePage(props: { loaded: FileLoaded; trace: TraceModel; now: number }) {
  const { header } = props.loaded
  const id = repoIdentity(header.host, header.repoPath)
  const rawHref = viewerHref(header.host, header.repoPath, { ref: header.ref, path: props.loaded.path, raw: '1' })
  const name = props.loaded.path.split('/').pop() ?? props.loaded.path
  const text = props.loaded.note === 'text' ? props.loaded.text ?? '' : null
  const lineCount = text === null ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  const md = text !== null && isMarkdown(props.loaded.path)
  const head = (
    <>
      <span class="file-meta">
        {text !== null ? <span>{lineCount} {lineCount === 1 ? 'line' : 'lines'}</span> : null}
        <span>{formatBytes(props.loaded.size)}</span>
        {props.loaded.mode !== '100644' ? <Badge tone="neutral">{props.loaded.mode === '100755' ? 'executable' : props.loaded.mode}</Badge> : null}
      </span>
      {md ? (
        <nav class="seg-tabs" aria-label="View">
          <a href="#preview" class="tab tab-preview">Preview</a>
          <a href="#code" class="tab tab-code">Code</a>
        </nav>
      ) : null}
      <a class={`raw-link ${KUMO_BUTTON_SIZE_SM} ${KUMO_BUTTON_SECONDARY} ${KUMO_BUTTON_FOCUS}`} href={rawHref}><Icon name="raw" />Raw</a>
    </>
  )
  return (
    <Document title={`${name} · ${id.name}`}>
      <RepoTitle header={header} path={props.loaded.path} branches={props.loaded.branches} tags={props.loaded.tags} />
      <PathCrumbs header={header} path={props.loaded.path} />
      <Card head={head} class={md ? 'file-card has-md' : 'file-card'}>
        {md ? <span id="preview" class="anchor"></span> : null}
        {md ? <article class="md md-view">{rawSafe(renderMarkdown(text ?? '', markdownOptions(header, props.loaded.path)))}</article> : null}
        {md ? <span id="code" class="anchor"></span> : null}
        <FileBody loaded={props.loaded} rawHref={rawHref} />
      </Card>
      <Diagnostics trace={props.trace} header={header} open={props.trace.expanded} />
    </Document>
  )
}

function FileBody(props: { loaded: FileLoaded; rawHref: string }) {
  const loaded = props.loaded
  if (loaded.note === 'submodule') return <div class="pad"><Banner tone="info">This is a submodule (gitlink) {loaded.blob}. The blob is not in this repository.</Banner></div>
  if (loaded.note === 'too-big') return <div class="pad"><Banner tone="alert">This file is {formatBytes(loaded.size)}, over the {formatBytes(VIEWER_CAPS.maxFileDisplayBytes)} display cap. It was not buffered. Open a smaller file, or fetch it with git.</Banner></div>
  if (loaded.note === 'binary') return <div class="pad"><Banner tone="alert">Binary file, {formatBytes(loaded.size)}. Not shown as text. <a href={props.rawHref}>Download raw bytes</a> (not HTML).</Banner></div>
  const lines = (loaded.text ?? '').split('\n')
  if (loaded.text?.endsWith('\n')) lines.pop()
  const shown = lines.slice(0, VIEWER_CAPS.maxLineRows)
  return (
    <div class="code-wrap">
      {lines.length > shown.length ? <p class="empty">Showing {shown.length} of {lines.length} lines.</p> : null}
      <div class="code-bar">
        <label class="wrap-toggle"><input type="checkbox" /> Wrap lines</label>
      </div>
      <div class="code" tabIndex={0} role="table" aria-label="File contents">
        {shown.map((line, index) => {
          const n = index + 1
          return (
            <div class="line" id={`L${n}`}>
              <a class="ln" href={`#L${n}`} aria-label={`Line ${n}`}>{n}</a>
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
      <RepoTitle header={header} path="" branches={[]} tags={[]} />
      <h2 class="section-title">Pack map</h2>
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
      <ul class="plain-list">
        {map.links.length === 0 ? <li><span class="note">no deltas</span></li> : map.links.map(link => (
          <li>
            <a href={`#o${link.deltaOffset}`}>delta @{link.deltaOffset}</a>
            <span class="msg">{link.baseOffset !== null ? <a href={`#o${link.baseOffset}`}>base @{link.baseOffset}</a> : <>base {shortOid(link.baseOid ?? '')}</>} · depth {link.depth}</span>
          </li>
        ))}
      </ul>
      <Diagnostics trace={props.trace} header={header} open={props.trace.expanded} />
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
    <section class={`${KUMO_SURFACE} surface-pad`} id={`detail-${obj.offset}`}>
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
  if (code === 'auth' || status === 401 || status === 403) return 'Repository not found, or private'
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
  if (code === 'not_found' || status === 404 || code === 'auth' || status === 401 || status === 403) return 'Check the owner, repository, branch, and path. Private repositories are not visible here (GitHub answers 401 for both).'
  if (/credentials/.test(message)) return 'Remove the username and password from the URL and paste it again. Credentials are never forwarded.'
  if (/allowlisted|Supported hosts/.test(message)) return 'Use one of the supported hosts. owner/repo by itself means github.com.'
  return 'Go back to the viewer and paste a public repository URL.'
}

function errorTone(code: string, status: number): 'alert' | 'info' {
  if (code === 'not_found' || status === 404 || code === 'auth' || status === 401 || status === 403) return 'info'
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
  const specific = props.part === 'repo' || props.part === 'ref' || props.part === 'path'
  const headline = specific ? props.summary : title
  const knownRepo = props.host.length > 0 && props.repoPath.length > 0
  return (
    <Document title={headline}>
      {knownRepo ? (
        <header class="repo-head">
          <RepoIdentity host={props.host} repoPath={props.repoPath} />
        </header>
      ) : null}
      {knownRepo && props.part !== 'ref' && props.ref ? <PathCrumbs header={{ host: props.host, repoPath: props.repoPath, ref: props.ref }} path={props.path} /> : null}
      <article class={`${KUMO_SURFACE} error-card`}>
        <p class="error-kicker">HTTP {props.status} · {props.part}</p>
        <h1 class="display">{headline}</h1>
        <Banner tone={errorTone(props.code, props.status)}>{errorHint(props.code, props.status, props.message)}</Banner>
        {hosts.length ? <ul class="host-list" aria-label="Supported hosts">{hosts.map(host => <li>{host}</li>)}</ul> : null}
        <p class="lede">{knownRepo ? <><a href={viewerHref(props.host, props.repoPath, {})}>Repository root</a> · </> : null}<a href="/view">Back to the viewer</a></p>
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
        <Home error={doc.error} publicRepos={doc.publicRepos ?? []} />
      </Document>
    )
  }
  if (doc.kind === 'tree') return <TreePage loaded={doc.loaded} trace={doc.trace} now={doc.now} />
  if (doc.kind === 'file') return <FilePage loaded={doc.loaded} trace={doc.trace} now={doc.now} />
  if (doc.kind === 'pack') return <PackPage loaded={doc.loaded} trace={doc.trace} now={doc.now} />
  if (doc.kind === 'namespace') {
    return (
      <Document title={`${PUBLIC_NAMESPACE} repositories`}>
        <div class="hero">
          <p class="kicker">Public namespace</p>
          <h1 class="display">{PUBLIC_NAMESPACE}</h1>
          <p class="lede">Read-only repositories in this namespace. Open one below, or paste any public repository on <a href="/view">the viewer</a>.</p>
        </div>
        <PublicRepos repos={doc.publicRepos} />
      </Document>
    )
  }
  return <ErrorPage {...doc} />
}
