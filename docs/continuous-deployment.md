# Continuous deployment

You ship ply-web from a Linux box where `cf` is already logged in. One command uploads the commit you have checked out, smokes it at 0%, then walks traffic from 0% to 100% over about five minutes. If a step goes bad, traffic goes back to the previous version and the command exits. GitHub holds the code and the pull request. It does not deploy.

![Operator pipeline. The left column is gate, deploy, smoke, telemetry, ramp, live smoke, live telemetry, done. Failures leave to the right.](img/cd-pipeline.png)

The left column is the only path that raises traffic. An arrow to the right is that step stopping. A gray box leaves the split as it is. A red box puts the previous version back at 100% and the process exits. A pinned smoke failure takes the gray stop on that row: the canary stays at 0% and the ramp does not start. Source for the picture: [cd-pipeline.mmd](img/cd-pipeline.mmd). The vector file is [cd-pipeline.svg](img/cd-pipeline.svg).

## Before you start

On the box:

- `cf auth login` already done. The login needs Workers Scripts Edit (versions and deployments; an account token calls this Workers Scripts Write), Workers Observability Read, and Artifacts Edit on the namespace below. It does not need routes, KV, R2, or tail.
- `npm ci` in this repo. Node matches `package.json` `engines`. `npm run cd` also refuses Node older than 22.18, which is what `cloudflare.config.ts` needs when `cf` loads it.
- `git config user.name` and `user.email` set. The bump stage commits with them and does not push.
- A clean work tree. Deploy refuses a dirty one.
- `HEAD` equal to `origin/main` after `git fetch origin main`. Deploy refuses any other commit (`not-on-origin-main`) and uploads nothing.
- `PLY_TOKEN_FILE` pointing at the same bearer the Worker secret `PLY_TOKEN` uses, mode `0600` (no group or other bits). The file is read, never printed.
- Namespace `ply-loadgen` already exists. The smoke does not create it.

```sh
touch "$HOME/.ply-token" && chmod 0600 "$HOME/.ply-token"
# paste the bearer into that file, then:
export PLY_TOKEN_FILE="$HOME/.ply-token"
```

Do not run `npm run worker:deploy` while this is in progress. It refuses unless `PLY_FORCE_FULL_DEPLOY=1`. With that set it sends the Worker to 100% in one shot and will replace the split you are ramping. GitHub does not bump the pin and does not deploy.

Optional overrides (anything you do not set keeps the default in the table further down):

| Variable | Default | What it changes |
| --- | --- | --- |
| `PLY_WORKER` | `ply` | Worker name |
| `PLY_BASE_URL` | `https://ply.ivar.workers.dev` | Where smoke sends HTTP |
| `PLY_ARTIFACTS_NAMESPACE` | `ply-loadgen` | Scratch repos for the empty-repo smoke |
| `PLY_BUMP_BRANCH` | `bump-ply` | Local branch for a pin commit. Not pushed. |
| `PLY_CD_RUN_DIR` | `cd-runs` | Where the run directory is created |
| `PLY_SHA` | ply `main` | 40-hex pin, instead of resolving ply `main` |
| `PLY_RAMP_PERCENTS` | `1,5,10,25,50,75,100` | Strictly increasing integers, each 1–100, last one 100 |
| `PLY_RAMP_DWELL_MS` | `40000` | How long each percentage stays up before it is judged |
| `PLY_RAMP_PROBE_RPS` | `2` | During the dwell, probes per second on each version. Each probe is `GET /` plus one authenticated `GET /v1/discover`, pinned with `Cloudflare-Workers-Version-Overrides`. `0` dwells without probing. |
| `PLY_CD_LEDGER` | `~/.local/state/ply-cd/ledger.jsonl` | Append-only event ledger across runs |

`PLY_RAMP_MAX_HOLDS` and `PLY_RAMP_MIN_REQUESTS` are rejected if set. The ramp no longer holds. SLO targets, the fast-burn multiple, and the sample floor live in `scripts/cd/slo.ts` and are copied into `run_started`.

## The whole run

From a clean checkout of the commit you want to ship:

```sh
npm run cd
```

You can pin ply to a sha you already know:

```sh
npm run cd -- --sha 1274f2dd05b83d70f8d421cdcc79628692d848df
```

What prints, in order:

