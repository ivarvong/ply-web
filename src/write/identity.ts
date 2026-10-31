// Author and committer stamps. ply's validateIdent is the gate (name, email, civil zone, non-negative time) and
// brands the object ident() will accept. This module is the HTTP shape: {name, email, tz?, time?}.
// The zone check lives in validateIdent; a bad tz is still 400 bad_request, with ply's message.
import { fail, ident, validateIdent } from 'ply';

declare const tzBrand: unique symbol;
declare const timeBrand: unique symbol;

/** `+0530` / `-0800`. git ident timezone: a sign and four digits, held to the civil range ply enforces. */
export type TzOffset = string & { readonly [tzBrand]: 'TzOffset' };
/** Unix seconds. git ident timestamp: a non-negative safe integer. fsck refuses a date that overflows time_t. */
export type UnixSeconds = number & { readonly [timeBrand]: 'UnixSeconds' };

/** The object validateIdent brands. ident() refuses a copy, so the line is taken from this value. */
type Person = ReturnType<typeof validateIdent>;

export type Stamp = {
  readonly name: string;
  readonly email: string;
  readonly tz: TzOffset;
  readonly time: UnixSeconds;
  readonly person: Person;
  readonly line: string;
};

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
  // Omitted tz is validateIdent's UTC. A present tz is checked there (sign, four digits, civil range).
  const person = validateIdent({ name: raw.name, email: raw.email, time, tz: raw.tz });
  return { name: person.name, email: person.email, tz: person.tz as TzOffset, time: person.time as UnixSeconds, person, line: ident(person) };
}

export function nowSeconds(): UnixSeconds {
  return Math.floor(Date.now() / 1000) as UnixSeconds;
}

/** What editFile takes. It still stamps author and committer as one person; time is a separate argument. */
export function plyPerson(s: Stamp): { name: string; email: string; tz: TzOffset } {
  return { name: s.name, email: s.email, tz: s.tz };
}

/** What mergeBranch, rebaseBranch and pickCommit take: each stamp carries its own time and zone. */
export function plyStamp(s: Stamp): { name: string; email: string; tz: TzOffset; time: UnixSeconds } {
  return { name: s.name, email: s.email, tz: s.tz, time: s.time };
}
