# Feature flags

A feature release is a flag ramp. The schedule is the same one the CD pipeline allocates for a Worker version: the steps `1, 5, 10, 25, 50, 75, 100` (`ROLLOUT_PERCENTS` in `src/flags/types.ts`, `RAMP_PERCENTS` in `scripts/cd/baseline.ts`). This document is the design. `scripts/cd*` is unchanged; the follow-up below is how CD will drive the ramp.

## Storage

R2 is the source of truth. There is one object, `flags/config.json`, in the bucket bound as `FLAGS` (`ply-flags`). The object's ETag is the revision. There is no per-environment key and no `rev/<n>` history object. The document's `environment` field is `production`. Another environment would be another field in this document, not another key.

Writes are compare-and-swap. `FlagsControl` reads the object, applies a pure edit, and `put`s with `onlyIf: { etagMatches }` (or `If-None-Match: *` when the caller expected the object to be absent). A lost race returns `{ kind: "conflict", expected, actual }` and does not apply the caller's bytes. The methods return that ADT. They do not throw for a conflict, a validation failure, or a missing binding.

Every successful change logs `flags.write` with the old revision, the new revision, and a diff (`create`, `rollout`, or `targeting`). That log is the audit trail.

The bucket is declared in `cloudflare.config.ts` and is not created by this repo. It has to exist before a deploy that uploads the binding. `cf deploy` can provision an R2 bucket that is missing; create `ply-flags` first.

No D1, no KV, and no new secret. The write API is the service binding, not a bearer.

## Rollout

A flag's `rollout` is one of:

| kind | percent in force |
|---|---|
| `ramping` | `percents[step]` |
| `complete` | `100` (the last step) |
| `rolled-back` | `0` |

`setRollout(flag, percent, expectedRevision)` moves the flag to that percent. `0` rolls it back. Any other percent must be one of the flag's steps. The first call for a new key creates the flag (boolean on/off, salt `v1`, the CD schedule) and then applies the percent. `setTargeting` replaces allow, deny, and attribute rules on a flag that already exists.

`getConfig()` reads R2 directly, so the revision it returns is the one to pass back as `expectedRevision`. Do not CAS against the cached HTTP view.

## Evaluation

Evaluation is pure and runs in the Worker on each request. The bucket is

```
murmur3_32(lengthPrefix(flag) || lengthPrefix(salt) || lengthPrefix(unit)) mod 10000
```

MurmurHash3_x86_32, seed 0. One percent is 100 buckets. A unit is in when `bucket < percent * 100`. The bucket does not change when the percent grows, so a unit that is in stays in. Lowering the percent, or rolling back to 0, can move a unit out. That is a deliberate step down, not a hash change.

Precedence, first match:

1. `deny` list → `override`, off variant (deny wins if the unit is also allowed)
2. `allow` list → `override`, on variant
3. first matching attribute rule (`eq`, `neq`, `in`) → `rule`
4. inside the percent → `bucket`, on variant
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

After a successful put, `FlagsControl` calls `FlagsCache.invalidate()`. That method runs `ctx.cache.invalidate({ tags: ['flags'] })`. Invalidate is scoped to the entrypoint that owns the cache, so the call runs on `FlagsCache`, not on the writer. The next read is a revalidation: one R2 read, then either `304` or a new body.

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

`scripts/cd*` is not modified here. A later change can drive a feature ramp through the service binding the same way the version ramp drives `applySplit(percent)`:

1. `const config = await env.FLAGS_CONTROL.getConfig()` and keep `config.revision`.
2. For each percent in `1, 5, 10, 25, 50, 75, 100`, `await env.FLAGS_CONTROL.setRollout(flag, percent, revision)`.
3. On `{ kind: "ok" }`, dwell, judge the SLO from `flags.resolve` (variant and reason by revision), then pass `result.revision` into the next step.
4. On `{ kind: "conflict" }`, stop the way a `state_conflict` stops the version ramp. Re-read with `getConfig()` and decide whether to retry.
5. A rollback is `setRollout(flag, 0, revision)`, which is the `rolled-back` state (percent 0). It is not a Worker version rollback.

The binding is `bindings.worker({ worker: "ply", exportName: "FlagsControl" })`. This Worker already publishes that binding as `FLAGS_CONTROL`.
