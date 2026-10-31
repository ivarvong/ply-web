# Continuous deployment

**Commands land in the follow-up PR.** Every `npm run cd` on this page is that entrypoint. It is not in this repository yet. This page is the procedure that entrypoint has to match.

You ship ply-web from a Linux box where `cf` is already logged in. One command uploads the commit you have checked out, smokes it at 0%, then walks traffic from 0% to 100% over about five minutes. If a step goes bad, traffic goes back to the previous version and the command exits. GitHub holds the code and the pull request. It does not deploy.

![Operator pipeline. The left column is gate, deploy, smoke, telemetry, ramp, live smoke, live telemetry, done. Failures leave to the right.](img/cd-pipeline.png)

The left column is the only path that raises traffic. An arrow to the right is that step stopping. A gray box leaves the split as it is. A red box puts the previous version back at 100% and the process exits. A pinned smoke failure takes the gray stop on that row: the canary stays at 0% and the ramp does not start. Source for the picture: [cd-pipeline.mmd](img/cd-pipeline.mmd). The vector file is [cd-pipeline.svg](img/cd-pipeline.svg).

## Before you start

On the box:

- `cf auth login` already done. The login needs Workers Scripts Edit (versions and deployments; an account token calls this Workers Scripts Write), Workers Observability Read, and Artifacts Edit on the namespace below. It does not need routes, KV, R2, or tail.
- `npm ci` in this repo. Node matches `package.json` `engines`.
- `git config user.name` and `user.email` set. The bump stage commits with them and does not push.
- A clean work tree. Deploy refuses a dirty one.
- `PLY_TOKEN_FILE` pointing at the same bearer the Worker secret `PLY_TOKEN` uses, mode `0600` (no group or other bits). The file is read, never printed.
- Namespace `ply-loadgen` already exists. The smoke does not create it.

```sh
touch "$HOME/.ply-token" && chmod 0600 "$HOME/.ply-token"
# paste the bearer into that file, then:
export PLY_TOKEN_FILE="$HOME/.ply-token"
```

Do not run `scripts/deploy.sh` or `npm run worker:deploy` while this is in progress. Both still send the Worker to 100% in one shot and will replace the split you are ramping. GitHub does not deploy.

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
| `PLY_RAMP_MAX_HOLDS` | `1` | Short or missing samples tolerated at the current percentage |
| `PLY_RAMP_MIN_REQUESTS` | `5` | Requests required on **each** version in a step window |

Latency ceilings and the rate ratios are not environment variables. They are the numbers in the ramp section below.

## The whole run

From a clean checkout of the commit you want to ship. Commands land in the follow-up PR:

```sh
npm run cd
```

You can pin ply to a sha you already know. Commands land in the follow-up PR:

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
| a usage line, no `cd: PASS` / `cd: FAIL` | 2 | The arguments were wrong. Traffic was not touched. |

A failing run still writes the directory. Relay the last line and the ramp lines from that directory.

Stages, alone, use the same last-line shape. `npm run cd -- help` lists them. Commands land in the follow-up PR.

## 1. Bump

Commands land in the follow-up PR:

```sh
npm run cd -- bump
npm run cd -- bump --sha <40 hex>
```

Resolves ply `main` (or the sha you passed) and writes `github:ivarvong/ply#<sha>` into `package.json` and the lockfile. Then it runs `npm run typecheck`, `npx oxlint`, and `npm test` on that tree and commits **only** those two files on `bump-ply`. It does not push.

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

You push `bump-ply` yourself if you want a pull request for the pin. The rest of `npm run cd` (commands land in the follow-up PR) deploys the checkout you are on, which is this new commit only after you check it out.

## 2. Deploy the canary

Commands land in the follow-up PR:

```sh
npm run cd -- deploy-canary
```

Builds, uploads a version with `cf workers versions create`, and routes that version to **0%** beside the single version that is at 100%. It will not upload into a 50/50 split, a deployment with more than two versions, or a version that is already the live one. If a different version is already sitting at 0%, that slot is replaced. The new version is never given traffic here.

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

Commands land in the follow-up PR:

