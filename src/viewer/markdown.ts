// GitHub-flavoured markdown for README and .md files: headings, paragraphs with hard breaks, emphasis, strikethrough,
// inline and fenced code (with a language label), block quotes, nested and task lists, tables with alignment, rules,
// inline/reference/auto links, and images. Safety model: the source is only ever escaped as text; tags and class names
// come from fixed sets in safehtml.ts; a link becomes an anchor only when its URL passes classifyHref (or a
// repository-relative path that the caller resolves to a viewer URL). Raw HTML is shown as text. Images are links, not
// <img>: the viewer's CSP is img-src 'none', and a README must not make visitors' browsers fetch third-party pixels.
import { atIndex, captureGroup, mapGet, recordGet, textAt } from '../absent.ts';
import { find, unwrapOr } from '../option.ts';
import { anchor, concatHtml, escapeHtml, heading, orderedList, tag, voidTag, type MdClass, type SafeHtml } from './safehtml.ts';

function chAt(text: string, index: number): string {
  return unwrapOr(textAt(text, index), '');
}

function lineAt(lines: readonly string[], index: number): string {
  return unwrapOr(atIndex(lines, index), '');
}

function group(match: RegExpMatchArray | null, index: number, fallback = ''): string {
  return unwrapOr(captureGroup(match, index), fallback);
}

const NAMED: Record<string, string> = {
  quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", colon: ':', tab: '\t', newline: '\n',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi, (all, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = Number.parseInt(body.slice(2), 16);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return all;
      return String.fromCodePoint(cp);
    }
    if (body.startsWith('#')) {
      const cp = Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return all;
      return String.fromCodePoint(cp);
    }
    return unwrapOr(recordGet(NAMED, body.toLowerCase()), all);
  });
}

