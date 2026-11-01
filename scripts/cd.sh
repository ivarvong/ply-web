#!/bin/sh
# Run the operator CLI on a Node that satisfies package.json engines.
# The default `node` on the operator image can be older than that range.
# A matching build lives at /workspace/node-v24.22.1-linux-x64 when the image has it.
# .nvmrc names 24.22.1. PLY_NODE overrides the search.
set -eu
cd "$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

satisfies() {
  "$1" --experimental-strip-types --eval "import { nodeSatisfies } from './scripts/cd/preflight.ts'; process.exit(nodeSatisfies(process.version) ? 0 : 1)"
}

try_bin() {
  if [ -n "$chosen" ] || [ -z "$1" ] || [ ! -x "$1" ]; then
    return 0
  fi
  if satisfies "$1"; then
    chosen=$1
  fi
}

chosen=''
path_node=$(command -v node || true)
if [ -n "${PLY_NODE:-}" ]; then
  try_bin "$PLY_NODE"
fi
try_bin /workspace/node-v24.22.1-linux-x64/bin/node
try_bin "$path_node"

if [ -z "$chosen" ]; then
  current='missing'
  if [ -n "$path_node" ]; then
    current=$("$path_node" -p process.version 2>/dev/null || printf '%s' "$path_node")
  fi
  printf '%s\n' "cd: harness_fault preflight: no Node satisfies package.json engines (current ${current}). The operator image keeps one at /workspace/node-v24.22.1-linux-x64/bin/node. .nvmrc asks for 24.22.1. Set PLY_NODE to a binary that satisfies engines." >&2
  exit 1
fi

export PLY_CD_NODE_REEXEC=1
exec "$chosen" --experimental-strip-types scripts/cd/main.ts "$@"
