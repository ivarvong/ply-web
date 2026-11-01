import { atIndex } from '../absent.ts';
import { unwrapOr } from '../option.ts';
export { escapeHtml } from './safehtml.ts';

export function safeFilename(name: string): string {
  const parts = name.split('/');
  const base = unwrapOr(atIndex(parts, parts.length - 1), 'file');
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return cleaned || 'file';
}

export function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + '\n…';
}
