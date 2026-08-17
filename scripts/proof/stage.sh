#!/bin/bash
# stage.sh <NN> <slug> [proof-dir]: full app-window PNG + tmux/mail receipts.
set -euo pipefail

NN="${1:?stage number}"
SLUG="${2:?stage slug}"
DIR="${3:-proof-artifacts}"
APP="${PROOF_APP:-instant}"
SOCKET="${PROOF_SOCKET:-instant-prod}"

mkdir -p "$DIR"

BOUNDS=$(osascript -e "tell application \"System Events\" to tell (first process whose name is \"$APP\") to get {position, size} of front window" 2>&1)
if [[ "$BOUNDS" =~ ^([-0-9]+),\ ([-0-9]+),\ ([0-9]+),\ ([0-9]+)$ ]]; then
  X="${BASH_REMATCH[1]}"; Y="${BASH_REMATCH[2]}"; W="${BASH_REMATCH[3]}"; H="${BASH_REMATCH[4]}"
  screencapture -x -R"$X,$Y,$W,$H" "$DIR/stage-$NN-$SLUG.png"
else
  # Accessibility denied or window not found: whole screen still has the UI in frame.
  echo "window bounds unavailable ($BOUNDS); capturing the whole screen" >&2
  screencapture -x "$DIR/stage-$NN-$SLUG.png"
fi

{
  echo "stage: $NN $SLUG"
  echo "at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "tmux ($SOCKET):"
  tmux -L "$SOCKET" list-sessions -F "  #{session_name} attached=#{session_attached}" 2>&1 || true
  echo "mail tail:"
  tail -5 ~/.agent/mail/bus.ndjson 2>/dev/null | sed 's/^/  /' || true
} >> "$DIR/receipts.log"

echo "$DIR/stage-$NN-$SLUG.png"
