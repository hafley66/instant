#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
export LANG=C

# Proves that tmux display-message, list-* and capture-pane queries do not
# mutate a pane. The proof runs against a new isolated tmux server so unrelated
# pane output cannot race the before/after comparison.

proof_dir="$(mktemp -d /tmp/tmr.XXXXXX)"
socket_name="readonly-proof-$$"
session_name="proof"
export TMUX_TMPDIR="$proof_dir"

tmux_proof() {
  tmux -L "$socket_name" "$@"
}

cleanup() {
  tmux_proof kill-server >/dev/null 2>&1 || true
  rm -rf "$proof_dir"
}
trap cleanup EXIT INT TERM

tmux_proof new-session -d -s "$session_name" \
  "printf 'VISIBLE-A\\nVISIBLE-B\\nVISIBLE-C\\n'; exec sleep 30"
target="${session_name}:0.0"
tmux_proof set-option -t "${session_name}:0" automatic-rename off
tmux_proof rename-window -t "${session_name}:0" proof-window

for _ in {1..100}; do
  current_command="$(tmux_proof display-message -p -t "$target" '#{pane_current_command}')"
  if [[ "$current_command" == "sleep" || "$current_command" == "gsleep" ]] &&
    tmux_proof capture-pane -p -t "$target" | grep -q '^VISIBLE-C$'; then
    break
  fi
done

state() {
  {
    tmux_proof list-sessions -F 'session=#{session_id}:#{session_name}:#{session_windows}'
    tmux_proof list-windows -a -F 'window=#{session_id}:#{window_id}:#{window_name}:#{window_layout}'
    tmux_proof list-panes -a -F 'pane=#{session_id}:#{window_id}:#{pane_id}:#{pane_width}x#{pane_height}:cursor=#{cursor_x},#{cursor_y}:history=#{history_size}:mode=#{pane_in_mode}:alternate=#{alternate_on}:dead=#{pane_dead}'
    tmux_proof capture-pane -p -N -t "$target"
  }
}

before="$(state)"
before_hash="$(printf '%s' "$before" | shasum -a 256 | awk '{print $1}')"

for _ in {1..100}; do
  tmux_proof display-message -p -t "$target" \
    '#{session_id} #{window_id} #{pane_id} #{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{history_size} #{pane_in_mode} #{alternate_on}' >/dev/null
  tmux_proof list-sessions >/dev/null
  tmux_proof list-windows -a >/dev/null
  tmux_proof list-panes -a >/dev/null
  tmux_proof capture-pane -p -t "$target" >/dev/null
  tmux_proof capture-pane -p -J -S - -t "$target" >/dev/null
done

after="$(state)"
after_hash="$(printf '%s' "$after" | shasum -a 256 | awk '{print $1}')"

printf 'READ-ONLY TMUX QUERY PROOF\n'
printf 'server socket: %s/%s\n' "$TMUX_TMPDIR" "$socket_name"
printf 'target: %s\n' "$target"
tmux_proof display-message -p -t "$target" \
  'facts: session=#{session_id} window=#{window_id} pane=#{pane_id} size=#{pane_width}x#{pane_height} cursor=#{cursor_x},#{cursor_y} history=#{history_size} mode=#{pane_in_mode} alternate=#{alternate_on}'
printf 'visible capture:\n'
tmux_proof capture-pane -p -t "$target" | sed -n '/^VISIBLE-A$/,/^VISIBLE-C$/p'
printf 'before sha256: %s\n' "$before_hash"
printf 'after  sha256: %s\n' "$after_hash"

if [[ "$before" != "$after" ]]; then
  printf 'FAIL: tmux state changed across read queries\n' >&2
  diff -u <(printf '%s\n' "$before") <(printf '%s\n' "$after") || true
  exit 1
fi

printf 'PASS: 600 read queries produced zero pane/session/window state changes\n'