```sh
npm run cd -- smoke --version 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e
```

Live (after the ramp, or any time you want to see who is actually serving). No override. `x-ply-version` must still be that id, which is how you know traffic moved:

Commands land in the follow-up PR:

```sh
npm run cd -- smoke --expect-version 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e
```

The smoke creates an **empty** repo in `ply-loadgen` (prefix `ply-web-cd-`), mints a write token, and replays the git lifecycle over `/v1`. It does not seed the repo with stock git. The token is revoked when the run ends. On a pass the repo is deleted. On a fail the repo name is in the verdict and the token is still revoked.

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

On a full `npm run cd` (commands land in the follow-up PR), a smoke failure leaves the canary at 0%. The ramp does not start. Nothing is rolled back: the previous version is already at 100%. The smoke CSV is still written. Telemetry for that canary does not run.

## 4. Telemetry

Commands land in the follow-up PR:

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

Only after the pinned smoke and the telemetry file are both a pass for this version, and the deployment is still new-at-0% / previous-at-100%:

Commands land in the follow-up PR:

```sh
npm run cd -- ramp --version 8c1af0e2-7b3d-4c1a-9e20-6f0a1b2c3d4e \
  --previous 1aa0bb11-2222-4333-8444-555566667777 \
  --verdict cd-runs/2026-10-31T21-05-00-123Z/telemetry.json
```

Without `--verdict`, or with a verdict that is not a pass for that version, the command exits and does not change traffic.

The schedule is `1, 5, 10, 25, 50, 75, 100`. Each step waits `40000` ms, then reads `cf o11y` for **both** versions over that step's window:

- request count
- error rate (non-ok outcomes / requests) and exception count
- 5xx rate
- wall and CPU, p50 and p99
- Artifacts upstream latency, from trace spans named `fetch`, p50 and p99

Compare new against old:

| Check | Rolls back when |
| --- | --- |
| Exceptions on the new version | More than 0, even if the sample is shorter than the minimum |
| 5xx rate | New rate is more than 0.01 above the old rate |
| Error rate | Same, once both sides have enough requests |
| Wall, CPU, fetch p50 and p99 | New / old is greater than 2. Equal to 2 still advances. Old 0 and new 0 is fine. Old 0 and new above 0 is a breach. |
| Sample size | Either side has fewer than 5 requests. This is a **hold**, not a pass. |
| Fetch spans | Both sides have none: skip the fetch comparison. One side is short of 3 spans: hold. |
| Query failed | Hold. Not a pass. |

One hold waits another `20000` ms at the same percentage and reads again. A second short sample rolls back. A breach does not wait for that hold. It rolls back immediately.

At 100% the old version is no longer in the deployment, so its side of the comparison is the last step where it had at least 5 requests. That line includes `previous_sample=carried`. If no earlier step had enough old traffic, 100% is a hold and then a rollback, not a pass.

`ply.ivar.workers.dev` is often too quiet for 5 requests at 1% inside 40 seconds. The default then holds and rolls back. That is the safe outcome. Set `PLY_RAMP_MIN_REQUESTS` to a number you can actually collect. Do not set it to 0 to force the ramp through.

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
| `decision=advance` | Move to the next percentage. `hold` stays. `rollback` is already being undone. |
| `reason="…"` | Present on hold and rollback. This is the sentence to relay with the line. |
| `previous_sample=carried` | The old-version numbers are from the last step that had enough of them, not from a version that is no longer allocated. |

A quiet first step, then rollback. Traffic returns to 100% on the old version:

```text
ramp step=1/7 percent=1 previous=99 samples=2/40 error_rate=0.0000/0.0000 p99_wall_ms=88/74 decision=hold reason="insufficient sample 2/40, minimum 5 each"
ramp step=1/7 percent=1 previous=99 samples=1/12 error_rate=0.0000/0.0000 p99_wall_ms=80/70 decision=rollback reason="insufficient sample 1/12, minimum 5 each; after 1 hold(s)"
cd: FAIL ramp: insufficient sample 1/12, minimum 5 each; after 1 hold(s)
```

