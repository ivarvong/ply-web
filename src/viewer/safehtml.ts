// SafeHtml is the only string the SSR response may carry. Escape produces it. Tag builders
// concatenate it. A bare string is not SafeHtml, so it cannot be passed to htmlResponse or raw().
import { raw } from 'hono/html';

declare const safeHtmlBrand: unique symbol;

export type SafeHtml = string & { readonly [safeHtmlBrand]: 'SafeHtml' };

function mark(value: string): SafeHtml {
  return value as SafeHtml;
}

/** Text and double-quoted attribute values. Named entities, so `&quot;` is not a raw quote. */
export function escapeHtml(value: string): SafeHtml {
  return mark(value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;'));
}

export function concatHtml(parts: readonly SafeHtml[]): SafeHtml {
  return mark(parts.join(''));
}

export type MdTag = 'p' | 'ul' | 'ol' | 'li' | 'pre' | 'code' | 'strong' | 'em' | 'del' | 'blockquote' | 'table' | 'thead' | 'tbody' | 'tr' | 'th' | 'td' | 'div' | 'span';

/** Fixed class names the markdown renderer may attach. Never derived from the source text. */
export type MdClass = 'md-code' | 'md-code-lang' | 'md-table' | 'task' | 'task done' | 'task-item' | 'al-l' | 'al-c' | 'al-r' | 'md-img' | 'md-frontmatter';

export function tag(name: MdTag, content: SafeHtml, cls?: MdClass): SafeHtml {
  const open = cls ? `<${name} class="${cls}">` : `<${name}>`;
  return concatHtml([mark(open), content, mark(`</${name}>`)]);
}

export function voidTag(name: 'br' | 'hr'): SafeHtml {
  return mark(`<${name}>`);
}

/** h2–h6. The id is a slug of [a-z0-9-] only, so a README's `[x](#usage)` lands on its heading. */
export function heading(level: 2 | 3 | 4 | 5 | 6, slug: string, content: SafeHtml): SafeHtml {
  const id = /^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) ? ` id="${slug}"` : '';
  return concatHtml([mark(`<h${level}${id}>`), content, mark(`</h${level}>`)]);
}

/** An ordered list that starts at an integer other than 1. */
export function orderedList(start: number, content: SafeHtml): SafeHtml {
  const n = Number.isSafeInteger(start) && start >= 0 && start !== 1 ? ` start="${start}"` : '';
  return concatHtml([mark(`<ol${n}>`), content, mark('</ol>')]);
}

/** href has already passed the scheme allowlist and contains no quote, space, or control. */
export function anchor(href: string, content: SafeHtml): SafeHtml {
  return concatHtml([
    mark('<a href="'),
    escapeHtml(href),
    mark('" rel="noopener noreferrer nofollow">'),
    content,
    mark('</a>'),
  ]);
}

/**
 * Hono escapes interpolated children. The one raw() call in the viewer takes SafeHtml, which
 * only the markdown renderer produces. This brands that JSX result for htmlResponse.
 */
export function trustRendered(markup: string): SafeHtml {
  return mark(markup);
}

export function rawSafe(html: SafeHtml) {
  return raw(html);
}

export function viewerErrorDocument(code: string, message: string): SafeHtml {
  return concatHtml([
    mark('<!doctype html><meta charset="utf-8"><title>'),
    escapeHtml(code),
    mark('</title><p>'),
    escapeHtml(message),
    mark('</p>'),
  ]);
}
