#!/usr/bin/env bash
# Inner pipeline for the tighten experiment. One-shot opencode pass over the
# rendered message, re-run until the output reaches a fixed point (or the pass
# cap). The fixed-point check runs here in the shell; the model never
# self-assesses.
#
# Usage: pipe.sh <msg.txt> <out.md>
#
# Env:
#   CONCATMAP_MODEL   model id (default flash4 via deepinfra pin)
#   CONCATMAP_CAP     max passes before the last pass wins (default 3)
set -euo pipefail

MSG="${1:?usage: pipe.sh <msg.txt> <out.md>}"
OUT="${2:?usage: pipe.sh <msg.txt> <out.md>}"
MODEL="${CONCATMAP_MODEL:-openrouter/deepseek/deepseek-v4-flash-0731}"
CAP="${CONCATMAP_CAP:-3}"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

normalize() {
  tr -s '[:space:]' ' ' < "$1"
}

prev=""
pass=0
while :; do
  pass=$((pass + 1))
  cur="$TMPDIR/pass$pass.md"
  opencode run -m "$MODEL" "$(cat "$MSG")" > "$cur" 2>/dev/null

  if [[ -n "$prev" && "$(normalize "$cur")" == "$prev" ]]; then
    cp "$cur" "$OUT"
    exit 0
  fi
  prev="$(normalize "$cur")"

  if [[ "$pass" -ge "$CAP" ]]; then
    cp "$cur" "$OUT"
    exit 0
  fi
done
