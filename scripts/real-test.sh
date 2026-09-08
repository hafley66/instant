#!/bin/bash
# The one way to run the real tier. One playwright stack at a time on this
# machine (lock), niced, one spec file per invocation, boop's fork verb stubbed,
# and a swap guard so a starved box refuses the run instead of paging to death.
#
#   scripts/real-test.sh e2e-real/fork.spec.ts [more playwright args]
#
# env: INSTANT_REAL_PORT (47790), INSTANT_REAL_SOCKET (instant-real-e2e),
#      INSTANT_SERVE_BIN, INSTANT_REAL_FORCE=1 skips the swap guard,
#      INSTANT_REAL_MIN_SWAP_MB (1000).
set -eu
cd "$(dirname "$0")/.."
[ $# -ge 1 ] || { echo "usage: scripts/real-test.sh <spec.ts> [playwright args]" >&2; exit 2; }
port="${INSTANT_REAL_PORT:-47790}"
socket="${INSTANT_REAL_SOCKET:-instant-real-e2e}"
lock="/tmp/instant-real-test.lock"
min_swap="${INSTANT_REAL_MIN_SWAP_MB:-1000}"

if [ -z "${INSTANT_REAL_FORCE:-}" ]; then
  free_mb=$(sysctl -n vm.swapusage | sed -E 's/.*free = ([0-9.]+)M.*/\1/' | cut -d. -f1)
  if [ "${free_mb:-0}" -lt "$min_swap" ]; then
    echo "real-test: swap free ${free_mb}M is under ${min_swap}M; refusing to start a browser (INSTANT_REAL_FORCE=1 overrides)" >&2
    exit 3
  fi
fi

if ! mkdir "$lock" 2>/dev/null; then
  echo "real-test: another real-tier run holds $lock (pid $(cat "$lock/pid" 2>/dev/null || echo ?)); one stack at a time" >&2
  exit 4
fi
echo $$ > "$lock/pid"
before=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | sort || true)

cleanup() {
  pkill -f "instant-serve --port $port" 2>/dev/null || true
  tmux -L "$socket" kill-server 2>/dev/null || true
  after=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | sort || true)
  leaked=$(printf '%s\n' "$after" | comm -13 <(printf '%s\n' "$before") - 2>/dev/null || true)
  if [ -n "$leaked" ]; then
    echo "real-test: sessions left on the default tmux socket: $leaked" >&2
    for s in $leaked; do
      case "$s" in fork-comment-*) "${REAL_BOOP:-$HOME/.cargo/bin/boop}" beep lane delete "$s" >/dev/null 2>&1 || true; tmux kill-session -t "=$s" 2>/dev/null || true ;; esac
    done
  fi
  rm -rf "$lock"
}
trap cleanup EXIT INT TERM

export INSTANT_REAL_PORT="$port" INSTANT_REAL_SOCKET="$socket"
export INSTANT_SERVE_BIN="${INSTANT_SERVE_BIN:-$HOME/.cache/cargo-target/feature-serve-bin/debug/instant-serve}"
export REAL_BOOP="${REAL_BOOP:-$HOME/.cargo/bin/boop}"
export INSTANT_FORK_STUB_LOG="/tmp/$socket/fork-stub.log"
export INSTANT_REAL_STUB_PATH="$PWD/e2e-real/stub-bin"
mkdir -p "/tmp/$socket"
: > "$INSTANT_FORK_STUB_LOG"

# The playwright binary directly (no npm exec process) and a capped node heap
# for the runner and its one worker.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=256"
nice -n 15 ./node_modules/.bin/playwright test -c playwright.real.config.ts --workers 1 "$@"