```text
run: cd-runs/2026-10-31T21-05-00-123Z
version: 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e
previous: 1aa0bb11-2222-4333-8444-555566667777
ramp step=1/7 percent=1 previous=99 samples=8/140 error_rate=0.0000/0.0000 p99_wall_ms=88/74 decision=advance
…
cd: PASS 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e
```

`version` is the upload you just created. `previous` is the version that was alone at 100% and is the rollback target. `run` is the directory that has the CSV, the telemetry note, and the ramp lines. The last line is the verdict.

| Last line | Exit | What happened |
| --- | --- | --- |
| `cd: PASS <version id>` | 0 | The new version is at 100%, and the live smoke and telemetry passed. |
| `cd: FAIL <stage>: <reason>` | 1 | That stage stopped the run. If the line is from ramp or from the live checks, traffic is already back on `previous` unless the line says the rollback itself failed. |
| `cd: harness_fault <stage>: <reason>` | 1 | A request got no response, or a 403 named the token this stage minted. The split is unchanged. |
| `cd: state_conflict <stage>: <reason>` | 1 | The deployment was not the expected prior split, so the write was skipped. The split is unchanged. |
| a usage line, no `cd: PASS` / `cd: FAIL` | 2 | The arguments were wrong. Traffic was not touched. |

A failing run still writes the directory. Relay the last line and the ramp lines from that directory.

Stages, alone, use the same last-line shape. `npm run cd -- help` lists them.

## 1. Bump

```sh
npm run cd -- bump
npm run cd -- bump --sha <40 hex>
```

Fetches `origin main` and reads that commit's `package.json`. Resolves ply `main` (or the sha you passed). When the pin already matches, it leaves your checkout where it is. When it does not, it commits **only** `package.json` and the lockfile on `bump-ply`, whose parent is `origin/main`, and checks that branch out. The pull request is that one commit. It is not stacked on the branch you were on. It does not push. If you were already on `bump-ply`, that branch is reset to `origin/main` before the commit.

Pass, already pinned:

```text
cd: PASS bump unchanged 1274f2dd05b83d70f8d421cdcc79628692d848df
```

Pass, new local commit:

```text
cd: PASS bump 1274f2dd05b83d70f8d421cdcc79628692d848df
```

Fail (nothing committed; the two files are restored):

```text
cd: FAIL bump: tracked files are modified; bump wants a clean tree
cd: FAIL bump: npm test failed: …
```

You push `bump-ply` yourself if you want a pull request for the pin. Deploy runs only when `HEAD` is `origin/main`, so the pin commit is not uploaded until it has been merged there.

## 2. Deploy the canary

```sh
npm run cd -- deploy-canary
```

Fetches `origin main` first. Unless `HEAD` is that commit, it stops with `not-on-origin-main` (or `origin-main-unavailable` when the fetch fails), writes that typed error on the run, and uploads nothing. Otherwise it builds and uploads a version with `cf workers versions create`. The version id is the row in `cf workers versions list` whose tag is the 12-character HEAD sha. The create command's own text is not parsed. A missing tag stops before traffic changes. It then routes that version to **0%** beside the single version that is at 100%, and only when the deployment is still the split it just read. A mismatch stops with `state_conflict` and leaves the split alone. It will not upload into a 50/50 split, a deployment with more than two versions, or a version that is already the live one. If a different version is already sitting at 0%, that slot is replaced. The new version is never given traffic here.

Pass:

```text
version: 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e
previous: 1aa0bb11-2222-4333-8444-555566667777
cd: PASS deploy-canary 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e
```

The command then waits until five `GET /` requests in a row, sent with `Cloudflare-Workers-Version-Overrides: ply="<new>"`, come back with `x-ply-version` equal to the new id.

Fail, pin never stuck. The 0% version stays in the deployment. The old version is still at 100%. Traffic was not raised, and it was not rolled back, because there is nothing to undo:

```text
cd: FAIL deploy-canary: pinned requests were not answered by 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e; left the 0% canary in place
```

Fail, the deployment after create is not 0/100. The previous version is put back at 100% alone:

```text
cd: FAIL deploy-canary: 8c1af0e2-… is at 10%, wanted 0%
```

## 3. Smoke

Pinned (the canary). Every request sends the version override, and every response must carry that same id in `x-ply-version`:

