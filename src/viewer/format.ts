import { atIndex, captureGroup, fromAbsent } from '../absent.ts'
import { unwrapOr } from '../option.ts'
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

export type Trailer = { key: string; value: string }
export type CommitProse = { subject: string; paragraphs: readonly string[]; trailers: readonly Trailer[] }

// git interpret-trailers: `Token: value` lines in the final paragraph. GitHub's closing keywords count too.
const TRAILER = /^([A-Za-z][A-Za-z0-9-]{0,63}):[ \t]+(\S.*)$/
const CLOSING = /^(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) +(([\w.-]+\/[\w.-]+)?#\d+.*)$/i

const KNOWN_TRAILER = /^([A-Za-z-]+-by|change-id|closes?|closed|fix(es|ed)?|resolve[sd]?|refs?|see-also|cc|bug|issue|ticket|[A-Za-z]+-session)$/i

function groupText(match: RegExpExecArray | null, index: number): string | null {
  const group = captureGroup(match, index)
  if (group.tag === 'none' || group.value === '') return null
  return group.value
}

function trailerOf(line: string): Trailer | null {
  const t = TRAILER.exec(line)
  const trailerKey = groupText(t, 1)
  const trailerValue = groupText(t, 2)
  if (trailerKey !== null && trailerValue !== null) return { key: trailerKey, value: trailerValue.trim() }
  const c = CLOSING.exec(line)
  const closingKey = groupText(c, 1)
  const closingValue = groupText(c, 2)
  if (closingKey !== null && closingValue !== null) return { key: closingKey.charAt(0).toUpperCase() + closingKey.slice(1).toLowerCase(), value: closingValue.trim() }
  return null
}

/**
 * Subject, body paragraphs, trailers. Paragraphs keep their line breaks (git messages are often lists or hard-wrapped
 * prose; the page shows them with white-space: pre-wrap). Trailing trailer lines (Co-Authored-By, Signed-off-by,
 * Closes #n) are split out so the page can show them quietly.
 */
export function commitProse(message: string): CommitProse {
  const clamped = clampText(message, LAYOUT.commitMessageChars).replace(/\r\n?/g, '\n')
  const trimmed = clamped.replace(/\s+$/, '')
  const subject = unwrapOr(atIndex(trimmed.split('\n'), 0), '').trim()
  const rest = trimmed.slice(trimmed.indexOf('\n') === -1 ? trimmed.length : trimmed.indexOf('\n')).replace(/^\n+/, '')
  if (!rest.trim()) return { subject, paragraphs: [], trailers: [] }
  const blocks = rest.split(/\n[ \t]*\n/).map(block => block.replace(/^\n+|\s+$/g, '')).filter(block => block.trim().length > 0)
  const trailers: Trailer[] = []
  // Trailers live in the final paragraphs; a run of closing keywords may sit in its own paragraph just above them.
  while (blocks.length) {
    const lines = unwrapOr(atIndex(blocks, blocks.length - 1), '').split('\n').map(line => line.trim()).filter(line => line.length > 0)
    const parsed = lines.map(trailerOf)
    if (!parsed.length || parsed.some(t => t === null)) break
    // "Before: 12 ms / After: 5 ms" is prose, not trailers: ask for one key git or GitHub would recognise.
    if (!parsed.some(t => t && KNOWN_TRAILER.test(t.key))) break
    trailers.unshift(...(parsed as Trailer[]))
    blocks.pop()
  }
  return { subject, paragraphs: blocks, trailers }
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
  const order = raw.map((n, i) => [n - unwrapOr(atIndex(floors, i), 0), i] as const).sort((a, b) => b[0] - a[0])
  const out = floors.slice()
  for (let i = 0; i < left; i++) {
    const pair = atIndex(order, i % order.length)
    let slot = 0
    if (pair.tag === 'some') {
      const index = atIndex(pair.value, 1)
      if (index.tag === 'some' && typeof index.value === 'number') slot = index.value
    }
    const current = fromAbsent(out[slot])
    out[slot] = (current.tag === 'some' && typeof current.value === 'number' ? current.value : 0) + 1
  }
  return out
}

export function percentClass(prefix: 'o' | 'w', value: number): string {
  const clamped = Math.max(0, Math.min(LAYOUT.percentSteps, value))
  return `${prefix}${clamped}`
}
