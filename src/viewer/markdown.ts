// Minimal markdown for README text. The source is escaped as text. A link becomes an anchor only
// when its URL is an allowlisted scheme with no character that could leave the href attribute.
import { anchor, concatHtml, escapeHtml, tag, type SafeHtml } from './safehtml.ts';

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
    return NAMED[body.toLowerCase()] ?? all;
  });
}

function obscured(value: string): boolean {
  // oxlint-disable-next-line no-control-regex -- controls and whitespace are scheme-obfuscation, not a URL
  if (/[\u0000-\u001f\u007f\s<>"'`\\]/.test(value)) return true;
  if (/[\u200b-\u200f\u202a-\u202e\ufeff]/.test(value)) return true;
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return true;
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

function emphasis(raw: string): SafeHtml {
  const parts: SafeHtml[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of raw.matchAll(re)) {
    const index = match.index ?? 0;
    parts.push(escapeHtml(raw.slice(last, index)));
    parts.push(tag('strong', escapeHtml(match[1] ?? '')));
    last = index + match[0].length;
  }
  parts.push(escapeHtml(raw.slice(last)));
  return concatHtml(parts);
}

function inline(raw: string): SafeHtml {
  const parts: SafeHtml[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '`') {
      const end = raw.indexOf('`', i + 1);
      if (end > i) {
        parts.push(tag('code', escapeHtml(raw.slice(i + 1, end))));
        i = end + 1;
        continue;
      }
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(raw.slice(i));
    if (link?.[1] && link[2]) {
      const href = classifyHref(link[2]);
      if (href) parts.push(anchor(href, emphasis(link[1])));
      else parts.push(emphasis(link[0]));
      i += link[0].length;
      continue;
    }
    const next = raw.slice(i + 1).search(/[`[]/);
    const end = next === -1 ? raw.length : i + 1 + next;
    parts.push(emphasis(raw.slice(i, end)));
    i = end;
  }
  return concatHtml(parts);
}

export function renderMarkdown(source: string): SafeHtml {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: SafeHtml[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  const flushPara = () => {
    if (!para.length) return;
    blocks.push(tag('p', inline(para.join(' '))));
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push(tag('ul', concatHtml(list.map(item => tag('li', inline(item))))));
    list = [];
  };
  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) {
        blocks.push(concatHtml([markPre(code.join('\n'))]));
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      flushPara();
      flushList();
      code = [];
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading?.[1] && heading[2]) {
      flushPara();
      flushList();
      const level = heading[1].length;
      const name = level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5';
      blocks.push(tag(name, inline(heading[2])));
      continue;
    }
    const item = /^[-*] (.+)$/.exec(line);
    if (item?.[1]) {
      flushPara();
      list.push(item[1]);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  if (code) blocks.push(markPre(code.join('\n')));
  flushPara();
  flushList();
  return concatHtml(blocks);
}

function markPre(text: string): SafeHtml {
  return concatHtml([tag('pre', tag('code', escapeHtml(text)))]);
}
