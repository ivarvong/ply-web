#!/bin/bash
# Deploy the ply Worker through a 0% canary. Run from a clean checkout of the commit to ship (main), with node_modules
# installed (npm ci) and a cf OAuth login:
#   scripts/deploy.sh "<message>"         (SKIP_GATE=1 skips typecheck/lint/tests when they just passed on this tree)
# Approach from ~/code/ephem/scripts/deploy.sh, simplified (no lock, no live watcher):
#   1. gate: npm run typecheck, npx oxlint, npm test.
#   2. upload: cf build --mode production, then `cf workers versions create --prebuilt` (a version in no deployment;
#      nothing reaches it).
#   3. canary: one deployment with the new version at 0% and the current version (must be alone at 100%) at 100%.
#   4. pinned smoke: wait until pinned requests are answered by <new> (x-ply-version; a fresh deployment takes seconds to
#      propagate), then src/smoke.mjs gate/read/write --version <new> and scripts/visual-smoke.mjs with PLY_VERSION=<new>;
#      every request carries Cloudflare-Workers-Version-Overrides: ply="<new>" and fails if x-ply-version is not <new>.
#   5. telemetry gate: scripts/canary-o11y.mjs proves every pinned smoke request id was logged by <new> (a request id is
#      minted per request, so this shows which version answered) and that <new> has 0 non-ok invocations, 0 5xx, 0 error logs.
#   Any failure in 3-5: route 100% back to the previous version alone (removes the canary), exit 1.
#   6. promote <new> to 100%, smoke again unpinned (gate/read/write + visual). A failure routes 100% back to the previous
#      version, exit 1.
# Prints `DEPLOYED <new> (previous <prev>)` and leaves artifacts (smoke JSON, request ids, screenshots) in $OUT.
# Never `cf deploy` straight to 100%: that skips the canary. Tokens are never printed (smoke.mjs redacts its own).
set -euo pipefail
MSG=${1:?usage: scripts/deploy.sh "<message>"}
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
W=ply; BASE=https://ply.ivar.workers.dev
SHA=$(git rev-parse --short=12 HEAD)
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "tracked files modified; deploy a commit, not a working tree" >&2; exit 1; }
OUT=${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/ply-deploy-$SHA-XXXX")}; mkdir -p "$OUT"
cf() { env -u CLOUDFLARE_API_TOKEN npx cf "$@"; }
now_ms() { node -e 'console.log(Date.now())'; }
log() { echo "== $(date -u +%T) $*"; }

# active: the version alone at 100%, or nothing
active() { cf workers deployments list --worker $W | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).deployments[0].versions;console.log(v.length===1&&v[0].percentage===100?v[0].version_id:"")})'; }
# route <id>:<pct> [<id>:<pct>]
route() {
  local body; body=$(node -e 'const [m,...a]=process.argv.slice(1);const vs=a.map(x=>{const [id,p]=x.split(":");return {version_id:id,percentage:Number(p)}});console.log(JSON.stringify({strategy:"percentage",versions:vs,annotations:{"workers/message":m.slice(0,100)}}))' "$MSG [git $SHA]" "$@")
  cf workers deployments create --worker $W --body "$body" >/dev/null
}
smokes() {  # smokes <label> [version]: gate, read, write, visual; request ids → $OUT/<label>.ids
  local label=$1 v=${2:-} rc=0 ph
  local vflag=(); [ -n "$v" ] && vflag=(--version "$v")
  for ph in gate read write; do
    node src/smoke.mjs $BASE $ph ${vflag[@]+"${vflag[@]}"} --out "$OUT/$label-$ph.json" > "$OUT/$label-$ph.log" 2>&1 || rc=1
    echo "   $label $ph: $(tail -1 "$OUT/$label-$ph.log")"
  done
  mkdir -p "$OUT/$label-shots"
  PLY_VERSION="$v" node scripts/visual-smoke.mjs $BASE "$OUT/$label-shots" > "$OUT/$label-visual.log" 2>&1 || rc=1
  echo "   $label visual: $(grep -c '"ok":true' "$OUT/$label-visual.log")/$(grep -c '"ok":' "$OUT/$label-visual.log") ok; screenshots $OUT/$label-shots"
  node -e 'const fs=require("fs");const [o,l]=process.argv.slice(1);const ids=[];for(const p of ["gate","read","write"]){try{for(const s of JSON.parse(fs.readFileSync(`${o}/${l}-${p}.json`)).steps)if(s.requestId)ids.push(s.requestId)}catch{}}try{const last=fs.readFileSync(`${o}/${l}-visual.log`,"utf8").trim().split("\n").pop();ids.push(...(JSON.parse(last).requestIds??[]))}catch{}fs.writeFileSync(`${o}/${l}.ids`,ids.join("\n")+"\n")' "$OUT" "$label"
  return $rc
}

