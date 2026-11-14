// Server-rendered markup for the workbench. `html` is a tagged template: a value is escaped unless it is already Html
// (made by `html` itself), and an array is joined. The pages carry no script (the viewer's CSP: script-src 'none',
// style-src 'self'), so every view is plain HTML and inline SVG presentation attributes.
import { escapeHtml, type SafeHtml } from '../viewer/safehtml.ts';

export type Html = { readonly tag: 'html'; readonly text: string };
export type Part = Html | string | number | null | readonly Part[];

const isHtml = (v: Part): v is Html => typeof v === 'object' && v !== null && !Array.isArray(v) && (v as Html).tag === 'html';
function render(v: Part): string {
  if (v === null) return '';
  if (isHtml(v)) return v.text;
  if (Array.isArray(v)) return v.map((x: Part) => render(x)).join('');
  return String(escapeHtml(String(v)));
}
export function html(strings: TemplateStringsArray, ...values: readonly Part[]): Html {
  let out = strings[0] || '';
  for (const [i, v] of values.entries()) out += render(v) + (strings[i + 1] || '');
  return { tag: 'html', text: out };
}
// A whole page as the viewer's SafeHtml (src/viewer/http.ts htmlResponse takes only that).
export const page = (h: Html): SafeHtml => h.text as SafeHtml;
