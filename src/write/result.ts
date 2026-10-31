// One result shape for every write. `outcome` is the discriminant. `newCommit` / `oldCommit` and `onto` stay as
// deprecated aliases of `oid` / `oldOid` so existing clients keep working.

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
  const ontoRaw = extra.onto ?? extra.theirs ?? oldOid;
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
  const oid = (r.oid ?? r.newCommit ?? null) as string | null;
  const oldOid = (r.oldCommit ?? r.ours ?? r.oldTip ?? null) as string | null;
  const onto = (r.onto ?? r.theirs ?? oldOid) as string | null;
  return {
    ...r,
    ...writeResult(outcome, ref, oid, oldOid, { onto, tree: r.tree ?? r.newTree ?? null, pushBytes: r.pushBytes ?? 0 }),
    noop: typeof r.noop === 'boolean' ? r.noop : EMPTY_OUTCOMES.has(outcome),
  };
}
