# Feature flags

A feature release is a flag ramp. The flag type stores an allocation, not a schedule. `setRollout` accepts any integer number of basis points from 0 through 10000. One basis point is one hash bucket, and 10000 is every unit. Which steps a release walks is config: the checked-in CD policy at `scripts/cd/cd.policy.json` (the same file `scripts/cd` loads). This document does not copy that list. The version ramp in `scripts/cd` is unchanged. Smoke now checks the flag routes. The follow-up below is how CD will later drive a flag ramp through `scripts/flags`. That ramp is not implemented.

## Storage

R2 is the source of truth. There is one object, `flags/config.json`, in the bucket bound as `FLAGS` (`ply-flags`). The object's ETag is the revision. There is no per-environment key and no `rev/<n>` history object. The document's `environment` field is `production`. Another environment would be another field in this document, not another key.

Writes are compare-and-swap. `FlagControl` reads the object, applies a pure edit, and `put`s with `onlyIf: { etagMatches }` (or `If-None-Match: *` when the caller expected the object to be absent). A lost race returns `{ kind: "conflict", expected, actual }` and does not apply the caller's bytes. The methods return that ADT. They do not throw for a conflict, a validation failure, or a missing binding.

Every successful change logs `flags.write` with the old revision, the new revision, and a diff (`create`, `rollout`, or `targeting`). That log is the audit trail.

The bucket is declared in `cloudflare.config.ts` and is not created by this repo. It has to exist before a deploy that uploads the binding. `cf deploy` can provision an R2 bucket that is missing; create `ply-flags` first.

No D1 and no KV. ply does not gain a secret. HTTP writes on `/v1/flags` stay 405. The write API on ply is still the `FlagControl` service binding.

## Operator writes

Nothing outside ply can call that binding. `ply-flag-operator` is a second Worker whose only job is to call it. `cloudflare.config.ts` selects it when `--mode` is exactly `flag-operator`. Every other mode, including `production` and `development`, uploads ply. A normal `cf deploy` does not upload the operator, and `cf deploy --mode flag-operator` does not upload ply.

The operator Worker holds `FLAG_OPERATOR_TOKEN` (a secret on that Worker, not on ply) and `FLAG_CONTROL`, a service binding `bindings.worker({ worker: "ply", exportName: "FlagControl" })`. It has no R2 binding. Its routes are `GET /config`, `POST /rollout`, and `POST /targeting`. Each requires `Authorization: Bearer`. A missing secret is 503 and does not call `FlagControl`. A wrong or missing bearer is 401 and does not read the body. Responses are `cache-control: no-store`.

The body carries the expected revision as `{kind:"absent"}` or `{kind:"revision", value}`. An empty string is not a revision. The operator turns `absent` into the `ABSENT_REVISION` (`""`) that `FlagControl` puts with `If-None-Match: *`, which is how the first write seeds `flags/config.json`. A lost race is 409 `{kind:"conflict", expected, actual}`.

Every request emits a `flags.operator` span and a `flags.operator` log: `op`, `result`, `flag`, `expected`, `revision`, `invalidated`, and `operator_ms`. `operator_ms` is the handler wall time, including the token compare and the `FlagControl` RPC when one is made.

`scripts/flags` is the operator CLI (`npm run flags`). It reads the token from `FLAG_OPERATOR_TOKEN_FILE` (default `~/.ply-flag-token`, mode 0600) and the origin from `PLY_FLAG_OPERATOR_URL` or `--url`. The token is never an argument and never printed. There is no default host.

```
npm run flags -- get
npm run flags -- rollout ply.usage.note 0 --expected absent
npm run flags -- rollout ply.usage.note 1000 --expected <revision from get>
npm run flags -- targeting ply.usage.note --expected <revision> --allow user:smoke
```

`get` prints the `FlagControl` read, including `{kind:"absent"}` when the object has not been written. The next write then passes `--expected absent`. A later write passes the revision from the last `ok` result. Do not CAS against the cached `GET /v1/flags` view.

Deploy (this repo does not run it):

1. `cf deploy --mode flag-operator` uploads `ply-flag-operator` only.
2. `cf workers secrets update FLAG_OPERATOR_TOKEN --worker ply-flag-operator --type secret_text` (the CLI prompts; the same value goes in the 0600 file, never on argv).
3. Set `PLY_FLAG_OPERATOR_URL` to the workers.dev URL that deploy prints.
4. No new ply binding and no new ply secret. The `FLAGS` R2 bucket is unchanged.

