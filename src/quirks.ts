// Learned server properties, ply's `Quirks`, per origin, for the isolate's life. A fact about a server, learned from
// its own answer, the same for every caller, so /v1 and the viewer share it. `treeFilter`: the first request to a
// server that refuses tree:0 pays the 400 and the retry, later ones ask for blob:none directly. `blobWants`: a host
// that refuses a multi-blob want list, so checkout asks for one blob at a time from then on.
import type { Quirks } from 'ply/transport';

export type { Quirks };

const MAX_ORIGINS = 256;
const QUIRKS = new Map<string, Quirks>();

export function quirksFor(origin: string): Quirks {
  let q = QUIRKS.get(origin);
  if (!q) {
    if (QUIRKS.size >= MAX_ORIGINS) QUIRKS.clear();
    q = {};
    QUIRKS.set(origin, q);
  }
  return q;
}

/** Tests only: forget what this process has learned (the node suites fake many servers under one origin). */
export function resetQuirks(): void {
  QUIRKS.clear();
}
