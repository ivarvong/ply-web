# The probe workbench (/bench)

ply-web runs ply's probe scenarios (`ply/probes`, pinned in package.json) against Cloudflare Artifacts from the Worker, and shows each run. ply is the client under test; this Worker is the probe runner; Artifacts is the server under test. All of `/bench` is private: send `Authorization: Bearer <PLY_TOKEN>`, or sign in through the browser's Basic prompt with PLY_TOKEN as the password (any user name).

- `GET /bench`: the catalogue (each scenario: runnable here, stock git only, or a seed too large for a Worker), the run form, recent runs.
- `POST /bench/runs` (same-origin form: `scenario`, `seed`): one run. At most one at a time and 20 an hour. Answers with a redirect to the run once it is over.
- `GET /bench/runs/<id>`: the verdict, the steps, the end state, the protocol waterfall, every exchange (status, timings, bytes, cf-ray, headers, pkt-line commands, advertised refs, report-status, object ids, the fault applied), the cleanup counts and the run's spans.
- `GET /bench/runs/<id>/exchanges/<i>/request|response`: a raw body (R2, at most 1 MiB).
- `GET /bench/runs/<id>/<slug>.json` and `<slug>.test.js`: the replay for ply's suite. Put both files in `test/probes/replay/` of a ply checkout and run `npx vitest run test/probes/replay/<slug>.test.js`. That runs the plan with ply and stock git against git http-backend (the reference), and checks the recorded run with that commit's evaluator.

## A run

1. Build the seed in memory, with the same object ids as ply's runner (`src/bench/seed.ts`).
2. Create `pb-<seed>-<run>` in the `ply-loadgen` namespace (binding `PROBE_REPOS`) and seed it.
3. Run each step with ply through the recording fetch (`src/bench/recorder.ts`), applying the step's fault. Read the result back with ply (`src/bench/judge.ts`); there is no fsck and no merge bases, because a Worker has no git.
4. Classify (`src/bench/verdict.ts`) each difference from the stated expectation:
   - `client_bug`: ply's outcome contradicts the report-status of the same exchange.
   - `server_bug`: the server confirmed an update its refs do not hold.
   - `expected_incompatibility`: an entry in ply's allow-list.
   - `unresolved`: anything else (export it to close the triangle).
5. Clean up. Revoke every token of the repository, including the one create minted, and prove the revoked token gets 401 or 403 (cf-ray recorded). Then delete the repository and prove it is gone. ProbeBench's alarm sweeps any repository a run did not prove cleaned.

## State

- ProbeBench (SQLite Durable Object, via `ctx.exports`) is the source of truth: runs, the repositories it created, and admissions.
- R2 `ply-bench` holds the exchange bodies.

Nothing is cached: every page is private and `no-store`.