if [ "${SKIP_GATE:-}" != 1 ]; then
  log "gate @ $SHA"
  npm run typecheck > "$OUT/typecheck.log" 2>&1 || { tail -30 "$OUT/typecheck.log"; echo "GATE FAILED: typecheck" >&2; exit 1; }
  npx oxlint > "$OUT/lint.log" 2>&1 || { tail -30 "$OUT/lint.log"; echo "GATE FAILED: oxlint" >&2; exit 1; }
  npm test > "$OUT/test.log" 2>&1 || { tail -40 "$OUT/test.log"; echo "GATE FAILED: tests" >&2; exit 1; }
  grep -E '^ℹ (pass|fail) ' "$OUT/test.log" | tr '\n' ' '; echo
fi

PREV=$(active); [ -n "$PREV" ] || { echo "no single version at 100% (a canary in flight?); not deploying" >&2; exit 1; }
log "previous (rollback) version $PREV"
log "build + upload"
cf build --mode production > "$OUT/build.log" 2>&1 || { tail -20 "$OUT/build.log"; exit 1; }
cf workers versions create --prebuilt --mode production --tag "$SHA" --message "$(printf '%s' "$MSG [git $SHA]" | cut -c1-100)" > "$OUT/upload.log" 2>&1 || { tail -20 "$OUT/upload.log"; exit 1; }
NEW=$(grep -i 'version id' "$OUT/upload.log" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1)
[ -n "$NEW" ] || { tail -20 "$OUT/upload.log"; echo "no version id in the upload output" >&2; exit 1; }
log "uploaded $NEW"

abort() { log "CANARY FAILED ($1): routing 100% to $PREV"; route "$PREV:100"; echo "active now: $(active)"; exit 1; }
T_CANARY=$(now_ms)
route "$NEW:0" "$PREV:100" || abort "create 0% deployment"
# A new deployment takes a few seconds to reach every colo; until then a pinned request is answered by the old version
# (seen 2026-10-31: the first 3 s of pinned smoke ran on the previous version). Wait until pinned requests come back with
# x-ply-version = NEW five times in a row.
ok=0
for _ in $(seq 1 60); do
  got=$(curl -s -o /dev/null -D - -H "Cloudflare-Workers-Version-Overrides: $W=\"$NEW\"" "$BASE/" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-ply-version"{print $2}')
  if [ "$got" = "$NEW" ]; then ok=$((ok+1)); [ $ok -ge 5 ] && break; else ok=0; fi
  sleep 1
done
[ $ok -ge 5 ] || abort "pinned requests never answered by $NEW"
log "pinned requests answered by $NEW"
log "canary: $NEW 0%, $PREV 100%; pinned smoke"
smokes canary "$NEW" || abort "pinned smoke"
log "telemetry gate (pinned requests)"
env -u CLOUDFLARE_API_TOKEN node scripts/canary-o11y.mjs "$NEW" "$T_CANARY" "$OUT/canary.ids" | tee "$OUT/canary-o11y.json" || abort "telemetry gate"

log "promote $NEW to 100%"
T_LIVE=$(now_ms)
route "$NEW:100"
[ "$(active)" = "$NEW" ] || { route "$PREV:100"; echo "promotion did not take; routed back to $PREV" >&2; exit 1; }
ok=0
for _ in $(seq 1 90); do
  got=$(curl -s -o /dev/null -D - "$BASE/" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-ply-version"{print $2}')
  if [ "$got" = "$NEW" ]; then ok=$((ok+1)); [ $ok -ge 5 ] && break; else ok=0; fi
  sleep 1
done
[ $ok -ge 5 ] || { log "unpinned requests not answered by $NEW after promotion: routing 100% back to $PREV"; route "$PREV:100"; exit 1; }
if ! smokes live; then log "LIVE SMOKE FAILED: routing 100% back to $PREV"; route "$PREV:100"; echo "active now: $(active)"; exit 1; fi
env -u CLOUDFLARE_API_TOKEN node scripts/canary-o11y.mjs "$NEW" "$T_LIVE" "$OUT/live.ids" | tee "$OUT/live-o11y.json" || { log "LIVE TELEMETRY FAILED: routing 100% back to $PREV"; route "$PREV:100"; exit 1; }
echo "DEPLOYED $NEW (previous $PREV) git $SHA; artifacts $OUT"
