// The read side's one document over Workers Cache (docs/rate-limit.md "Read side"). RateCache (src/rate/cache-entry.ts)
// is a cache-enabled named entrypoint; serveDoc is what it runs on a MISS, EXPIRED or background revalidation.
// Never the Cache API: test/gitcache.test.ts fails on any `caches.` in src/.
import { DOC_MAX_AGE_S, DOC_PATH, DOC_SWR_S, DOC_TAG } from './config.ts';
import type { BlockedDoc } from './core.ts';

export type DocSource = { blockedDoc(): Promise<BlockedDoc> };

export const DOC_GEN_HEADER = 'x-ply-rate-gen';
export const DOC_AT_HEADER = 'x-ply-rate-at';

export function docCacheControl(): string {
  return `public, max-age=${DOC_MAX_AGE_S}, stale-while-revalidate=${DOC_SWR_S}`;
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
}

export async function serveDoc(req: Request, source: DocSource | null): Promise<Response> {
  if (req.method !== 'GET') return plain(405, 'method not allowed\n');
  if (new URL(req.url).pathname !== DOC_PATH) return plain(404, 'not the rate document\n');
  if (source === null) return plain(503, 'rate counter is not configured\n');
  let doc: BlockedDoc;
  try {
    doc = await source.blockedDoc();
  } catch (e) {
    console.log(JSON.stringify({ msg: 'ply.rate.doc', error_name: e instanceof Error ? e.name : 'Error' }));
    return plain(503, 'rate counter read failed\n');
  }
  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': docCacheControl(),
      'cache-tag': DOC_TAG,
      etag: `"g${doc.gen}"`,
      [DOC_GEN_HEADER]: String(doc.gen),
      [DOC_AT_HEADER]: String(doc.at),
    },
  });
}

/** key16:bucket → [until, crossed]. */
export type DocIndex = Map<string, readonly [number, number]>;

export function indexDoc(text: string): { index: DocIndex; gen: number; at: number; entries: number } {
  const parsed: unknown = JSON.parse(text);
  const index: DocIndex = new Map();
  if (parsed === null || typeof parsed !== 'object') throw new Error('rate document is not an object');
  const doc = parsed as { v: unknown; gen: unknown; at: unknown; entries: unknown };
  if (doc.v !== 1 || typeof doc.gen !== 'number' || typeof doc.at !== 'number' || !Array.isArray(doc.entries)) throw new Error('rate document shape');
  for (const e of doc.entries as unknown[]) {
    if (!Array.isArray(e) || e.length !== 4) continue;
    const [k, b, until, crossed] = e as [unknown, unknown, unknown, unknown];
    if (typeof k !== 'string' || typeof b !== 'number' || typeof until !== 'number' || typeof crossed !== 'number') continue;
    index.set(`${k}:${b}`, [until, crossed]);
  }
  return { index, gen: doc.gen, at: doc.at, entries: index.size };
}