A breach does not hold first:

```text
ramp step=4/7 percent=25 previous=75 samples=22/88 error_rate=0.0000/0.0000 p99_wall_ms=210/80 decision=rollback reason="wall p99 ratio 2.625 > 2"
cd: FAIL ramp: wall p99 ratio 2.625 > 2
```

An exception on the new version, even with one request:

```text
ramp step=2/7 percent=5 previous=95 samples=1/40 error_rate=1.0000/0.0000 p99_wall_ms=40/70 decision=rollback reason="1 exceptions on the new version"
cd: FAIL ramp: 1 exceptions on the new version
```

`cf o11y` down:

```text
ramp step=3/7 percent=10 previous=90 samples=-/- error_rate=-/- p99_wall_ms=-/- decision=hold reason="telemetry unavailable: …"
```

The same line a second time, after the hold, is `decision=rollback` and the exit is `cd: FAIL ramp: …`.

If the rollback request itself does not stick, the last line says so and names the version that should be at 100%. Do not treat that run as rolled back. Put it back yourself with the command in the next section.

## 6. After 100%

`npm run cd` (commands land in the follow-up PR) does not stop at the last ramp line. It smokes again with **no** version override (`--expect-version`), then runs telemetry on that live window. Both have to pass.

Pass is the same `cd: PASS <version id>` as the whole run.

Fail rolls back to `previous` at 100% and exits:

```text
cd: FAIL smoke: read-readme: x-ply-version 1aa0bb11-…, wanted 8c1af0e2-…
cd: FAIL telemetry: telemetry: … 3 5xx
```

Organic 5xx on the new version during the live window fails this telemetry check and rolls back. The canary check was only the pinned smoke ids. The live check is every invocation of that version in the window.

## Rollback

Any time, including when a ramp or a live check did not put the old version back:

Commands land in the follow-up PR:

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
| `verdict.json` | `{ "kind": "pass", "version": "…", "failures": [] }` or `kind: "fail"` with `stage`, `reason`, and `rolledBack` |
| `smoke.csv` / `live-smoke.csv` | One row per HTTP call. `pass` is the step. `detail` is why a row failed. |
| `smoke.json` / `live-smoke.json` | The ids telemetry asks for, plus the scratch repo name if it was kept |
| `telemetry.md` / `live-telemetry.md` | The verdict line and the percentiles |
| `telemetry.json` | The pass/fail the ramp reads. A ramp with a fail here does not change traffic. |
| `ramp.jsonl` | The same progress lines that went to stdout, one JSON object per step: `{ "line": "ramp step=…" }` |

## When it fails

| You see | Traffic now | What you do |
| --- | --- | --- |
| `cd: FAIL bump:` | Unchanged | Fix the tree or the gate. Nothing was uploaded. |
| `cd: FAIL deploy-canary:` and the line says the canary was left at 0% | Old at 100%, new at 0% | Read the pin failure. Rollback only if you want the 0% slot cleared: `npm run cd -- rollback --to <previous>` (commands land in the follow-up PR). |
| `cd: FAIL deploy-canary:` after a bad split | Previous at 100% if the rollback landed | Confirm with `cf workers deployments list --worker ply`. |
| `cd: FAIL smoke:` or `cd: FAIL telemetry:` before any ramp line | Still 0% / 100% | The ramp did not start. The scratch repo name is in the smoke failure. |
| A ramp line with `decision=rollback`, then `cd: FAIL ramp:` | Previous at 100% | Relay the line. The new version is off traffic. |
| `cd: FAIL ramp:` and the text says rollback failed | **Not** safe | Run `npm run cd -- rollback --to <previous>` (commands land in the follow-up PR) and read the deployment list. The id to restore is the one in that sentence. |
| `cd: FAIL smoke:` or `cd: FAIL telemetry:` after ramp lines that reached `percent=100` | Previous at 100% if rollback landed | Same as a ramp rollback. The live check is what rejected it. |

## Later

This runbook is the operator path. The same stages are what a later driver should call. That driver is a Worker fed by Cloudflare Artifacts repo events, not a GitHub Actions workflow.
