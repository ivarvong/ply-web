// Learned server properties, ply's `Quirks`, per origin, for the isolate's life. A fact about a server, learned from
// its own answer, the same for every caller, so /v1 and the viewer share it. `treeFilter`: the first request to a
// server that refuses tree:0 pays the 400 and the retry, later ones ask for blob:none directly. `blobWants`: a host
// that refuses a multi-blob want list, so checkout asks for one blob at a time from then on.
import type { Quirks } from 'ply/transport';
import { PUBLIC_GIT_ORIGIN } from './public.ts';

export type { Quirks };

const MAX_ORIGINS = 256;
const QUIRKS = new Map<string, Quirks>();

export function quirksFor(origin: string): Quirks {
  const known = QUIRKS.get(origin);
  if (known) return known;
  if (QUIRKS.size >= MAX_ORIGINS) QUIRKS.clear();
  // ply's defaults (0.2.0 quirks are a total record); the transport updates this same object as it learns.
  // The public namespace is Cloudflare Artifacts, which takes only blob:none (its 400: "only blob:none is supported").
  // Known up front, a new isolate's first page there skips the tree:0 try: that refusal is cached per request body, so on
  // a sha this colo had not served it went upstream, 1.0-1.7 s before the blob:none retry (runs sparse-ply and
  // coldpack-ply on 2a4741c0: cff8743a…, c28d03a7…, d149bcd8…).
  const q: Quirks = { treeFilter: origin === PUBLIC_GIT_ORIGIN ? 'blob:none' : 'tree:0', blobWants: 'many' };
  QUIRKS.set(origin, q);
  return q;
}

/** Tests only: forget what this process has learned (the node suites fake many servers under one origin). */
export function resetQuirks(): void {
  QUIRKS.clear();
}