```sh
npm run cd -- smoke --version 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e
```

Live (after the ramp, or any time you want to see who is actually serving). No override. `x-ply-version` must still be that id, which is how you know traffic moved:

```sh
npm run cd -- smoke --expect-version 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e
```

The smoke creates an **empty** repo in `ply-loadgen` (prefix `ply-web-cd-`), mints a write token immediately before the requests, and replays the git lifecycle over `/v1`. It does not seed the repo with stock git. The token is revoked after those requests finish. On a pass the repo is deleted. On a fail the repo name is in the verdict and the token is still revoked. A request that gets no response, or a 403 naming that token as invalid or expired, stops the run as `harness_fault`. The split stays where it is. The operator decides what to do next. There is no retry and no rollback for that fault.

A 409 is a pass when that step expects it. The ones that matter after the current write API:

- Cherry-pick or revert of a patch that is already on the target, with the same adds and deletes, is `200` `empty`.
- The same patch onto a target that also has its own extra file is `409` `merge_conflict`. `allowEmpty` does not turn that into a commit.
- A merge may stamp author and committer as two different people.
- `from` and `onto` may be a 40-hex commit. Forty zeros is `400` and pushes nothing.

Pass:

```text
cd: PASS smoke 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e
```

Fail. The step name is first. The repo is left so you can look, without a token:

```text
cd: FAIL smoke: cherry-wider: status 200, wanted 409; repo ply-web-cd-20261031210500-ab12cd
```

`smoke.csv` in the run directory is one row per request. `pass` is the step verdict, not the HTTP status. A row with status 409 and `pass` is an expected conflict. Columns: `step`, `method`, `path`, `status`, `ms`, `pass`, `cf_ray`, `x_ply_request_id`, `x_artifacts_ray`, `x_ply_version`, `x_ply_build`, `server_timing`, `detail`. The token is not in the file.

On a full `npm run cd`, a smoke failure leaves the canary at 0%. The ramp does not start. Nothing is rolled back: the previous version is already at 100%. The smoke CSV is still written. Telemetry for that canary does not run.

## 4. Telemetry

```sh
npm run cd -- telemetry --version 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e \
  --since 2026-10-31T21:05:00Z \
  --report cd-runs/2026-10-31T21-05-00-123Z/smoke.json
```

`--since` is the start of the smoke window (ISO-8601, epoch milliseconds, or epoch seconds). The report is the smoke JSON from the same run. The check queries `cf o11y telemetry query` for that version in that window.

It fails when any of these are true:

- an exception, a non-ok invocation, a 5xx, or an error log on that version
- a smoke id logged by a different version
- smoke ids missing from telemetry beyond the loss allowance in `scripts/canary-verdict.mjs` (max of 2 and 2% of the ids). An id the smoke did not see answered by this version is never waived
- no invocation matched
- wall, CPU, or upstream `fetch` span p50/p99 over the ceilings below
- fewer traces than the loss allowance allows

A 409 the smoke expected is not an unexpected status. A 500 the smoke did not expect is.

Pass prints the verdict line, then:

```text
telemetry: 40/42 matched, 2 lost (tolerated)
cd: PASS telemetry 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e
```

Fail:

```text
cd: FAIL telemetry: telemetry: 0/42 matched FAIL: 42 lost without x-ply-version … recorded by the smoke
```

`telemetry.md` in the run directory is that verdict plus the percentiles. `telemetry.json` is the machine-readable pass or fail. The ramp will not move traffic unless that file is a pass for this version.

Ceilings for this smoke (a tiny repo, cold isolates included; tighten them after a few real runs):

| | p50 | p99 |
| --- | --- | --- |
| Worker wall | 4000 ms | 25000 ms |
| Worker CPU | 250 ms | 3000 ms |
| Artifacts `fetch` span | 2000 ms | 15000 ms |

If `cf o11y` cannot be queried, the stage fails. It does not treat a missing query as a pass.

## 5. Ramp

Only after the pinned smoke and the telemetry file are both a pass for this version, and the deployment is still new-at-0% / previous-at-100%. An empty split, a percent that is not an integer 0–100, or two copies of one version id is refused before `cf` is called:

```sh
npm run cd -- ramp --version 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e \
  --previous 1aa0bb11-2222-4333-8444-555566667777 \
  --verdict cd-runs/2026-10-31T21-05-00-123Z/telemetry.json
```

