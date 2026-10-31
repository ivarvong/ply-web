// Author and committer stamps. ply's validateIdent is the gate (name, email, civil zone, non-negative time) and
// brands the object ident() will accept. This module is the HTTP shape: {name, email, tz?, time?}.
import { fail, ident, validateIdent } from 'ply';
import { IDENT_TZ_DIGITS, IDENT_TZ_HOUR_MAX, IDENT_TZ_HOUR_MIN, IDENT_TZ_MINUTE_MAX } from './constants.ts';

declare const tzBrand: unique symbol;
declare const timeBrand: unique symbol;

/** `+0530` / `-0800`. git ident timezone: a sign and four digits, held to the civil range ply enforces. */
export type TzOffset = string & { readonly [tzBrand]: 'TzOffset' };
/** Unix seconds. git ident timestamp: a non-negative safe integer. fsck refuses a date that overflows time_t. */
export type UnixSeconds = number & { readonly [timeBrand]: 'UnixSeconds' };

export type Stamp = {
  readonly name: string;
  readonly email: string;
  readonly tz: TzOffset;
  readonly time: UnixSeconds;
  /** The validated ply person. ident() refuses a copy, so the line is taken from this object. */
  readonly person: { readonly name: string; readonly email: string; readonly time: number; readonly tz: string };
  readonly line: string;
};

const TZ_TEXT = new RegExp(`^[+-][0-9]{${IDENT_TZ_DIGITS}}$`);
const HOUR_DIGITS = IDENT_TZ_DIGITS / 2;

export function parseTz(value: unknown, field: string): TzOffset {
  if (typeof value !== 'string' || !TZ_TEXT.test(value)) throw fail('bad_request', `${field} must be a sign and four digits (+0530)`);
  const sign = value[0] === '-' ? -1 : 1;
  const hours = sign * Number(value.slice(1, 1 + HOUR_DIGITS));
  const minutes = Number(value.slice(1 + HOUR_DIGITS));
  if (minutes < 0 || minutes > IDENT_TZ_MINUTE_MAX) throw fail('bad_request', `${field} minutes are out of range`);
  if (hours < IDENT_TZ_HOUR_MIN || hours > IDENT_TZ_HOUR_MAX) throw fail('bad_request', `${field} hours are out of range`);
  if ((hours === IDENT_TZ_HOUR_MAX || hours === IDENT_TZ_HOUR_MIN) && minutes !== 0) throw fail('bad_request', `${field} at the extreme offset must be on the hour`);
  return value as TzOffset;
}

export function parseTime(value: unknown, field: string): UnixSeconds {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw fail('bad_request', `${field} must be a non-negative integer (unix seconds)`);
  return value as UnixSeconds;
}

type Raw = { name?: unknown; email?: unknown; tz?: unknown; time?: unknown };

function rawOf(value: unknown, field: string): Raw {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('bad_request', `${field} must be {name, email}`);
  return value as Raw;
}

/** Stamp one identity. Omitted tz is UTC. Omitted time is `now` (unix seconds). */
export function stamp(value: unknown, field: string, now: UnixSeconds): Stamp {
  const raw = rawOf(value, field);
  const time = raw.time === undefined ? now : parseTime(raw.time, `${field}.time`);
  const tz = raw.tz === undefined ? undefined : parseTz(raw.tz, `${field}.tz`);
  const person = validateIdent({ name: raw.name, email: raw.email, time, tz }) as Stamp['person'];
  return { name: person.name, email: person.email, tz: person.tz as TzOffset, time: person.time as UnixSeconds, person, line: ident(person) as string };
}

export function nowSeconds(): UnixSeconds {
  return Math.floor(Date.now() / 1000) as UnixSeconds;
}

/** What editFile / mergeBranch / rebaseBranch take: the pieces, plus our time passed separately. */
export function plyPerson(s: Stamp): { name: string; email: string; tz: TzOffset } {
  return { name: s.name, email: s.email, tz: s.tz };
}
