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

export function tag(name: 'p' | 'ul' | 'li' | 'pre' | 'code' | 'strong' | 'h3' | 'h4' | 'h5', content: SafeHtml): SafeHtml {
  return concatHtml([mark(`<${name}>`), content, mark(`</${name}>`)]);
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
