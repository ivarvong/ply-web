# Feature flags

A feature release is a flag ramp. The flag type stores an allocation, not a schedule. `setRollout` accepts any integer number of basis points from 0 through 10000. One basis point is one hash bucket, and 10000 is every unit. Which steps a release walks is config: the checked-in CD policy at `scripts/cd/cd.policy.json` (the same file `scripts/cd` loads). This document does not copy that list. `scripts/cd*` is unchanged; the follow-up below is how CD will drive the ramp.

## Storage

R2 is the source of truth. There is one object, `flags/config.json`, in the bucket bound as `FLAGS` (`ply-flags`). The object's ETag is the revision. There is no per-environment key and no `rev/<n>` history object. The document's `environment` field is `production`. Another environment would be another field in this document, not another key.

Writes are compare-and-swap. `FlagControl` reads the object, applies a pure edit, and `put`s with `onlyIf: { etagMatches }` (or `If-None-Match: *` when the caller expected the object to be absent). A lost race returns `{ kind: "conflict", expected, actual }` and does not apply the caller's bytes. The methods return that ADT. They do not throw for a conflict, a validation failure, or a missing binding.

Every successful change logs `flags.write` with the old revision, the new revision, and a diff (`create`, `rollout`, or `targeting`). That log is the audit trail.

The bucket is declared in `cloudflare.config.ts` and is not created by this repo. It has to exist before a deploy that uploads the binding. `cf deploy` can provision an R2 bucket that is missing; create `ply-flags` first.

No D1, no KV, and no new secret. The write API is the service binding, not a bearer.

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

`max-age` and `stale-while-revalidate` are `FLAGS_MAX_AGE_S` and `FLAGS_SWR_S`. There is no `s-maxage` and no `must-revalidate`. A revalidation sends `If-None-Match`. The same revision answers `304` and the cache keeps the body.

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
| `flags.eval_ms` | eval span, pure evaluation |
| `flags.r2_read_ms` | eval span when this request read R2 (not a hit) |
| `flags.count` | eval span |
| `flags.unit_id` | eval span only |
| `flags.key`, `flags.variant_kind`, `flags.variant_value`, `flags.reason`, `flags.bucket` | resolve span |

The same low-cardinality fields are logged as `flags.eval` and `flags.resolve`. The unit id is not on those lines, so it is not a dimension of the report. `scripts/flags-o11y.ts` queries Workers observability for those two messages and prints p50/p95/p99 of `eval_ms` per cache status, then the count of resolved variants per flag, revision, variant, and reason.

## CD follow-up

`scripts/cd*` is not modified here. A later change can drive a feature ramp through the service binding the same way the version ramp walks `scripts/cd/cd.policy.json`:

1. Load that policy (the CD pipeline's `loadPolicy`). Do not keep a second copy of `steps`.
2. `const config = await env.FLAG_CONTROL.getConfig()` and keep `config.revision`.
3. For each `step` in `policy.steps`, `await env.FLAG_CONTROL.setRollout(flag, step.percent * 100, revision)`. A policy percent is a whole percent; the flag argument is basis points, so 10% is 1000.
4. On `{ kind: "ok" }`, dwell for `step.dwellMs`, judge the SLO from `flags.resolve` (variant and reason by revision), then pass `result.revision` into the next step.
5. On `{ kind: "conflict" }`, stop the way a `state_conflict` stops the version ramp. Re-read with `getConfig()` and decide whether to retry.
6. A rollback is `setRollout(flag, 0, revision)`, which is the `rolled-back` state. It is not a Worker version rollback.

Editing `cd.policy.json` changes the steps the follow-up will walk. The flag API does not need a matching change: it already accepts any basis point in 0..10000, including allocations the policy does not name.

The binding is `bindings.worker({ worker: "ply", exportName: "FlagControl" })`. This Worker already publishes that binding as `FLAG_CONTROL`.
