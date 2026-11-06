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

export const SLOT_MS = 10_000;
export const WINDOW_MS = 60_000;
/** Idempotency keys are kept this long: 120× the client deadline. */
export const DEDUPE_RETENTION_MS = 600_000;
export const PRUNE_EVERY_MS = 5_000;
/** The blocked document holds at most this many entries (newest `until` first). */
export const MAX_DOC_ENTRIES = 4_096;

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

/** The one RateCounter object. */
export const COUNTER_NAME = 'global-v1';
/** Hex characters of the client hash sent, stored and cached (64 bits). */
export const KEY_HEX = 16;

export const BUCKET_PAGE = 0;
export const BUCKET_PACK = 1;
export type BucketId = typeof BUCKET_PAGE | typeof BUCKET_PACK;
