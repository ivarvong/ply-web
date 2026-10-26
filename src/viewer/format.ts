import { clampText } from './escape.ts'
import { LAYOUT, RELATIVE_TIME } from './layout.ts'

const BYTE = 1024
const BYTE_TENTHS = 10 * BYTE
const SECOND_MS = 1_000

export function shortOid(oid: string): string {
  return oid.slice(0, LAYOUT.shortOid)
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < BYTE) return `${Math.round(n)} B`
  if (n < BYTE * BYTE) return `${(n / BYTE).toFixed(n < BYTE_TENTHS ? 1 : 0)} KiB`
  return `${(n / (BYTE * BYTE)).toFixed(n < BYTE_TENTHS * BYTE ? 1 : 0)} MiB`
}

export function formatDuration(ms: number): string {
  if (ms >= SECOND_MS) return `${(ms / SECOND_MS).toFixed(1)} s`
  return `${Math.round(ms)} ms`
}

export type CommitProse = { subject: string; paragraphs: readonly string[] }

/** Git paragraphs stay separate. Hard wraps inside a paragraph reflow. */
export function commitProse(message: string): CommitProse {
  const clamped = clampText(message, LAYOUT.commitMessageChars).replace(/\r\n/g, '\n')
  const trimmed = clamped.replace(/\n+$/, '')
  const subject = (trimmed.split('\n')[0] ?? '').trim()
  const rest = trimmed.slice(subject.length).replace(/^\n+/, '')
  if (!rest.trim()) return { subject, paragraphs: [] }
  const paragraphs = rest.split(/\n{2,}/).map(reflow).filter(paragraph => paragraph.length > 0)
  return { subject, paragraphs }
}

function reflow(block: string): string {
  return block.split('\n').map(line => line.trim()).filter(line => line.length > 0).join(' ')
}

export type ExactTime = { iso: string; label: string; relative: string }

export function exactTime(iso: string, tz: string, now: number): ExactTime {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) {
    const label = [iso, tz].filter(part => part.length > 0).join(' ')
    return { iso, label, relative: label }
  }
  const formatted = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
    hourCycle: 'h23',
  }).format(new Date(parsed))
  const label = tz ? `${formatted} UTC (${tz})` : `${formatted} UTC`
  return { iso, label, relative: relativePhrase(now - parsed) }
}

function relativePhrase(deltaMs: number): string {
  const future = deltaMs < 0
  const abs = Math.abs(deltaMs)
  const phrase = relativeUnit(abs)
  if (phrase === 'just now') return phrase
  return future ? `in ${phrase}` : `${phrase} ago`
}

function relativeUnit(absMs: number): string {
  if (absMs < RELATIVE_TIME.justNowMs) return 'just now'
  const minutes = Math.round(absMs / RELATIVE_TIME.minuteMs)
  if (absMs < RELATIVE_TIME.hourMs) return plural(minutes, 'minute')
  const hours = Math.round(absMs / RELATIVE_TIME.hourMs)
  if (absMs < RELATIVE_TIME.dayMs) return plural(hours, 'hour')
  const days = Math.round(absMs / RELATIVE_TIME.dayMs)
  if (days < RELATIVE_TIME.monthDays) return plural(days, 'day')
  const months = Math.round(days / RELATIVE_TIME.monthDays)
  if (days < RELATIVE_TIME.yearDays) return plural(months, 'month')
  const years = Math.max(1, Math.round(days / RELATIVE_TIME.yearDays))
  return plural(years, 'year')
}

function plural(n: number, unit: string): string {
  const count = Math.max(1, n)
  return count === 1 ? `1 ${unit}` : `${count} ${unit}s`
}

/** Integer percents that sum to 100. Zero-length parts stay zero. */
export function portions(lengths: readonly number[]): number[] {
  const total = lengths.reduce((sum, n) => sum + n, 0) || 1
  const raw = lengths.map(n => (n / total) * LAYOUT.percentSteps)
  const floors = raw.map(n => Math.floor(n))
  let left = LAYOUT.percentSteps - floors.reduce((sum, n) => sum + n, 0)
  const order = raw.map((n, i) => [n - (floors[i] ?? 0), i] as const).sort((a, b) => b[0] - a[0])
  const out = floors.slice()
  for (let i = 0; i < left; i++) {
    const slot = order[i % order.length]?.[1] ?? 0
    out[slot] = (out[slot] ?? 0) + 1
  }
  return out
}

export function percentClass(prefix: 'o' | 'w', value: number): string {
  const clamped = Math.max(0, Math.min(LAYOUT.percentSteps, value))
  return `${prefix}${clamped}`
}
