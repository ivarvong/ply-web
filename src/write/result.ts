// One result shape for every write. `outcome` is the discriminant. `newCommit` / `oldCommit` and `onto` stay as
// deprecated aliases of `oid` / `oldOid` so existing clients keep working.
import { chainGet } from '../absent.ts';

/**
 * First present field among `keys`. A missing key and a null value fall through.
 * A present 0, false, or empty string does not. `fallback` is used when every key misses.
 */
export function firstPresent(record: object, keys: readonly string[], fallback: unknown): unknown {
  for (const key of keys) {
    const found = chainGet(record, key);
    if (found.tag === 'some') return found.value;
  }
  return fallback;
}

export type WriteOutcome =
  | 'commit'
  | 'noop'
  | 'empty'
  | 'created'
  | 'deleted'
  | 'merge'
  | 'fast_forward'
  | 'up_to_date'
  | 'rebase'
  | 'squash'
  | 'cherry_pick'
  | 'revert'
  | 'tag';

export type WriteBody = {
  outcome: WriteOutcome;
  ref: string;
  oid: string | null;
  oldOid: string | null;
  noop: boolean;
  /** @deprecated alias of oid */
  newCommit: string | null;
  /** @deprecated alias of oldOid */
  oldCommit: string | null;
  /** @deprecated alias of the commit this write was based on (oldOid, or the other side of a merge) */
  onto: string | null;
};

const EMPTY_OUTCOMES: ReadonlySet<string> = new Set(['noop', 'empty', 'up_to_date']);

export function writeResult(outcome: WriteOutcome, ref: string, oid: string | null, oldOid: string | null, extra: Record<string, unknown> = {}): WriteBody & Record<string, unknown> {
  const ontoRaw = firstPresent(extra, ['onto', 'theirs'], oldOid);
  const onto = typeof ontoRaw === 'string' ? ontoRaw : null;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) if (key !== 'onto') rest[key] = value;
  return {
    ...rest,
    outcome,
    ref,
    oid,
    oldOid,
    noop: EMPTY_OUTCOMES.has(outcome),
    newCommit: oid,
    oldCommit: oldOid,
    onto,
  };
}

/** Fold a ply result (edit, merge, rebase, cherry-pick, revert) into the shared shape without dropping ply's fields. */
export function unifyPly(r: Record<string, unknown>, outcome: WriteOutcome, ref: string): WriteBody & Record<string, unknown> {
  const oid = firstPresent(r, ['oid', 'newCommit'], null) as string | null;
  const oldOid = firstPresent(r, ['oldCommit', 'ours', 'oldTip'], null) as string | null;
  const onto = firstPresent(r, ['onto', 'theirs'], oldOid) as string | null;
  return {
    ...r,
    ...writeResult(outcome, ref, oid, oldOid, {
      onto,
      tree: firstPresent(r, ['tree', 'newTree'], null),
      pushBytes: firstPresent(r, ['pushBytes'], 0),
    }),
    noop: typeof r.noop === 'boolean' ? r.noop : EMPTY_OUTCOMES.has(outcome),
  };
}