## Rollout

A flag's `rollout` is one of:

| kind | basis points in force |
|---|---|
| `ramping` | `basisPoints`, an integer from 1 through 9999 |
| `complete` | 10000 |
| `rolled-back` | 0 |

`setRollout(flag, basisPoints, expectedRevision)` sets that allocation. `0` rolls the flag back. `10000` completes it. Any other integer in range is a partial ramp, whether or not it appears in the CD policy. The first call for a new key creates the flag (boolean on/off, salt `v1`) and then applies the allocation. `setTargeting` replaces allow, deny, and attribute rules on a flag that already exists.

`getConfig()` reads R2 directly, so the revision it returns is the one to pass back as `expectedRevision`. Do not CAS against the cached HTTP view.

## Evaluation

Evaluation is pure and runs in the Worker on each request. The bucket is

```
murmur3_32(lengthPrefix(flag) || lengthPrefix(salt) || lengthPrefix(unit)) mod 10000
```

MurmurHash3_x86_32, seed 0. A unit is in when `bucket < basisPoints`. The bucket does not change when the allocation grows, so a unit that is in stays in. Lowering the allocation, or rolling back to 0, can move a unit out. That is a deliberate step down, not a hash change.

Precedence, first match:

1. `deny` list → `override`, off variant (deny wins if the unit is also allowed)
2. `allow` list → `override`, on variant
3. first matching attribute rule (`eq`, `neq`, `in`) → `rule`
4. inside the basis-point allocation → `bucket`, on variant
5. otherwise → `default`, off variant

`flags.isEnabled(key, unit)` is true only when the resolved variant is boolean `true`. Anything else, including a missing flag, a missing binding, or a store error, is false. `GET /` calls it for `ply.usage.note` (default off). When the variant is on, the usage text gains one fixed line. When it is off, `GET /` is unchanged.

`GET /v1/flags` and `POST /v1/flags/eval` are the read API, behind the existing `/v1` bearer. Eval returns the variant, the reason, and the bucket for each flag, plus the revision and the cache status. The HTTP response is `cache-control: no-store`. Per-user results are not cached.

## Cache and staleness

The default entrypoint has caching off, same as the rest of ply. It asks the cache-enabled `FlagsCache` entrypoint over `ctx.exports`. Workers Cache stores that one response (path `/config`, tag `flags`).

The cached response is

```
Cache-Control: public, max-age=5, stale-while-revalidate=60
ETag: <revision>
Cache-Tag: flags
```

The `ETag` is only on a present ruleset. The 404 for an object that has not been written yet uses the same `Cache-Control` and `Cache-Tag`.

`max-age` and `stale-while-revalidate` are `FLAGS_MAX_AGE_S` and `FLAGS_SWR_S`. There is no `s-maxage`, no `must-revalidate`, and no `proxy-revalidate`: those directives disable stale-while-revalidate. There is no `Set-Cookie` and no `Vary`. A `no-store` answer is a bypass, so Workers Cache runs the entrypoint on every call. That was the empty ruleset: `GET /` consults `ply.usage.note` on purpose (the example gate, default off), and each of those calls read R2. The empty answer now uses the header above, so the next request is a hit until `FlagControl` invalidates the `flags` tag. A store error or an invalid document stays `no-store`.

The call is one `GET` of `https://flags.internal/config`. The cache key is that path and an empty query. The host is not part of the key. The request carries no `Authorization` and no `Cookie`, and it does not vary by unit. `Authorization` bypasses storage unless the response is `public`; this response is `public`, and the header is still omitted. A revalidation sends `If-None-Match`. The same revision answers `304` and the cache keeps the body.

`flags.resolve` and `flags.eval` already record `cache_status` (`HIT`, `MISS`, `STALE`, and the other `Cf-Cache-Status` values) from that response.

After a successful put, `FlagControl` calls `FlagsCache.invalidate()`. That method runs `ctx.cache.invalidate({ tags: ['flags'] })`. Invalidate is scoped to the entrypoint that owns the cache, so the call runs on `FlagsCache`, not on the writer. The next read is a revalidation: one R2 read, then either `304` or a new body.

