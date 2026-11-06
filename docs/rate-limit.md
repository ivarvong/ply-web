# Rate limit: batched writes, cached reads

Status: design, 2026-11-06. Replaces the per-request `ViewerRateLimit` call on the request path. Measurements land in
the Results section with version ids and run ids.

## Why

`ViewerRateLimit` is a SQLite Durable Object sharded by SHA-256(`CF-Connecting-IP`), called synchronously before any git
work. On `6f2897ff` / `c43f01cd` that call was 22–49 ms of a 45–57 ms warm `/r/ply` page and 117 ms on a fresh isolate.
The limiter is the largest single bucket of a warm page.

## Shape

```
request ─▶ default entrypoint
            ├─ READ   ctx.exports.RateCache.fetch(/blocked/v1)   ◀── Workers Cache (max-age 1, SWR 30), one key per colo
            │           └─ MISS/STALE revalidation: RateCounter.blockedDoc()
            │         blocked? ─▶ 429 (no git work)
            └─ WRITE  allowed ─▶ isolate accumulator {key,bucket → n}
                        the request that opens a batch: ctx.waitUntil(linger 200 ms → flush)
                        flush: RateCounter.apply({id: <isolate>:<seq>, entries}) raced against a per-attempt timer,
                               retried with the SAME id until acked or 5 s from the first attempt
RateCounter (ONE SQLite Durable Object, name "global-v1", reached as ctx.exports.RateCounter)
   rate_batches(id)          idempotency keys, kept 10 min: a replayed id is acked and changes nothing
   rate_hits(k,b,slot,n)     10 s slots, sliding 60 s window
   rate_blocked(k,b,until)   keys at or over the limit; the read side's whole document
```

Nothing on the request path waits for the Durable Object except a cache MISS/EXPIRED of the one document.

## Write side

- **Accumulator.** Per isolate, one open batch: `Map<"<key16>:<bucket>", count>`. The first admitted request after a flush
  opens a batch and schedules its flush 200 ms later (`LINGER_MS`) from `ctx.waitUntil`. Workers runs no timers
  outside an invocation, so the waitUntil is what keeps the isolate alive through the linger and the retries. Every
  request that joins the batch also `waitUntil`s the same promise (free, and the batch survives any one request
  context ending). A batch that reaches 2048 keys (`MAX_BATCH_KEYS`) is closed and flushed at once, so memory is
  bounded at `MAX_INFLIGHT` (64) batches × 2048 keys. Beyond 64 in-flight batches a new batch is dropped and
  recorded (`rate.batch.dropped=overflow`).