Without `--verdict`, or with a verdict that is not a pass for that version, the command exits and does not change traffic.

The schedule is `1, 5, 10, 25, 50, 75, 100`. Each step waits `40000` ms. During that wait the ramp probes at `PLY_RAMP_PROBE_RPS` (default 2) **on each version**: `GET /` (the usage text, 200, no bearer) and `GET /v1/discover?remote=…` for the public `ply` mirror with the bearer from `PLY_TOKEN_FILE`. Each call sends `Cloudflare-Workers-Version-Overrides` for the new version and, separately, for the previous one, so both arms are sampled at the probe rate rather than at the traffic split. There is no `/health` route. A non-2xx answer from the **new** version fails the step. A probe that gets no response stops the ramp as `harness_fault` and leaves the current split in place. Before each percentage change the ramp reads the deployment and writes only when it is still the previous step's split. Otherwise it stops with `state_conflict` and does not roll back.

Then it reads `cf o11y` for **both** versions over that step's window. Span events have no `$workers.scriptVersion.id`, so traces are queried by service only and joined to a version by `$metadata.requestId`.

The step decision is the new version's SLO burn, not a hand-tuned rate delta. Burn rate is `(bad / total) / (1 − target)`. Definitions are in [Metrics](#metrics).

| Check | Rolls back when |
| --- | --- |
| Exception on the new version | Any, even one request |
| 5xx on the new version | Any. A 5xx on the old version does not roll the canary back onto it |
| Non-ok Worker outcome on the new version | Any |
| Probe | A response from the new version that is not 2xx |
| SLO burn | `bad/total` divided by the error budget is above **14.4**, and that SLO saw at least 20 requests in the window |
| Latency vs the old version | Both sides have at least 20 wall samples and Mann-Whitney says the new version is slower (one-sided, alpha 0.01). With 5–19 samples on both sides, wall p99 new/old above 2. Equal to 2 still advances |
| Sample too small for that compare | `decision=insufficient_data`. This is not a pass of the latency SLO. The percentage still advances when the hard checks above are clean |
| Query failed | Rollback. A missing query is not zero errors |

There is no hold. A quiet 1% step with zero errors is `insufficient_data` and the ramp moves to 5%. The pinned probes are what put samples on the new version at 1%. Raise `PLY_RAMP_DWELL_MS` or `PLY_RAMP_PROBE_RPS` when you want the burn and Mann-Whitney checks to see more than that. Do not treat `insufficient_data` as a failure.

At 100% the old version is dropped, so its wall times are the last step whose old version had at least 5 samples. That line includes `previous_sample=carried`. If no earlier step had them, 100% is `insufficient_data` when the new version is clean, and the ramp completes.

Each step prints one line to stdout and appends the same line to `ramp.jsonl` in the run directory. Relay those lines as they appear.

A clean ramp:

```text
ramp step=1/7 percent=1 previous=99 samples=8/140 error_rate=0.0000/0.0000 p99_wall_ms=88/74 decision=advance
ramp step=2/7 percent=5 previous=95 samples=14/132 error_rate=0.0000/0.0000 p99_wall_ms=90/76 decision=advance
ramp step=3/7 percent=10 previous=90 samples=22/118 error_rate=0.0000/0.0085 p99_wall_ms=94/78 decision=advance
ramp step=4/7 percent=25 previous=75 samples=40/96 error_rate=0.0000/0.0000 p99_wall_ms=101/80 decision=advance
ramp step=5/7 percent=50 previous=50 samples=70/70 error_rate=0.0000/0.0000 p99_wall_ms=110/82 decision=advance
ramp step=6/7 percent=75 previous=25 samples=96/28 error_rate=0.0000/0.0000 p99_wall_ms=116/84 decision=advance
ramp step=7/7 percent=100 previous=0 samples=120/28 error_rate=0.0000/0.0000 p99_wall_ms=114/84 decision=advance previous_sample=carried
cd: PASS ramp 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e
```

How to read a line:

