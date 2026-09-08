#!/bin/bash
# Fresh serve per run: no dock restore references a dead session.
set -e
pkill -f "instant-serve --port 47803" 2>/dev/null || true
sleep 0.3
tmux -L instant-real-c kill-server 2>/dev/null || true
rm -rf /tmp/instant-real-c-data /tmp/instant-real-c-home
mkdir -p /tmp/instant-real-c-data /tmp/instant-real-c-home
HOME=/tmp/instant-real-c-home INSTANT_TMUX_SOCKET=instant-real-c \
  /Users/chrishafley/.cache/cargo-target/feature-serve-bin/debug/instant-serve \
  --port 47803 --data-dir /tmp/instant-real-c-data \
  --dist "/Users/chrishafley/projects/instant-worktrees/condom/.boop-worktrees/feature/real-term-diagrams/dist" \
  >/tmp/instant-real-c-serve.log 2>&1 &
sleep 1
curl -s -o /dev/null -w "serve %{http_code}\n" http://127.0.0.1:47803/
