#!/usr/bin/env bash
#
# Compile every BPMNscript process under ./processes into deployable BPMN under
# src/main/resources/processes/, so the Spring Boot "demo" profile auto-deploys
# them all (Operaton scans the classpath for *.bpmn on startup).
#
# Prerequisite: the project must be built so the CLI exists
# (`npm run build` from the repo root).
#
# Usage:  ./compile-processes.sh        (from this directory)
#
set -euo pipefail

cd "$(dirname "$0")"

REPO_ROOT="../.."
CLI="$REPO_ROOT/packages/cli/bin/cli.js"
SRC_DIR="processes"
OUT_DIR="src/main/resources/processes"

if [[ ! -f "$CLI" ]]; then
  echo "error: CLI not found at $CLI — run 'npm run build' from the repo root first." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
shopt -s nullglob

count=0
for src in "$SRC_DIR"/*.bpmnscript; do
  base="$(basename "$src" .bpmnscript)"
  node "$CLI" build "$src" -o "$OUT_DIR/$base.bpmn"
  count=$((count + 1))
done

echo "Compiled $count process(es) into $OUT_DIR/"