| Field | Meaning |
| --- | --- |
| `step=2/7` | Second percentage. 1-based. |
| `percent=5` `previous=95` | New version's share, and what is left on the old one. At the last step `previous=0`. |
| `samples=14/132` | Requests in this step's window, new / old. |
| `error_rate=0.0000/0.0085` | Non-ok rate, new / old, four decimal places. |
| `p99_wall_ms=90/76` | Wall-time p99 in milliseconds, new / old. `-` means that side had no sample. |
| `decision=advance` | The burn and the latency compare both passed. Move to the next percentage. |
| `decision=insufficient_data` | Not enough wall samples to compare. The next line is the next percentage when nothing else failed. |
| `decision=rollback` | Traffic is being put back on the previous version. |
| `reason="…"` | Present unless the decision is `advance`. Relay it with the line. |
| `previous_sample=carried` | The old-version numbers are from the last step that had at least 5 wall samples, not from a version that is no longer allocated. |

A quiet first step advances. It does not roll back:

```text
ramp step=1/7 percent=1 previous=99 samples=3/40 error_rate=0.0000/0.0000 p99_wall_ms=88/74 decision=insufficient_data reason="wall samples 3/4; need 20 each for Mann-Whitney or 5 each for a quantile compare"
ramp step=2/7 percent=5 previous=95 samples=14/132 error_rate=0.0000/0.0000 p99_wall_ms=90/76 decision=advance
```

A short sample whose p99 ratio is above 2 rolls back immediately:

```text
ramp step=4/7 percent=25 previous=75 samples=22/88 error_rate=0.0000/0.0000 p99_wall_ms=210/80 decision=rollback reason="wall p99 ratio 2.625 > 2"
cd: FAIL ramp: wall p99 ratio 2.625 > 2
```

An exception on the new version, even with one request:

```text
ramp step=2/7 percent=5 previous=95 samples=1/40 error_rate=1.0000/0.0000 p99_wall_ms=40/70 decision=rollback reason="1 exception on the new version"
cd: FAIL ramp: 1 exception on the new version
```

`cf o11y` down rolls back on that step. It does not wait:

```text
ramp step=3/7 percent=10 previous=90 samples=-/- error_rate=-/- p99_wall_ms=-/- decision=rollback reason="telemetry unavailable: …"
cd: FAIL ramp: telemetry unavailable: …
```

If the rollback request itself does not stick, the last line says so and names the version that should be at 100%. Do not treat that run as rolled back. Put it back yourself with the command in the next section.

## 6. After 100%

`npm run cd` does not stop at the last ramp line. It smokes again with **no** version override (`--expect-version`), then runs telemetry on that live window. Both have to pass.

Pass is the same `cd: PASS <version id>` as the whole run.

Fail rolls back to `previous` at 100% and exits:

```text
cd: FAIL smoke: read-readme: x-ply-version 1aa0bb11-…, wanted 8c1af0e2-…
cd: FAIL telemetry: telemetry: … 3 5xx
```

Organic 5xx on the new version during the live window fails this telemetry check and rolls back. The canary check was only the pinned smoke ids. The live check is every invocation of that version in the window.

## Rollback

Any time, including when a ramp or a live check did not put the old version back:

```sh
npm run cd -- rollback --to 1aa0bb11-2222-4333-8444-555566667777
```

`--to` is the **good** version. It becomes the only version, at 100%. The command reads the deployment back and will not print a pass unless that is what it sees.

```text
cd: PASS rollback 1aa0bb11-2222-4333-8444-555566667777
cd: FAIL rollback: rollback to 1aa0bb11-… failed: …
```

## The run directory

`cd-runs/<timestamp>/` (gitignored):

| File | What you open it for |
| --- | --- |
| `verdict.json` | `{ "kind": "pass", "version": "…", "failures": [] }`, `kind: "fail"` with `stage`, `reason`, and `rolledBack`, or `kind: "harness_fault"` / `kind: "state_conflict"` with the split left as it was |
| `smoke.csv` / `live-smoke.csv` | One row per HTTP call. `pass` is the step. `detail` is why a row failed. |
| `smoke.json` / `live-smoke.json` | The ids telemetry asks for, plus the scratch repo name if it was kept |
| `telemetry.md` / `live-telemetry.md` | The verdict line and the percentiles |
| `telemetry.json` | The pass/fail the ramp reads. A ramp with a fail here does not change traffic. |
| `ramp.jsonl` | The same progress lines that went to stdout, one JSON object per step: `{ "line": "ramp step=…" }` |
| `events.jsonl` | Append-only log. One typed event per line. This is the record a debrief reads |
| `manifest.json` | sha256 of every other file, written after `run_finished`. The directory is not modified after this |
| `captures/` | stdout and stderr of each command, redacted |
| `raw/` | The response body behind each observation |

