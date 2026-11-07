// The batched rate limiter's numbers (docs/rate-limit.md). Every one is named here and nowhere else.

/** How long an isolate's open batch collects hits before one flush RPC. Ivar's design: "only write every 200ms". */
export const LINGER_MS = 200;
/**
 * One flush attempt races this timer: about 2x the apply RPC's p99.9 (722 ms on ae21dee2, run lat2, 5649 flushes). At
 * 1000 ms, colos far from the counter (MRS: 436-984 ms) timed out and replayed healthy attempts.
 */
export const ATTEMPT_TIMEOUT_MS = 1_500;
/** A batch is retried with the same id until acked or this long after its first attempt, then dropped. */
export const FLUSH_DEADLINE_MS = 5_000;
/** First retry backoff; doubles per attempt, capped by what is left of the deadline. */
export const RETRY_BACKOFF_MS = 50;
/** A batch with this many distinct keys is flushed at once instead of lingering. */
export const MAX_BATCH_KEYS = 2_048;
/** Batches flushing (lingering or retrying) at once per isolate. A batch beyond this is dropped and recorded. */
export const MAX_INFLIGHT = 64;
/**
 * Distinct client keys held per isolate across the open batch and every batch still flushing. Without it the bound is
 * MAX_INFLIGHT × MAX_BATCH_KEYS = 131,072 Map entries while the counter is slow (5 s of retries). A hit for a NEW key
 * past this is dropped and recorded (`rate.batch.dropped=budget`); a key already in the open batch still counts.
 */
export const MAX_KEYS_HELD = 16_384;

export const SLOT_MS = 10_000;
export const WINDOW_MS = 60_000;
/** Idempotency keys are kept this long: 120× the client deadline. */
export const DEDUPE_RETENTION_MS = 600_000;
export const PRUNE_EVERY_MS = 5_000;
/**
 * One prune deletes at most this many rows per table (rate_hits, rate_batches, rate_blocked). On 78ddd5c3 one apply
 * wrote 12,892 rows: an unbounded retention prune after an idle spell. A full batch leaves a backlog, and the next apply
 * prunes again instead of waiting PRUNE_EVERY_MS, so the backlog drains a bounded slice per apply.
 */
export const PRUNE_BATCH_ROWS = 128;
/** The blocked document holds at most this many entries (newest `until` first). */
export const MAX_DOC_ENTRIES = 4_096;
/**
 * The reader's bound on the document (defence against a bad or oversized one): bytes read and entries indexed. A full
 * document is MAX_DOC_ENTRIES × ~52 bytes ≈ 213 KB; a bigger body is not read, and the isolate keeps its last document.
 */
export const MAX_DOC_BYTES = 512 * 1024;

/** The read side's Cache-Control: fresh for 1 s, then served stale for up to 30 s while one request revalidates. */
export const DOC_MAX_AGE_S = 1;
export const DOC_SWR_S = 30;
export const DOC_URL = 'https://rate.internal/blocked/v1';
export const DOC_PATH = '/blocked/v1';
export const DOC_TAG = 'rate-blocked';
/**
 * The request waits this long for the cached document. Warm HIT and stale (SWR) reads on lat2: p99 12 ms, max 46 ms
 * (5,669); a MISS is a synchronous DO read (403-481 ms). Past this the request uses the isolate's last document.
 */
export const READ_BUDGET_MS = 25;
/** After a failed read, the isolate's last good document is used for this long; then the request fails open. */
export const MEMO_FALLBACK_MS = 300_000;
/**
 * Memo mode (no fetch on the request path): a request whose isolate memo is at least this old still decides from it,
 * and starts one single-flight refresh of the cached document in ctx.waitUntil. Adds ≤ this much (plus the refresh's
 * own read and the isolate's gap between requests) to the enforcement lag.
 */
export const MEMO_REFRESH_MS = 500;
/** A refresh still unsettled after this long is abandoned (a hung loopback must not pin the single flight forever). */
export const MEMO_REFRESH_ABANDON_MS = 10_000;

/** The one RateCounter object. */
export const COUNTER_NAME = 'global-v1';
/** Hex characters of the client hash sent, stored and cached (64 bits). */
export const KEY_HEX = 16;

export const BUCKET_PAGE = 0;
export const BUCKET_PACK = 1;
export type BucketId = typeof BUCKET_PAGE | typeof BUCKET_PACK;