function obscured(value: string): boolean {
  // oxlint-disable-next-line no-control-regex -- controls and whitespace are scheme-obfuscation, not a URL
  if (/[\u0000-\u001f\u007f\s<>"'`\\]/.test(value)) return true;
  if (/[\u200b-\u200f\u202a-\u202e\ufeff]/.test(value)) return true;
  if (/%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(value)) return true;
  return false;
}

function schemeOf(value: string): 'http' | 'https' | 'mailto' | 'relative' | 'bad' {
  if (value.startsWith('//') || value.startsWith('\\') || value.includes('\\')) return 'bad';
  const colon = value.indexOf(':');
  if (colon === -1) {
    if (value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || /^[A-Za-z0-9]/.test(value)) return 'relative';
    return 'bad';
  }
  const scheme = value.slice(0, colon).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return 'bad';
  if (scheme === 'http' || scheme === 'https') {
    if (!value.slice(colon + 1).startsWith('//')) return 'bad';
    return scheme;
  }
  if (scheme === 'mailto') return 'mailto';
  return 'bad';
}

/** http, https, mailto, or a same-document relative URL. javascript:, data:, vbscript:, and obfuscations are null. */
export function classifyHref(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  if (obscured(raw)) return null;
  const decoded = decodeEntities(raw);
  if (decoded !== raw && (obscured(decoded) || schemeOf(decoded) === 'bad')) return null;
  const kind = schemeOf(raw);
  if (kind === 'bad') return null;
  if (kind === 'http' || kind === 'https') {
    let url: URL;
    try { url = new URL(raw); }
    catch { return null; }
    if (url.username || url.password) return null;
    if (url.protocol !== `${kind}:`) return null;
  }
  return raw;
}


export type MarkdownOptions = {
  /**
   * Resolve a repository-relative link (`docs/x.md`, `./a.png`, `../b`) to a viewer URL. The path is already joined
   * and normalised against the document's directory; null leaves the link as text. `image` asks for raw bytes.
   */
  readonly resolve: ((path: string, kind: 'link' | 'image') => string | null) | null;
  /** The document's directory inside the repository. Empty for the root. */
  readonly base: string;
};

const ROOT_OPTIONS: MarkdownOptions = { resolve: null, base: '' };

type Ctx = { opts: MarkdownOptions; refs: Map<string, string>; slugs: Map<string, number> };

const MAX_DEPTH = 8;
const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

// ── links ────────────────────────────────────────────────────────────────────────────────────────────────────────

function joinRepoPath(base: string, rel: string): string | null {
  const parts = base ? base.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

function hrefFor(raw: string, kind: 'link' | 'image', ctx: Ctx): string | null {
  const dest = raw.trim();
  const safe = classifyHref(dest);
  if (!safe) return null;
  const relative = !dest.startsWith('#') && !dest.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(dest);
  if (!relative || ctx.opts.resolve === null) return safe;
  const hash = dest.indexOf('#');
  const pathPart = unwrapOr(atIndex((hash === -1 ? dest : dest.slice(0, hash)).split('?'), 0), '');
  let decoded: string;
  try { decoded = decodeURIComponent(pathPart); } catch { return null; }
  const joined = joinRepoPath(ctx.opts.base, decoded);
  if (joined === null) return null;
  const resolved = ctx.opts.resolve(joined, kind);
  if (!resolved) return null;
  const frag = hash === -1 ? '' : dest.slice(hash);
  return classifyHref(frag && /^#[A-Za-z0-9_-]{1,80}$/.test(frag) ? `${resolved}${frag}` : resolved);
}

/** `(dest "title")` after `]`. Returns the destination and how many characters it used, or null. */
function linkTail(src: string, at: number): { dest: string; end: number } | null {
  if (src[at] !== '(') return null;
  let i = at + 1;
  while (src[i] === ' ') i++;
  let dest = '';
  if (src[i] === '<') {
    const close = src.indexOf('>', i);
    if (close === -1) return null;
    dest = src.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    const start = i;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\' && i + 1 < src.length) { i += 2; continue; }
      if (ch === ' ' || ch === '\t') break;
      if (ch === '(') depth++;
      if (ch === ')') { if (depth === 0) break; depth--; }
      i++;
    }
    dest = src.slice(start, i);
  }
  while (src[i] === ' ') i++;
  const q = src[i];
  if (q === '"' || q === "'") {
    const close = src.indexOf(q, i + 1);
    if (close === -1) return null;
    i = close + 1;
    while (src[i] === ' ') i++;
  }
  if (src[i] !== ')') return null;
  return { dest, end: i + 1 };
}

/** Index of the `]` that closes the `[` at `at`, honouring nesting, escapes and code spans. */
// Link labels longer than this are left as text, so a run of unclosed brackets stays linear.
const MAX_LABEL = 1_000;
const MAX_EMPHASIS = 4_000;

function closeBracket(src: string, at: number): number {
  let depth = 0;
  const stop = Math.min(src.length, at + MAX_LABEL);
  for (let i = at; i < stop; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '`') { const end = codeSpanEnd(src, i); if (end > 0) { i = end - 1; continue; } }
    if (ch === '[') depth++;
    if (ch === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function codeSpanEnd(src: string, at: number): number {
  let n = 0;
  while (src[at + n] === '`') n++;
  const fence = '`'.repeat(n);
  let from = at + n;
  for (;;) {
    const hit = src.indexOf(fence, from);
    if (hit === -1) return -1;
    if (src[hit + n] !== '`' && src[hit - 1] !== '`') return hit + n;
    from = hit + 1;
  }
}

function refKey(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ── inline ───────────────────────────────────────────────────────────────────────────────────────────────────────

function isWordChar(ch: string): boolean {
  return ch !== '' && /[\p{L}\p{N}]/u.test(ch);
}

function findCloser(src: string, from: number, delim: string): number {
  const stop = Math.min(src.length, from + MAX_EMPHASIS);
  for (let i = from; i < stop; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '`') { const end = codeSpanEnd(src, i); if (end > 0) { i = end - 1; continue; } }
    if (src.startsWith(delim, i) && i > from && !/\s/.test(unwrapOr(textAt(src, i - 1), ' '))) {
      if (delim.length === 1 && src[i + 1] === delim) { i++; continue; }
      if (delim[0] === '_' && isWordChar(chAt(src, i + delim.length))) continue;
      return i;
    }
  }
  return -1;
}

function inline(src: string, ctx: Ctx, inLink = false, depth = 0): SafeHtml {
  const out: SafeHtml[] = [];
  let text = '';
  const flush = () => { if (text) { out.push(escapeHtml(text)); text = ''; } };
  let i = 0;
  while (i < src.length) {
    const ch = chAt(src, i);
    const rest = src.slice(i);
    if (ch === '\\' && PUNCT.test(chAt(src, i + 1))) { text += src[i + 1]; i += 2; continue; }
    if (ch === '\\' && src[i + 1] === '\n') { flush(); out.push(voidTag('br')); i += 2; continue; }
    if (ch === '\n') {
      const hard = / {2,}$/.test(text);
      text = text.replace(/ +$/, '');
      flush();
      out.push(hard ? voidTag('br') : escapeHtml(' '));
      i++;
      while (src[i] === ' ') i++;
      continue;
    }
    if (ch === '`') {
      const end = codeSpanEnd(src, i);
      if (end > 0) {
        let n = 0;
        while (src[i + n] === '`') n++;
        let code = src.slice(i + n, end - n).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        flush();
        out.push(tag('code', escapeHtml(code), null));
        i = end;
        continue;
      }
      let n = 0;
      while (src[i + n] === '`') n++;
      text += src.slice(i, i + n);
      i += n;
      continue;
    }
    const image = ch === '!' && src[i + 1] === '[';
    if ((ch === '[' || image) && !inLink && depth < MAX_DEPTH) {
      const open = image ? i + 1 : i;
      const close = closeBracket(src, open);
      if (close > open) {
        const label = src.slice(open + 1, close);
        let dest: string | null = null;
        let end = close + 1;
        const tail = linkTail(src, close + 1);
        if (tail) { dest = tail.dest; end = tail.end; }
        else if (src[close + 1] === '[') {
          const refClose = src.indexOf(']', close + 2);
          if (refClose !== -1) {
            const key = refKey(src.slice(close + 2, refClose) || label);
            const hit = mapGet(ctx.refs, key);
            if (hit.tag === 'some') { dest = hit.value; end = refClose + 1; }
          }
        } else {
          const hit = mapGet(ctx.refs, refKey(label));
          if (hit.tag === 'some') dest = hit.value;
        }
        if (dest !== null) {
          flush();
          const href = hrefFor(dest.replace(/\\(.)/g, '$1'), image ? 'image' : 'link', ctx);
          if (image) {
            const alt = escapeHtml(label.replace(/[*_`[\]]/g, '') || 'image');
            out.push(href ? anchor(href, tag('span', alt, 'md-img')) : tag('span', alt, 'md-img'));
          } else {
            // A refused destination stays visible as text, so the reader sees what the README tried to link.
            out.push(href ? anchor(href, inline(label, ctx, true, depth + 1)) : escapeHtml(src.slice(i, end)));
          }
          i = end;
          continue;
        }
      }
    }
    if (ch === '<' && !inLink) {
      const auto = /^<(https:[^\s<>]+|http:[^\s<>]+|mailto:[^\s<>]+)>/i.exec(rest);
      const autoUrl = captureGroup(auto, 1);
      if (autoUrl.tag === 'some' && autoUrl.value !== '') {
        const href = classifyHref(autoUrl.value);
        flush();
        out.push(href ? anchor(href, escapeHtml(autoUrl.value)) : escapeHtml(group(auto, 0)));
        i += group(auto, 0).length;
        continue;
      }
    }
    if ((ch === 'h' || ch === 'H') && !inLink && !isWordChar(chAt(src, i - 1))) {
      const bare = /^https:\/\/[^\s<>"'`]+|^http:\/\/[^\s<>"'`]+/i.exec(rest);
      if (bare) {
        let url = bare[0];
        while (/[.,:;!?)\]*_~]$/.test(url)) {
          const opens = url.match(/\(/g);
          const closes = url.match(/\)/g);
          const openCount = opens === null ? 0 : opens.length;
          const closeCount = closes === null ? 0 : closes.length;
          if (url.endsWith(')') && openCount >= closeCount) break;
          url = url.slice(0, -1);
        }
        const href = classifyHref(url);
        if (href) {
          flush();
          out.push(anchor(href, escapeHtml(url)));
          i += url.length;
          continue;
        }
      }
    }
    if ((ch === '*' || ch === '_' || ch === '~') && depth < MAX_DEPTH) {
      const two = src[i + 1] === ch;
      if (ch === '~' && !two) { text += ch; i++; continue; }
      const delim = two ? ch + ch : ch;
      const leftOk = !/\s/.test(unwrapOr(textAt(src, i + delim.length), ' ')) && !(ch === '_' && isWordChar(chAt(src, i - 1)));
      if (leftOk) {
        const close = findCloser(src, i + delim.length, delim);
        if (close > i + delim.length - 1) {
          const inner = src.slice(i + delim.length, close);
          if (inner.length) {
            flush();
            const name = ch === '~' ? 'del' : two ? 'strong' : 'em';
            out.push(tag(name, inline(inner, ctx, inLink, depth + 1), null));
            i = close + delim.length;
            continue;
          }
        }
      }
      text += delim;
      i += delim.length;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return concatHtml(out);
}

// ── blocks ───────────────────────────────────────────────────────────────────────────────────────────────────────

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const ATX = /^ {0,3}(#{1,6})([ \t]+(.*?))?([ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST = /^( {0,12})([-*+]|\d{1,9}[.)])([ \t]+(.*))?$/;
const DELIM_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const REF_DEF = /^ {0,3}\[([^\]]{1,200})\]:[ \t]*<?([^\s>]+)>?([ \t]+"[^"]*"|[ \t]+'[^']*'|[ \t]+\([^)]*\))?[ \t]*$/;

function slugify(text: string, ctx: Ctx): string {
  const base = text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-')
    .normalize('NFKD').replace(/[^a-z0-9-]/g, '').slice(0, 64);
  if (!base) return '';
  const seen = unwrapOr(mapGet(ctx.slugs, base), 0);
  ctx.slugs.set(base, seen + 1);
  return seen ? `${base}-${seen}` : base;
}

function headingText(raw: string): string {
  return raw.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '');
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') {
      const end = codeSpanEnd(s, i);
      if (end > 0) { cur += s.slice(i, end); i = end - 1; continue; }
    }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(cell: string): MdClass | null {
  const c = cell.trim();
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'al-c';
  if (right) return 'al-r';
  if (left) return 'al-l';
  return null;
}

function startsBlock(line: string, inParagraph: boolean): boolean {
  if (FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const item = LIST.exec(line);
  const itemText = captureGroup(item, 4);
  if (itemText.tag === 'some' && itemText.value.trim() !== '') {
    // A paragraph is only interrupted by a bullet or by an ordered list that starts at 1 (CommonMark).
    if (!inParagraph) return true;
    const marker = group(item, 2);
    return /^[-*+]$/.test(marker) || /^1[.)]$/.test(marker);
  }
  return /^ {0,3}<!--/.test(line);
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) { if (ch === ' ') n++; else if (ch === '\t') n += 4 - (n % 4); else break; }
  return n;
}

function dedent(line: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    if (line[i] === ' ') col++;
    else if (line[i] === '\t') col += 4 - (col % 4);
    else break;
    i++;
  }
  return line.slice(i);
}

function codeBlock(lang: string, text: string): SafeHtml {
  const pre = tag('pre', tag('code', escapeHtml(text), null), null);
  const label = lang ? tag('div', escapeHtml(lang.slice(0, 32)), 'md-code-lang') : escapeHtml('');
  return tag('div', concatHtml([label, pre]), 'md-code');
}

function renderBlocks(lines: string[], ctx: Ctx, depth: number, tight = false): SafeHtml {
  const out: SafeHtml[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lineAt(lines, i);
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const indent = group(fence, 1).length;
      const marker = group(fence, 2, '```');
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lineAt(lines, i);
        const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
        if (closing.test(l)) { i++; break; }
        body.push(dedent(l, indent));
        i++;
      }
      out.push(codeBlock(group(fence, 3), body.join('\n')));
      continue;
    }

    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (indentOf(lineAt(lines, i)) >= 4 || !lineAt(lines, i).trim())) { body.push(dedent(lineAt(lines, i), 4)); i++; }
      while (body.length > 0) {
        const last = atIndex(body, body.length - 1);
        if (last.tag === 'none' || last.value.trim() !== '') break;
        body.pop();
      }
      out.push(codeBlock('', body.join('\n')));
      continue;
    }

    if (/^ {0,3}<!--/.test(line)) {
      while (i < lines.length && !lineAt(lines, i).includes('-->')) i++;
      i++;
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      const hashes = captureGroup(atx, 1);
      const level = Math.min(6, (hashes.tag === 'none' ? 1 : hashes.value.length) + 1) as 2 | 3 | 4 | 5 | 6;
      const text = group(atx, 3);
      out.push(heading(level, slugify(headingText(text), ctx), inline(text, ctx)));
      i++;
      continue;
    }

    if (HR.test(line)) { out.push(voidTag('hr')); i++; continue; }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lineAt(lines, i);
        const q = QUOTE.exec(l);
        if (q) { inner.push(group(q, 1)); i++; continue; }
        if (!l.trim() || startsBlock(l, true)) break;
        inner.push(l);
        i++;
      }
      out.push(tag('blockquote', depth < MAX_DEPTH ? renderBlocks(inner, ctx, depth + 1) : escapeHtml(inner.join('\n')), null));
      continue;
    }

    const next = lineAt(lines, i + 1);
    if (line.includes('|') && DELIM_ROW.test(next) && next.includes('-')) {
      const head = splitRow(line);
      const aligns = splitRow(next).map(alignOf);
      if (aligns.length === head.length || (aligns.length > 0 && head.length > 0)) {
        const cols = head.length;
        const row = (cells: string[], cell: 'th' | 'td') => tag('tr', concatHtml(
          Array.from({ length: cols }, (_, c) => {
            const align = atIndex(aligns, c);
            const cls = align.tag === 'some' ? align.value : null;
            return tag(cell, inline(unwrapOr(atIndex(cells, c), ''), ctx), cls);
          }),
        ), null);
        const body: SafeHtml[] = [];
        i += 2;
        while (i < lines.length) {
          const l = lineAt(lines, i);
          if (!l.trim() || (!l.includes('|') && startsBlock(l, true))) break;
          body.push(row(splitRow(l), 'td'));
          i++;
        }
        const table = tag('table', concatHtml([tag('thead', row(head, 'th'), null), body.length ? tag('tbody', concatHtml(body), null) : escapeHtml('')]), null);
        out.push(tag('div', table, 'md-table'));
        continue;
      }
    }

    const item = LIST.exec(line);
    const itemBody = captureGroup(item, 4);
    if (itemBody.tag === 'some' && itemBody.value.trim() !== '' && depth < MAX_DEPTH) {
      const itemMarker = group(item, 2);
      const ordered = /\d/.test(itemMarker);
      const bullet = ordered ? itemMarker.slice(-1) : itemMarker;
      const items: string[][] = [];
      let looseList = false;
      while (i < lines.length) {
        const m = LIST.exec(lineAt(lines, i));
        const mBody = captureGroup(m, 4);
        if (m === null || mBody.tag === 'none' || mBody.value.trim() === '') break;
        const mMarker = group(m, 2);
        const sameKind = ordered ? /\d/.test(mMarker) && mMarker.endsWith(bullet) : mMarker === bullet;
        if (!sameKind || indentOf(group(m, 1)) > indentOf(group(item, 1)) + 3) break;
        const spacer = group(m, 3, ' ');
        const contentIndent = group(m, 1).length + mMarker.length + Math.min(4, Math.max(1, spacer.length - mBody.value.length));
        const body = [mBody.value];
        i++;
        let sawBlank = false;
        while (i < lines.length) {
          const l = lineAt(lines, i);
          if (!l.trim()) {
            const after = find(lines.slice(i + 1), (row) => row.trim() !== '');
            if (after.tag === 'some' && indentOf(after.value) >= contentIndent) { body.push(''); sawBlank = true; i++; continue; }
            break;
          }
          if (indentOf(l) >= contentIndent) { body.push(dedent(l, contentIndent)); i++; continue; }
          if (sawBlank || startsBlock(l, true) || LIST.test(l)) break;
          body.push(l.trim());
          i++;
        }
        if (sawBlank) looseList = true;
        items.push(body);
        if (i < lines.length && !lineAt(lines, i).trim()) {
          const after = find(lines.slice(i), (row) => row.trim() !== '');
          const am = after.tag === 'some' ? LIST.exec(after.value) : null;
          const amMarker = group(am, 2);
          const amKind = am !== null && (ordered ? /\d/.test(amMarker) && amMarker.endsWith(bullet) : amMarker === bullet);
          if (am !== null && amKind && indentOf(group(am, 1)) <= indentOf(group(item, 1)) + 3) {
            looseList = true;
            while (i < lines.length && !lineAt(lines, i).trim()) i++;
          }
        }
      }
      const lis = items.map(body => {
        const first = unwrapOr(atIndex(body, 0), '');
        const task = /^\[([ xX])\][ \t]+/.exec(first);
        if (task) body[0] = first.slice(task[0].length);
        const content = renderBlocks(body, ctx, depth + 1, !looseList);
        if (!task) return tag('li', content, null);
        const box = tag('span', escapeHtml(task[1] === ' ' ? '' : '✓'), task[1] === ' ' ? 'task' : 'task done');
        return tag('li', concatHtml([box, content]), 'task-item');
      });
      const start = ordered ? Number.parseInt(group(item, 2, '1'), 10) : 1;
      out.push(ordered ? orderedList(start, concatHtml(lis)) : tag('ul', concatHtml(lis), null));
      continue;
    }

    const para: string[] = [];
    while (i < lines.length) {
      const l = lineAt(lines, i);
      if (!l.trim()) break;
      if (para.length && SETEXT.test(l)) {
        const level = (l.trim()[0] === '=' ? 2 : 3) as 2 | 3;
        const text = para.join('\n');
        out.push(heading(level, slugify(headingText(text), ctx), inline(text, ctx)));
        para.length = 0;
        i++;
        break;
      }
      if (para.length && startsBlock(l, true)) break;
      if (para.length && line.includes('|') && DELIM_ROW.test(lineAt(lines, i + 1))) break;
      para.push(l.replace(/^ {1,3}/, ''));
      i++;
    }
    if (para.length) {
      const html = inline(para.join('\n').replace(/[ \t]+$/, ''), ctx);
      out.push(tight ? html : tag('p', html, null));
    }
  }
  return concatHtml(out);
}

function stripFrontMatter(lines: string[]): string[] {
  const first = atIndex(lines, 0);
  if (first.tag === 'none' || first.value.trim() !== '---') return lines;
  const end = lines.findIndex((l, n) => n > 0 && (l.trim() === '---' || l.trim() === '...'));
  return end > 0 ? lines.slice(end + 1) : lines;
}

export function renderMarkdown(source: string, opts: MarkdownOptions = ROOT_OPTIONS): SafeHtml {
  const ctx: Ctx = { opts, refs: new Map(), slugs: new Map() };
  const lines: string[] = [];
  let inFence = false;
  for (const line of stripFrontMatter(source.replace(/\r\n?/g, '\n').split('\n'))) {
    if (FENCE.test(line) && !inFence) inFence = true;
    else if (inFence && /^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(line)) inFence = false;
    const def = inFence ? null : REF_DEF.exec(line);
    const label = captureGroup(def, 1);
    const dest = captureGroup(def, 2);
    if (label.tag === 'some' && label.value !== '' && dest.tag === 'some' && dest.value !== '') {
      const key = refKey(label.value);
      if (!ctx.refs.has(key)) ctx.refs.set(key, dest.value);
      continue;
    }
    lines.push(line);
  }
  return renderBlocks(lines, ctx, 0);
}