## When it fails

| You see | Traffic now | What you do |
| --- | --- | --- |
| `cd: FAIL bump:` | Unchanged | Fix the tree or the gate. Nothing was uploaded. A failed pin does not move `bump-ply` unless you were already on it. |
| `cd: FAIL deploy-canary: not-on-origin-main` | Unchanged | Check out `origin/main`. A pin commit on `bump-ply` is not deployed from there. |
| `cd: FAIL deploy-canary:` and the line says the canary was left at 0% | Old at 100%, new at 0% | Read the pin failure. Rollback only if you want the 0% slot cleared: `npm run cd -- rollback --to <previous>`. |
| `cd: FAIL deploy-canary:` after a bad split | Previous at 100% if the rollback landed | Confirm with `cf workers deployments list --worker ply`. |
| `cd: FAIL smoke:` or `cd: FAIL telemetry:` before any ramp line | Still 0% / 100% | The ramp did not start. The scratch repo name is in the smoke failure. |
| A ramp line with `decision=insufficient_data`, then the next `step=` | The next percentage | Relay the line. Nothing was rolled back. |
| A ramp line with `decision=rollback`, then `cd: FAIL ramp:` | Previous at 100% | Relay the line. The new version is off traffic. |
| `cd: FAIL ramp:` and the text says rollback failed | **Not** safe | Run `npm run cd -- rollback --to <previous>` and read the deployment list. The id to restore is the one in that sentence. |
| `cd: FAIL smoke:` or `cd: FAIL telemetry:` after ramp lines that reached `percent=100` | Previous at 100% if rollback landed | Same as a ramp rollback. The live check is what rejected it. |
| `cd: harness_fault` | The split where the run stopped | The version was not blamed. No retry and no rollback. Decide from the request that got no response, or the 403 on the token this stage minted. |
| `cd: state_conflict` | The split that was already there | Something else changed the deployment. Do not apply the step again until you have read `cf workers deployments list`. |

## Metrics

SLOs are data in `scripts/cd/slo.ts`. A ramp step does not inline the numbers.

| SLO | Good event | Target | Window |
| --- | --- | --- | --- |
| Availability | Not a 5xx and no exception, over `/v1` requests, excluding expected 4xx | 99.9% | 28 days |
| Read latency | `GET /v1/*` wall time under 1000 ms | 99% | 28 days |
| Write latency | `POST /v1/*` wall time under 2500 ms | 99% | 28 days |
| Correctness | Lifecycle smoke: every step the expected status, `git fsck` clean, refs equal | 99.5% | 28 days |

The latency ceilings are initial. Tighten them from a real baseline; the 99% target stays.

Error budget and burn rate:

```text
budget = 1 − target
burn   = (bad / total) / budget
```

A burn of 1 spends the budget at the planned rate. The ramp fails a step when burn is above **14.4** and that SLO has at least 20 samples in the step window. 14.4 is the SRE workbook fast-burn multiple: on a 30-day budget, 14.4× for one hour spends about 2%. Our SLO window is 28 days. The step still uses 14.4, not a recomputed multiple.

Availability on a ramp step treats every 4xx as expected, so client errors leave the denominator. The probe contract and the correctness smoke still fail an unexpected status. One 5xx or one exception fails the step even when the sample is shorter than 20, so the availability burn is the rate view for a window that is already large.

Correctness is one lifecycle smoke, not a ramp step. Any failed step fails the smoke stage (`decision=stop`, canary left at 0%). The burn from the pass/fail counts is stored on the run. It is what a later alert would page on. It is not a second gate inside the ramp.

Latency against the old version, when both sides have at least 20 wall samples, is a one-sided Mann-Whitney U test (average ranks on ties). It fails when the new sample is stochastically slower and the upper tail is under 0.01. Between 5 and 19 samples on both sides the compare is wall p99, and a ratio above 2 fails. Fewer than that is `insufficient_data`.

Alerting policy for later, not applied on a ramp step. These are the workbook's 30-day windows:

