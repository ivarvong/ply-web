// RPC operations. Each one returns an ADT. A lost compare-and-swap is a conflict, not a throw.
import { applyRollout, applyTargeting } from './document.ts';
import { commitChange, readConfig, type FlagStore, type Invalidator, type WriteLog } from './store.ts';
import type { ReadResult, Targeting, WriteResult } from './types.ts';

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
  return commitChange(store, invalidator, expectedRevision, document => applyRollout(document, flag, basisPoints), 'setRollout', flag, writeLog);
}

export async function setTargeting(store: FlagStore, invalidator: Invalidator, flag: string, targeting: Targeting, expectedRevision: string): Promise<WriteResult> {
  return commitChange(store, invalidator, expectedRevision, document => applyTargeting(document, flag, targeting), 'setTargeting', flag, writeLog);
}
