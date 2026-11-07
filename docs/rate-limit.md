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
- **Pruning** every ≥ 5 s inside `apply`: expired slots, ids older than 10 min, ended blocks, at most 128 rows per table
  per apply (`PRUNE_BATCH_ROWS`). A full slice leaves a backlog and the next apply prunes again instead of waiting 5 s,
  so a backlog (an idle spell, a restarted object) drains in bounded slices. Before this bound one apply on 78ddd5c3
  wrote 12,892 rows.
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
- **Memo mode (`RATE_MODE=memo`, or `x-ply-rate-mode: memo`).** The batched read's p99 (12 ms on a020b1b1 / 78ddd5c3)
  is the loopback fetch itself: of 401 checks ≥ 10 ms, 363 were cache HIT or UPDATING. In memo mode the request never
  fetches: it looks its key up in the isolate's parsed document. When that document is ≥ 500 ms old
  (`MEMO_REFRESH_MS`) the request still decides from it and starts ONE refresh through the same `RateCache` entrypoint
  in `ctx.waitUntil` (single flight: a request that finds one in flight joins it; a flight unsettled after 10 s,
  `MEMO_REFRESH_ABANDON_MS`, is abandoned). An isolate with no document (or one older than 5 min) admits
  (`fail_open`, `rate.read=cold`) and refreshes. Extra lag over batched: ≤ 500 ms + the refresh's read + the
  isolate's own gap between requests (the memo only refreshes when a request arrives).
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

A request carrying `x-ply-load-token: <PLY_LOAD_TOKEN>` (compared in constant time; never forwarded, logged or echoed;
Workers Logs records the header as `REDACTED`) may also send `x-ply-rate-client` (a label hashed in place of the
address, so one generator can be many clients), `x-ply-rate-mode: legacy|batched|memo` (choose the limiter for this
request: an A/B inside one version), and `x-ply-rate-fault` (fault injection on the DO, below). Without a valid token
those headers are ignored.

`PLY_LOAD_TOKEN` is a credential of its own (2026-11-07): it unlocks these headers and nothing else. `PLY_TOKEN` (the
/v1 bearer) does not unlock them, and the load generator (`ply-load`) holds only `PLY_LOAD_TOKEN` (for its control API and
the header). With no `PLY_LOAD_TOKEN` bound, no request is a load request. Local copy: `~/.config/ply/load-token` (0600).

`x-ply-rate-fault: slow-ack=<ms>;attempts=<n>` makes the DO apply, then hold its answer `<ms>` on attempts ≤ n
(the client times out and retries; the retry must be a replay). `error;attempts=<n>` makes the DO throw before
applying on attempts ≤ n. A faulted request flushes in a batch of its own, at once, never the isolate's shared batch:
a fault slows, errors or drops only that request's own count, never a real client's.

## Instrumentation

Workers spans (`ctx.tracing`), each stamped with `ply.route` and `ply.script_version` like ply's spans:

