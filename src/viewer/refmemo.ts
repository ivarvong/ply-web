// Last good ref list per (repo URL, ls-refs prefixes), in this isolate, for the viewer only (/v1 never reads it).
// Why: Codeberg sent ls-refs bodies in ~10 s (p50) during the European day and the 12 s requestTimeoutMs cut 61 of 245
// /view/codeberg.org/dnkl/foot pages (a179dd82, 2026-11-12, lab_notebook 504-diagnosis.md); the Workers Cache refs entry
// was already EXPIRED (max-age 5 + swr 10), so it cannot answer. When the live ls-refs has not finished within
// REFS_STALE_BUDGET_MS and this isolate holds a last good list, the page uses that list (marked "refs as of") and the
// live request keeps running under waitUntil, so its answer replaces the entry for the next page. Nothing stored: as before.
// Viewer pages are no-store, so a stale page is never cached.

/**
 * 3.5 s: healthy ls-refs is far below it (codeberg p90 685 ms on e3d9a25a, gitlab p90 382 ms, github p90 86 ms), the slow
 * successes on a179dd82 took 5.7-8.7 s, and it leaves 8.5 s of the 12 s request timeout for the window, walk and blob.
 */
export const REFS_STALE_BUDGET_MS = 3_500;
export const REFS_MEMO_ENTRIES = 256;

export type RefsMemo<V> = {
  get(key: string): { value: V; at: number } | null;
  put(key: string, value: V, at: number): void;
};

/** Insertion-ordered, bounded: a put refreshes the key's position; past `max` the oldest key goes. */
export function createRefsMemo<V>(max: number): RefsMemo<V> {
  const map = new Map<string, { value: V; at: number }>();
  return {
    get(key) { const hit = map.get(key); return hit === undefined ? null : hit; },
    put(key, value, at) {
      map.delete(key);
      map.set(key, { value, at });
      while (map.size > max) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    },
  };
}

export type StaleInfo = { asOf: number; ageMs: number; budgetMs: number };

export async function refsOrStale<V>(memo: RefsMemo<V>, key: string, live: Promise<V>, opts: {
  budgetMs: number;
  now: () => number;
  defer: ((p: Promise<unknown>) => void) | null;
}): Promise<{ value: V; stale: StaleInfo | null }> {
  const stored = live.then(v => { memo.put(key, v, opts.now()); return v; });
  const last = memo.get(key);
  if (last === null) return { value: await stored, stale: null };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = Symbol('late');
  const budget = new Promise<typeof late>(r => { timer = setTimeout(() => r(late), opts.budgetMs); });
  try {
    const first = await Promise.race([stored, budget]);
    if (first !== late) return { value: first as V, stale: null };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  const background = stored.catch(() => {});
  if (opts.defer) opts.defer(background);
  const now = opts.now();
  return { value: last.value, stale: { asOf: last.at, ageMs: Math.max(0, now - last.at), budgetMs: opts.budgetMs } };
}
