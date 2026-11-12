#!/bin/sh
# Consumer check: run ply-web's gates against a ply commit without committing the pin.
#
#   sh scripts/ply-main-check.sh <ply-sha> <out-dir>
#
# Sets dependencies.ply to github:ivarvong/ply#<sha> in the working tree (package.json and package-lock.json are
# changed in place and never committed), installs, then runs `npm test`, `npm run lint` and `npm run typecheck`.
# Writes <out-dir>/report.md (the issue body), <out-dir>/{install,test,lint,typecheck}.log and <out-dir>/summary.env
# (PLY_SHA, PLY_SHORT, PLY_PREV, OUTCOME). Exit 0 when every gate passed, 1 when a gate failed, 2 on a usage or
# install error. Used by .github/workflows/ply-main.yml; runs the same on a laptop.
set -u

sha=${1:-}
out=${2:-}
case "$sha" in
  *[!0-9a-f]* | "") echo "ply-main-check: sha must be 7-40 lowercase hex, got '${sha}'" >&2; exit 2 ;;
esac
if [ "${#sha}" -lt 7 ] || [ "${#sha}" -gt 40 ]; then
  echo "ply-main-check: sha must be 7-40 lowercase hex, got '${sha}'" >&2
  exit 2
fi
if [ -z "$out" ]; then
  echo "usage: sh scripts/ply-main-check.sh <ply-sha> <out-dir>" >&2
  exit 2
fi
mkdir -p "$out"

# The pin on this ply-web checkout: the lower end of the ply commit range under test.
prev=$(node -p "(require('./package.json').dependencies.ply.split('#')[1] || '')")

npm pkg set "dependencies.ply=github:ivarvong/ply#${sha}"
if ! npm install --no-audit --no-fund >"$out/install.log" 2>&1; then
  tail -n 40 "$out/install.log" >&2
  echo "ply-main-check: npm install of ply#${sha} failed" >&2
  exit 2
fi
# The full sha npm resolved, from the lockfile (the dispatch may carry a short one).
full=$(node -p "((require('./package-lock.json').packages['node_modules/ply'] || {}).resolved || '').split('#')[1] || ''")
case "$full" in
  "$sha"*) ;;
  *) echo "ply-main-check: lockfile resolved ply to '${full}', not ${sha}" >&2; exit 2 ;;
esac
# vite.config.ts requires a 40-hex pin, so write the resolved full sha back before any gate runs.
if [ "$full" != "$sha" ]; then
  npm pkg set "dependencies.ply=github:ivarvong/ply#${full}"
  if ! npm install --no-audit --no-fund >>"$out/install.log" 2>&1; then
    tail -n 40 "$out/install.log" >&2
    echo "ply-main-check: npm install of ply#${full} failed" >&2
    exit 2
  fi
fi
short=$(printf '%s' "$full" | cut -c1-7)
echo "ply-main-check: ply ${prev} -> ${full}"

failed=""
for gate in test lint typecheck; do
  echo "::group::npm run ${gate}"
  npm run "$gate" >"$out/${gate}.log" 2>&1
  code=$?
  cat "$out/${gate}.log"
  echo "::endgroup::"
  echo "ply-main-check: npm run ${gate} exit ${code}"
  [ "$code" -eq 0 ] || failed="${failed} ${gate}"
done

outcome=pass
[ -z "$failed" ] || outcome=fail
{
  echo "PLY_SHA=${full}"
  echo "PLY_SHORT=${short}"
  echo "PLY_PREV=${prev}"
  echo "OUTCOME=${outcome}"
} >"$out/summary.env"

{
  echo "ply main \`${full}\` fails ply-web's gates (ply-web at \`$(git rev-parse HEAD 2>/dev/null || echo unknown)\`)."
  echo
  echo "ply commit range: https://github.com/ivarvong/ply/compare/${prev}...${full}"
  echo
  echo "Failed gates:${failed:- none}"
  for gate in $failed; do
    echo
    echo "### npm run ${gate}"
    echo
    echo '```'
    if [ "$gate" = test ]; then
      # node:test's spec reporter prints `✖ name (ms)` per failing test (TAP: `not ok N - name`); vitest prints FAIL / ×.
      echo "Failing tests:"
      grep -E '^[[:space:]]*(✖|not ok|FAIL|×) ' "$out/test.log" | grep -v 'failing tests:' | sed 's/^[[:space:]]*//' | sort -u | head -n 60
      echo
    fi
    tail -n 30 "$out/${gate}.log"
    echo '```'
  done
} >"$out/report.md"

echo "ply-main-check: ${outcome}${failed:+ (${failed# })}"
[ "$outcome" = pass ]