Bound:

- R2 itself is strongly consistent. `getConfig()` sees a write as soon as the put resolves.
- A cached reader can keep a fresh hit for up to 5 seconds if invalidation has not landed.
- After a successful invalidate, the next request revalidates and sees the new revision after that one R2 read.
- If invalidation fails, the write still committed (`invalidated: false` on the result) and a reader may keep the previous body for the fresh window, then for up to 60 seconds of stale-while-revalidate if the revalidation request fails.

`scripts/flags-propagation.ts` measures the in-process form of that lag (write, invalidate, next read) and checks that skipping invalidate leaves a fresh hit on the old revision. It does not deploy and it does not take a token.

## Telemetry

Each evaluation emits a `flags.eval` span and a `flags.resolve` child per flag. Attributes:

| attribute | where |
|---|---|
| `flags.cache_status` | eval span. `HIT`, `UPDATING`, `REVALIDATED`, `EXPIRED`, `MISS`, plus `STALE`, `BYPASS`, `NONE` when the platform says so |
| `flags.revision` | both |
| `flags.eval_ms` | eval span, pure evaluation. On Workers this stays 0: the clock does not move until the isolate yields |
| `flags.resolve_ms` | eval span and the `flags.eval` / `flags.resolve` logs. Wall time of the awaited FlagsCache read. A hit is the cache lookup. A miss, stale, or revalidation includes the R2 read inside that await |
| `flags.r2_read_ms` | eval span when this request read R2 (not a hit) |
| `flags.count` | eval span |
| `flags.unit_id` | eval span only |
| `flags.key`, `flags.variant_kind`, `flags.variant_value`, `flags.reason`, `flags.bucket` | resolve span |

The same low-cardinality fields are logged as `flags.eval` and `flags.resolve`. The unit id is not on those lines, so it is not a dimension of the report. `scripts/flags-o11y.ts` queries Workers observability for those two messages and prints p50/p95/p99 of `resolve_ms` per cache status, then the count of resolved variants per flag, revision, variant, and reason. Zero is not a sample. If `resolve_ms` is missing or 0, the report uses a positive `eval_ms`, then the invocation `wallTimeMs`, then the span duration. `flags.resolve` events are the variant counts only; they are not a second timing sample. The script prints that definition on stderr and leaves the stdout table unchanged.

`flags.eval` is opened before the FlagsCache await and ended after it, so the platform span duration includes that yield. The `flags.resolve` children are opened after the await. Their platform duration stays near 0. The number to aggregate is the `resolve_ms` attribute and log field.

Smoke accepts `GET /v1/flags` cache status `HIT`, `MISS`, `STALE`, or `UPDATING`. `REVALIDATED` and `EXPIRED` are real platform statuses and would fail that check.

## CD follow-up

The version ramp is unchanged. A later change can drive a feature ramp through `scripts/flags` the same way the version ramp walks `scripts/cd/cd.policy.json`. This section is the procedure. It is not implemented, and `scripts/cd` does not shell out to `scripts/flags`.

1. Load that policy with the CD pipeline's `loadPolicy`. Do not keep a second copy of `steps`.
2. `scripts/flags get`. An `{kind:"absent"}` result means the next write is `--expected absent`. An `{kind:"ok"}` result keeps `revision`.
3. For each `step` in `policy.steps`, `scripts/flags rollout <flag> <step.percent * 100> --expected <revision>`. A policy percent is a whole percent; the flag argument is basis points, so 10% is 1000.
4. On `{kind:"ok"}`, dwell for `step.dwellMs`, judge the SLO from `flags.resolve` (variant and reason by revision), then pass `revision` from that result into the next step.
5. On `{kind:"conflict"}` (exit 1), stop the way a `state_conflict` stops the version ramp. Run `get` again and decide whether to retry. Do not write with the stale revision.
6. A rollback is `scripts/flags rollout <flag> 0 --expected <revision>`, which is the `rolled-back` state. It is not a Worker version rollback.

Editing `cd.policy.json` changes the steps that follow-up will walk. The flag API does not need a matching change: it already accepts any basis point in 0..10000, including allocations the policy does not name.

The first seed of `ply.usage.note` at 0 basis points, while the object is absent, is `rollout ply.usage.note 0 --expected absent`. That creates the flag already rolled back.