| Severity | Burn | Long window | Short window | Budget spent if both fire |
| --- | --- | --- | --- | --- |
| page | 14.4× | 1h | 5m | about 2% |
| ticket | 6× | 6h | 30m | about 5% |
| ticket | 1× | 3d | 6h | about 10% |

### Delivery

Every event is appended to the run's `events.jsonl` and to the ledger (`PLY_CD_LEDGER`, default `~/.local/state/ply-cd/ledger.jsonl`). `run_finished` carries the fields a delivery report needs: ply sha, ply merge time, ply-web sha, version id, stage timestamps and durations, verdict, rollback flag and reason, smoke pass/fail counts, and per-SLO burn per step.

```sh
npm run cd -- report
```

| Metric | Formula |
| --- | --- |
| Deployment frequency | deploys / days. A deploy is a `run_finished` with a version id. Days are the span from the first such timestamp to the last. One timestamp has no rate. |
| Lead time | `liveAt − plyMergedAt` on a passing deploy. `liveAt` is when the ramp reached 100%. `plyMergedAt` is the ply commit's committer time from the GitHub API, or null if that fetch fails (the deploy still finishes). Report p50 and p90. |
| Change failure rate | rollbacks / deploys |
| Time to restore | `restoredAt − failedAt` for a rolled-back deploy. p50 and p90. |
| Stage duration | p50 and p90 of each stage's `durationMs`, across runs. Percentile is `sorted[floor((n − 1) · p)]`. |

## Debrief

The event log is the record of the run. Every line is one JSON object:

| Field | What |
| --- | --- |
| `seq` | 1, 2, 3, … inside that run |
| `ts` | ISO-8601 with a numeric offset |
| `run_id` | The run directory name |
| `stage` | `run`, `bump`, `deploy-canary`, `smoke`, `telemetry`, `ramp`, `rollback`, or the live variants |
| `kind` | One of the variants below |
| `payload` | The variant's fields |

| Kind | Payload |
| --- | --- |
| `lifecycle` | `run_started` (config, node/cf/git versions, ply and ply-web shas, host) or `run_finished` (verdict, rollback, smoke counts, stage timings, per-step burns, live/fail/restore times) |
| `command` | argv with secrets already replaced by `<redacted>`, cwd, exit code, duration, sha256 of stdout and stderr, and the paths of those captures |
| `observation` | The measurement, the exact `cf o11y` query (or the smoke source) and its window, and `responsePath` of the raw body under `raw/` |
| `decision` | `inputs` (one or more earlier observation seqs), `rules` (`name` and `value` from `slo.ts`, or the smoke rule), `outcome` (`advance`, `hold`, `insufficient_data`, `rollback`, `stop`), and `reason` |
| `state_change` | Traffic split before and after, and the deployment id when cf returned one |
| `request` | One smoke or probe call: method, url, status, version, latency, `cf-ray`, `x-ply-request-id`, `x-artifacts-ray` |
| `error` | An unexpected failure and a JSON context |

A decision cannot be written unless `inputs` cites an earlier `observation`. A `Secret` cannot be serialized: `JSON.stringify` throws, and command argv stores `<redacted>` instead of the value. Token text that still shows up in a captured stdout is replaced with `[redacted]` before the line is appended.

The ramp does not emit `hold`. The outcome stays in the schema so a recorded decision can say it waited. `stop` is a gate that leaves traffic where it is (the pinned smoke failure). `rollback` is traffic returned to the previous version.

After `run_finished` the run writes `manifest.json` with the sha256 of every other file and then refuses further appends. Do not edit the run directory. A debrief writes beside it:

```sh
npm run cd -- debrief cd-runs/2026-10-31T21-05-00-123Z
```

That prints `debrief: cd-runs/2026-10-31T21-05-00-123Z.debrief/debrief.md`. The markdown stands alone: a timeline, every decision with the rule and the observations it used, every traffic change, three charts (`split.png` configured percent against the share of requests the new version received, `latency.png` wall p99 by version, `burn.png` burn per SLO with a line at 14.4), and links back to `events.jsonl`, `raw/`, and `captures/`.

## Later

This runbook is the operator path. The same stages are what a later driver should call. That driver is a Worker fed by Cloudflare Artifacts repo events, not a GitHub Actions workflow.