- **Idempotency key.** `<isolate uuid>:<seq>`. The uuid is minted on the isolate's first request (randomness is not
  available at global scope). The DO inserts the id into `rate_batches` in the same synchronous SQL transaction that adds
  the counts, so an id applies at most once. Ids are kept 10 min (`DEDUPE_RETENTION_MS`), 120× the client's 5 s deadline;
  an attempt still in flight after that is not possible (the isolate's waitUntil is gone by then).
- **Retry (Ivar, 2026-11-06: "we can always retry the DO RPC … race a setTimeout … 5 second max").** Each attempt races
  `apply()` against a timer of `ATTEMPT_TIMEOUT_MS`, capped by what is left of the deadline. Timeout or error → backoff
  (50 ms, doubling) → the same id again. 5 s after the first attempt (`FLUSH_DEADLINE_MS`) the batch is dropped and
  recorded. A timed-out attempt may still apply later; that is exactly what the id covers (tested: a DO that applies
  after the client gave up, plus the retry, counts once).
- **Per-attempt timeout.** 1500 ms = ≈ 2× the measured apply-RPC p99.9 (722 ms, ae21dee2 run lat2, 5,649 flushes). The
  first cut used 1000 ms: Marseille's RPCs (436–984 ms) timed out and were replayed (counted once, but extra DO load). Lower is not better: an
  attempt that times out and is retried while the first is merely slow adds a replay, never a double count.
- **Drop, not merge.** An expired batch is dropped, not merged into the next batch. Merging moves its counts under a new
  id, and if the original's last attempt applies late the counts land twice: the one property the id exists to give
  would be gone. Dropping is a bounded under-count (below).
- **Isolate death before flush.** Lost hits ≤ the admitted hits that isolate took in the last ≤ 200 ms plus its batches
  still retrying (≤ 5 s). A crash or eviction during a waitUntil is rare (it outlives the response by up to 30 s); a
  deploy does not cut a running waitUntil short. For one client the under-count is ≤ its own requests to that isolate
  in that window: at the 60/min limit, ≤ 1 request (200 ms) and ≤ 5 requests (5 s of retries).

## Durable Object side

- One object (`RateCounter`, a new SQLite class, additive: `ViewerRateLimit` and its namespace stay). It is reached
  through `ctx.exports.RateCounter`, not an env binding: the versions API refuses a binding to a class that no deploy
  has provisioned yet (first upload, 2026-11-06). `apply` is
  synchronous SQL (no await between the dedupe check and the writes), so it is atomic under the input gate.
- **Window.** Sliding 60 s over 10 s slots. A slot counts while its end is within the last 60 s, so a hit counts for
  60–70 s: never more lenient than an exact sliding window (worst case 1/6 stricter at the edge).
- **Blocked set.** After applying, every touched key whose window sum is ≥ its limit is upserted into `rate_blocked`
  with `until` (the time the sum next drops below the limit), `crossed` (when it first went over) and `peak` (the
  highest admitted sum). `peak − limit` is the measured overshoot.
- **Pruning** every ≥ 5 s inside `apply`: expired slots, ids older than 10 min, ended blocks.
- **Budget.** Flush RPCs/s ≤ isolates × 5. Measured in Results (apply ms, rows written, DO CPU per invocation).

## Read side

- **One document, one key.** `RateCache` is a cache-enabled named entrypoint (the GitCache / Pinned / FlagsCache pattern;
  never `caches.default`). `GET https://rate.internal/blocked/v1` answers `RateCounter.blockedDoc()`: every blocked
  `[key16, bucket, until, crossed]`, newest 4096 (`MAX_DOC_ENTRIES`), with
  `Cache-Control: public, max-age=1, stale-while-revalidate=30`.
- **Why not per-client keys.** A per-client key misses on every new client and on every client's first request after each
  TTL: the median viewer client makes a handful of requests, so the hit ratio would sit near the miss path and every
  miss is a DO round trip on the request path, which is the cost being removed. One document is one MISS per colo per
  second, whatever the client count. The cost is size: the document is O(blocked clients), capped at 4096 entries ×
  ~40 bytes. Measured hit ratio in Results.
- **In the isolate** the parsed document is memoized by its `etag`: a HIT costs the loopback fetch, not a JSON parse.
- **Read budget (never block on the DO).** The cached fetch gets 25 ms (`READ_BUDGET_MS`; warm HIT/SWR reads on lat2:
  p99 12 ms, max 46 ms). A MISS is a synchronous DO read (403–481 ms on lat2) and an isolate's first loopback ~55 ms: past
  the budget the request decides from the isolate's last document (any age ≤ 5 min), or admits when the isolate has
  none, and the fetch completes in `waitUntil`, refreshing that document. Extra lag this adds: only in an isolate that
  has never read the document, for ≤ one DO read (~0.5 s); measured in Results.
- **Failure.** If the read fails, the last good document (≤ 5 min old) is used; with none, the request is admitted (fail
  open) and recorded. Today's limiter fails closed (503); with one object instead of one per client, failing closed would
  turn a DO incident into a viewer outage. The limit bounds cost; it is not an access control.

## Semantics

Approximate. Worst-case enforcement lag after the request that takes a client to its limit:

```
lag ≤ LINGER (200 ms) + apply RPC (+ retries, ≤ 5 s worst) + max-age (1 s) + one revalidation + the client's next-request gap
```

Steady state (RPC ≈ tens of ms, traffic flowing) that is ≈ 1.5 s. A client sending 2× the limit (2 req/s at 60/min)
overshoots by about lag × rate ≈ 3 requests per window. The DO measures the true overshoot (`peak − limit`); the load
generator measures lag end to end (first 429 after the request that should have been the first refusal).

Identical to today: the limit is on admitted requests (a 429 does not count), `page` 60/min and `pack` 20/min per client,
`retry-after` from the block's `until`.

## Privacy

As today: the client key is SHA-256 of `ply-viewer-rate/1\n<CF-Connecting-IP>`; only its first 16 hex (64 bits) is sent,
stored and cached. No address is stored. The blocked document is served only over `ctx.exports`, never to a browser.

## Load-test controls

A request carrying `x-ply-load-token: <PLY_TOKEN>` (compared in constant time; never forwarded, logged or echoed) may
also send `x-ply-rate-client` (a label hashed in place of the address, so one generator can be many clients),
`x-ply-rate-mode: legacy|batched` (choose the limiter for this request: an A/B inside one version), and
`x-ply-rate-fault` (fault injection on the DO, below). Without a valid token those headers are ignored.

`x-ply-rate-fault: slow-ack=<ms>;attempts=<n>` makes the DO apply, then hold its answer `<ms>` on attempts ≤ n
(the client times out and retries; the retry must be a replay). `error;attempts=<n>` makes the DO throw before
applying on attempts ≤ n. The fault rides on the batch that request joins.

## Instrumentation

Workers spans (`ctx.tracing`), each stamped with `ply.route` and `ply.script_version` like ply's spans:

| span | attributes |
|---|---|
| `ply.rate.check` | `rate.mode` legacy/batched, `rate.bucket`, `rate.decision` allow/deny/fail_open, `rate.check_ms`, `rate.cache` (HIT/STALE/MISS/EXPIRED/…), `rate.read` ok/memo/fail, `rate.doc_entries`, `rate.doc_age_ms`, `rate.blocked_for_ms` (deny: now − crossed) |
| `ply.rate.flush` | `rate.batch.id`, `.keys`, `.hits`, `.linger_ms`, `.attempts`, `.attempt_log` (`ok:34,timeout:1000,…`), `.timeouts`, `.errors`, `.outcome` ok/dropped, `.deadline_hit`, `.replay` (DO said duplicate), `.flush_ms`, `.alive_ms` (batch open → flush end, the waitUntil lifetime), `rate.do.apply_ms`, `rate.do.rows_written`, `rate.do.new_blocks` |

DO log lines: `ply.rate.apply` (id, attempt, replay, keys, hits, apply_ms, rows_written, new_blocks, fault) and
`ply.rate.over` (a key at or over its limit: sum, limit, crossed, peak). Queried by `$workers.scriptVersion.id`.

## Results

(filled in from the measurement runs)
