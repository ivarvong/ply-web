// RPC operations. Each one returns an ADT. A lost compare-and-swap is a conflict, not a throw.
// The flag key and targeting document are parsed once here. applyRollout trusts the brand.
import { parseFlagKey } from './brand.ts';
import { applyRollout, applyTargeting, parseTargeting } from './document.ts';
import { commitChange, readConfig, type FlagStore, type Invalidator, type WriteLog } from './store.ts';
import type { Flag, ReadResult, WriteResult } from './types.ts';

function writeLog(entry: WriteLog): void {
  console.log(JSON.stringify({
    msg: 'flags.write',
    op: entry.op,
    flag: entry.flag,
    oldRevision: entry.oldRevision,
    newRevision: entry.newRevision,
    invalidated: entry.invalidated,
    diff: entry.diff,
  }));
}

export async function getConfig(store: FlagStore): Promise<ReadResult> {
  return readConfig(store);
}

export async function setRollout(store: FlagStore, invalidator: Invalidator, flag: string, basisPoints: number, expectedRevision: string): Promise<WriteResult> {
  const key = parseFlagKey(flag);
  if (key.kind !== 'key') {
    const reason = key.reason;
    return commitChange(store, invalidator, expectedRevision, () => ({ kind: 'invalid', reason }), 'setRollout', flag, writeLog);
  }
  const parsed = key.value;
  return commitChange(store, invalidator, expectedRevision, document => applyRollout(document, parsed, basisPoints), 'setRollout', parsed, writeLog);
}

export async function setTargeting(store: FlagStore, invalidator: Invalidator, flag: string, targeting: unknown, expectedRevision: string): Promise<WriteResult> {
  const key = parseFlagKey(flag);
  if (key.kind !== 'key') {
    const reason = key.reason;
    return commitChange(store, invalidator, expectedRevision, () => ({ kind: 'invalid', reason }), 'setTargeting', flag, writeLog);
  }
  const parsed = key.value;
  return commitChange(store, invalidator, expectedRevision, document => {
    let existing: Flag | null = null;
    for (const item of document.flags) {
      if (item.key === parsed) existing = item;
    }
    if (existing === null) return { kind: 'invalid', reason: `unknown flag ${parsed}` };
    const rules = parseTargeting(targeting);
    if ('kind' in rules) return rules;
    return applyTargeting(document, parsed, rules);
  }, 'setTargeting', parsed, writeLog);
}
