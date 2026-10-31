// Learned server properties (ply's `quirks`, e.g. "refuses filter tree:0, use blob:none"), per origin, for the isolate's
// life. A fact about a server, learned from its own answer, the same for every caller, so /v1 and the viewer share it:
// the first request to a server that refuses tree:0 pays the 400 and the retry, later ones ask for blob:none directly.
export type Quirks = { treeFilter?: 'blob:none' };

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