| span | attributes |
|---|---|
| `ply.rate.check` | `rate.mode` legacy/batched, `rate.mode_source` default/header (header: a load request chose the arm), `rate.cold_isolate` (the isolate's first check), `rate.bucket`, `rate.decision` allow/deny/fail_open, `rate.check_ms`, `rate.cache` (HIT/STALE/MISS/EXPIRED/…), `rate.read` ok/memo/fail, `rate.doc_entries`, `rate.doc_age_ms`, `rate.blocked_for_ms` (deny: now − crossed) |
| `ply.rate.check` (memo) | `rate.read` memo_fresh / memo_stale_refresh / cold, `rate.cache` MEMO, `rate.memo_age_ms` (now − the isolate's last read), `rate.doc_age_ms` (now − the DO's `at`), `rate.refresh.started` |
| `ply.rate.refresh` | `rate.refresh.trigger` cold/stale, `.read` ok/memo/fail, `.cache` (the RateCache read's cf-cache-status), `.parsed`, `.ms`, `.joins` (requests that found it in flight), `rate.doc_age_ms` |
| `ply.rate.flush` | `rate.batch.id`, `.keys`, `.hits`, `.linger_ms`, `.attempts`, `.attempt_log` (`ok:34,timeout:1000,…`), `.timeouts`, `.errors`, `.outcome` ok/dropped, `.deadline_hit`, `.replay` (DO said duplicate), `.flush_ms`, `.alive_ms` (batch open → flush end, the waitUntil lifetime), `rate.do.apply_ms`, `rate.do.rows_written`, `rate.do.new_blocks` |

DO log lines: `ply.rate.apply` (id, attempt, replay, keys, hits, apply_ms, rows_written, new_blocks, fault) and
`ply.rate.over` (a key at or over its limit: sum, limit, crossed, peak). Queried by `$workers.scriptVersion.id`.

## CD gate (silent degradation)

The limiter fails soft: a broken read admits (`fail_open`), a flush that cannot reach the counter is dropped after 5 s,
and a missing counter sends every request to `legacy` (59926117 / e61a5742: nothing alerted). All of those answer 200,
so the smoke and the error gates pass. `scripts/cd/rate-gate.ts` runs inside the telemetry stage of the 0% canary
(fail → stop) and of the live watch (fail → rollback): 30 pinned probes of `/view?remote=<public ply>` (the redirect
route: rate-checked, no git work) as a load client with no mode header, then the version's own spans since the stage
began, by aggregate count. It fails the version when

- any default-mode check (`rate.mode_source` default) ran a limiter other than `rate.expectMode` (batched);
- warm default-mode checks (not `rate.cold_isolate`) failed open above 10% (with ≥ 20 of them; fewer is a harness fault);
- any flush was dropped (deadline) or any batch overflowed without an injected fault.

The thresholds and their evidence (7 days of spans, 128,753 flushes, every version since the limiter shipped) are in
`scripts/cd/cd.policy.json` `rate`. A deliberate `RATE_MODE=legacy` rollback changes `rate.expectMode` too.

## Results

Load: ply-load (`bench/load`), generator DOs in wnam/enam/weur/apac (4 shards each, 5 req/s each, open loop),
`GET /r/ply`, the two arms interleaved per request inside ONE version via `x-ply-rate-mode`, pinned with
`Cloudflare-Workers-Version-Overrides`. Server numbers: `ply.rate.check` spans (`rate.check_ms`) and `ply.request` logs
joined by trace, filtered by `ply.script_version`. Synthetic clients each stay under the limit.

| run · version | arm | n checks | check p50 / p99 / p99.9 / max ms | page wall p50 / p99 / p99.9 ms |
|---|---|---|---|---|
| lat3 · 6ed2e746 (no read budget) | legacy | 13,187 | 15 / 404 / 533 / 1375 | 27 / 462 / 1567 |
| lat3 · 6ed2e746 (no read budget) | batched | 13,188 | 3 / 13 / 49 / 373 | 16 / 107 / 1446 |
| lat4 · a020b1b1 (25 ms read budget) | legacy | 13,177 | 14 / 403 / 588 / 3274 | 28 / 463 / 3447 |
| lat4 · a020b1b1 (25 ms read budget) | batched | 15,099 | **3 / 12 / 25 / 25** | 16 / 71 / 3049 |
| lat5 · 78ddd5c3 (promoted, unpinned) | legacy | 10,778 | 13 / 424 / 584 / 819 | 26 / 531 / 2739 |
| lat5 · 78ddd5c3 (promoted, unpinned) | default (batched) | 10,782 | **3 / 12 / 25 / 25** | 15 / 193 / 2747 |
| lat6 · 2a4741c0 (pinned, interleaved) | batched | 13,571 | 3 / 14 / 25 / 25 | 12 / 165 / 4690 |
| lat6 · 2a4741c0 (pinned, interleaved) | memo | 13,572 | **0 / 0 / 0 / 0** | 9 / 153 / 4702 |
| lat7 · 2a4741c0 (pinned, memo only) | memo | 13,583 | 0 / 0 / 0 / 0 | 10 / 69 / 1302 |

The page p99.9 (≈3 s in both arms) is git work, not the limiter (lat1, A/A legacy, has the same tail).

- **Read cache (lat4):** HIT 77.9%, UPDATING (served stale while one request revalidates) 21.9%, past the 25 ms budget
  0.19% (29); 13 of those had no document in the isolate and were admitted (`fail_open`). HIT+SWR 99.8%.
- **Enforcement (abuse runs, 12 clients/arm at 2× the 60/min limit for 100 s):** batched lag p50 511 / max 1007 ms
  (abuse2, a020b1b1; abuse1 6ed2e746: p50 1007, max 1012), overshoot p50 1 / max 2 requests per client (the DO's
  `peak − limit` agrees: 2). Legacy: lag 19–44 ms, overshoot 0. Admitted totals over the run are equal (1,440 vs 1,440).
- **Flushes (lat4, a020b1b1, no fault):** 12,525 flushes, 99.9% one attempt; 11 timeouts in 12,536 attempts at 1.5 s
  (lat3 at 1.0 s: 175 in 11,655, every one later a DO replay). RPC p50 / p99 / p99.9 142 / 762 / 1363 ms. Keys per
  batch p50 1, p99 3: at ~1 req/s per colo an isolate rarely sees two hits in 200 ms, so the DO is written about once per
  admitted request; the batching pays off only with denser per-isolate traffic.
- **Counter DO (lat3 window):** 11,228 invocations (≈47/s); CPU p50 0 / p99 2 / p99.9 7 ms; wall p50 133 / p99 1317 ms.
  The wall is the SQLite commit behind the output gate, and it is the RPC latency the flush sees.
- **Fault injection in prod (a020b1b1, fault1 SJC / fault2 LHR+MRS, 20–60 s of each run):**
  `slow-ack=2500` → 305/305 batches: attempt 1 timed out at 1.5 s, attempt 2 acked as a replay. `error;attempts=2` → 280
  batches ok on attempt 3, 3 on attempt 4, 1 hit the 5 s deadline (recorded `dropped`), yet the DO log shows its attempt
  3 applied and attempt 4 replayed: counted once. Across 13,978 applies, no id applied twice.
- **After promotion (lat5, 78ddd5c3 at 100%, unpinned, default vs `x-ply-rate-mode: legacy`, 10,800 requests/arm):**
  all 200, 0 wrong-version. Client TTFB p50 / p99 / p99.9 45 / 935 / 4505 ms default vs 59 / 1035 / 4717 legacy. Read
  cache HIT 74.7%, UPDATING 25.1%, LATE 0.25% (27; 9 `fail_open`). 10,563 flushes, all ok on attempt 1 (0 timeouts,
  0 replays, 0 deadline); RPC p50 / p99 / p99.9 150 / 290 / 453 ms, a much tighter tail than lat4's 762 / 1363. Real
  (non-load) traffic on batched in the window: 58 checks, p99 5 ms. DO `rows_written` p50 6, p99.9 519, max 3983: the
  large ones are the retention prunes (`rate_hits`, `rate_batches` older than 10 min), not hit writes.
- **Memo mode (2a4741c0, 2026-11-07; ply-load ad3db19e).** lat6: batched vs memo interleaved per request, pinned,
  27,200 requests (13,600/arm), all 200. The memo check is a map lookup: `rate.check_ms` 0 at every percentile (Workers
  clocks only advance on I/O, so the page wall from `ply.request` joined by trace is the comparison). Page wall memo −
  batched, bootstrap 95% CI (400 resamples): p50 −3 ms [−3, −3], p90 −3 [−4, −3], p99 −12 [−39, +12]. So a 3 ms win at
  the median and no measurable change at p99, which is git work. Batched reads: ok 13,542, LATE 29 (7 `fail_open`).
  The interleaved memo arm shares the isolate's document with the batched arm (it is module state), which keeps it
  fresh: memo_age p50 200 ms, 26 refreshes. So refresh and lag were measured memo-only. lat7, memo only, 13,583
  checks: memo_fresh 9,046, memo_stale_refresh 4,495, cold 42 (`fail_open`; batched lat6: 7). memo_age p50/p99/p99.9
  400 / 602 / 653 ms. 4,517 refreshes (one per 3 requests), refresh ms p50/p99/p99.9/max 4 / 8 / 50 / 301, RateCache
  HIT 2,944, UPDATING 1,569, EXPIRED 4. 20 single-flight joins (max 5 on one flight).
- **Enforcement, memo vs batched (2a4741c0, 12 clients at 2× the limit, 100 s, client-side lag quantised by the 500 ms
  request gap):** abuse3 interleaved (memo kept fresh by batched): batched lag p50 500 / max 1500 ms, overshoot p50 1 /
  max 3; memo the same. abuse5 batched only: lag p50 500 / max 1500 ms, overshoot max 3, DO `peak − limit` 3. abuse4
  memo only: **lag p50 1500 / max 2000 ms, overshoot p50 3 / max 4**, DO `peak − limit` 4. Memo adds about one request
  gap plus ≤ 500 ms of memo age on top of the cache's max-age and SWR.
- **Decision:** memo stays opt-in (`x-ply-rate-mode: memo` / `RATE_MODE=memo`) and the default stays batched. Its page
  p99 gain is not measurable and its lag max (2.0 s) is over the ~1.5 s bar. 2a4741c0 was promoted with the default
  unchanged, which ships the bounded prune.
- **Counter prune bound (PRUNE_BATCH_ROWS 128).** `ply.rate.apply` rows_written max before: 12,892 (78ddd5c3), 7,915
  (a020b1b1). After: lat8, 2a4741c0 at 100% unpinned, default arm, 13,600 requests all 200, starting on the backlog
  that lat6/lat7 left: 6,550 applies, rows_written median 9 / p99 140 / max 268.
- **Bursts (2026-11-07, canary 9d33f400 pinned, ply-load de344fdb, runs burst2-c{1,5}-r{50,100,200}).** One client
  (shared label, 4 regions × 2 generators) at 50 / 100 / 200 req/s for 60 s: admitted in a 60 s window 116 / 125 / 140
  (overshoot 56 / 65 / 80; the DO's `peak` equals the client's count every time). Five clients at 10 / 20 / 40 req/s
  each: overshoot 6-10 / 14-20 / 28-32. Overshoot ≈ client rate × 0.4-1.1 s. DO crossing → first deny per colo p50
  0.5-1.8 s, max 4.5 s. The counter stayed healthy: every flush one attempt, 0 timeouts / replays / drops, apply RPC
  p99 ≤ 294 ms, CPU p99 ≤ 4 ms, rows_written p99 ≤ 51; denied requests never flush. The most a client's requests landed
  in one colo before it was refused was 59, so a per-isolate pre-count at the limit would not have bitten here.
