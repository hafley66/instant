#!/usr/bin/env bash
# concatMap lane loop: turn query -> queue -> inner pipeline -> out/.
# Resident shell owned by the concat-map lane. Reads new (ai,user) contact
# pairs out of the boop store and pipes each through the experiment's inner
# pipeline one at a time (concatMap), in order, coalescing a backlog to the
# newest pair at drain time.
#
# Usage: concatmap-loop.sh <experiment>
#   <experiment>  name of a directory under experiments/ holding template.md,
#                 pipe.sh, and mode.
#
# Env:
#   POLL_SECONDS   query interval (default 5)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPERIMENT="${1:?usage: concatmap-loop.sh <experiment>}"
EXP="$ROOT/experiments/$EXPERIMENT"
TEMPLATE="$EXP/template.md"
MODE="$(cat "$EXP/mode")"
STATE="$ROOT/state/$EXPERIMENT"
QUEUE="$STATE/queue"
DONE="$STATE/done"
OUT="$ROOT/out"
CURSOR_FILE="$STATE/cursor"
POLL="${POLL_SECONDS:-5}"

for f in "$TEMPLATE" "$EXP/pipe.sh" "$EXP/mode"; do
  [[ -f "$f" ]] || { echo "concatmap: missing $f" >&2; exit 1; }
done

mkdir -p "$QUEUE" "$DONE" "$OUT"

if [[ -f "$CURSOR_FILE" ]]; then
  cursor="$(cat "$CURSOR_FILE")"
else
  # First run: start at the newest turn already in the store so the lane only
  # processes pairs that arrive after launch, not the whole historical backlog.
  cursor="$(boop db --format ndjson "select coalesce(max(ts),0) as m from agent_turn" | jq -r '.m')"
  printf '%s\n' "$cursor" > "$CURSOR_FILE"
fi

render_msg() {
  # Template -> msg on stdin, values via env to dodge shell escaping.
  local ai="$1" user="$2"
  CM_MODE="$MODE" CM_AI="$ai" CM_USER="$user" python3 - "$TEMPLATE" <<'PY'
import os, sys
t = open(sys.argv[1]).read()
print(t.replace("{{mode}}", os.environ["CM_MODE"])
        .replace("{{ai_text}}", os.environ["CM_AI"])
        .replace("{{user_text}}", os.environ["CM_USER"]), end="")
PY
}

query() {
  boop db --format ndjson "
select s.nickname, u.session_id, u.turn, u.ts,
       u.said as user_text, a.said as ai_text
from agent_turn u
join agent_session s on s.session_id = u.session_id
left join agent_turn a
  on a.session_id = u.session_id
 and a.role_id = 2
 and a.turn = (select max(turn) from agent_turn
               where session_id = u.session_id and role_id = 2
                 and turn < u.turn)
where u.role_id = 1 and u.ts > $cursor
  -- Every inner-pipeline run is itself an opencode session whose turn 1 is
  -- this template rendered. Sync ingests it, so without this filter the loop
  -- maps its own prompts forever.
  and trim(u.said, char(34)) not like 'mode: %'
order by u.ts"
}

process_pair() {
  local file="$1"
  local nickname turn ai user
  nickname="$(jq -r '.nickname' "$file")"
  turn="$(jq -r '.turn' "$file")"
  ai="$(jq -r '.ai_text // ""' "$file")"
  user="$(jq -r '.user_text // ""' "$file")"
  local short="${nickname:0:8}"
  local outdir="$OUT/$short"
  mkdir -p "$outdir"
  local msgfile="$STATE/msg-$turn.txt"
  local outfile="$outdir/$turn.md"
  render_msg "$ai" "$user" > "$msgfile"
  "$EXP/pipe.sh" "$msgfile" "$outfile"
}

coalesce() {
  # Overflow policy (default): keep only the newest queued pair, drop the rest.
  local files=()
  while IFS= read -r f; do files+=("$f"); done < <(find "$QUEUE" -type f | sort)
  local n="${#files[@]}"
  if (( n > 4 )); then
    local keep="${files[$((n-1))]}"
    local drop
    for drop in "${files[@]:0:$((n-1))}"; do
      rm -f "$drop"
    done
    echo "concatmap: coalesced $((n-1)) stale pairs -> $keep" >&2
  fi
}

while true; do
  max_seen="$cursor"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    session_id="$(jq -r '.session_id' <<<"$line")"
    turn="$(jq -r '.turn' <<<"$line")"
    ts="$(jq -r '.ts' <<<"$line")"

    if [[ -f "$DONE/$session_id-$turn" ]]; then
      # Dedupe on (session_id, turn); a late sync burst can deliver a pair twice.
      [[ "$ts" -gt "$max_seen" ]] && max_seen="$ts"
      continue
    fi
    if find "$QUEUE" -name "*-$session_id-$turn" -print -quit | grep -q .; then
      [[ "$ts" -gt "$max_seen" ]] && max_seen="$ts"
      continue
    fi

    printf '%s\n' "$line" > "$QUEUE/$ts-$session_id-$turn"
    [[ "$ts" -gt "$max_seen" ]] && max_seen="$ts"
  done < <(query)

  coalesce

  local_files=()
  while IFS= read -r f; do local_files+=("$f"); done < <(find "$QUEUE" -type f | sort)
  for file in "${local_files[@]}"; do
    session_id="$(jq -r '.session_id' "$file")"
    turn="$(jq -r '.turn' "$file")"
    process_pair "$file"
    rm -f "$file"
    touch "$DONE/$session_id-$turn"
  done

  if [[ "$max_seen" -gt "$cursor" ]]; then
    cursor="$max_seen"
    printf '%s\n' "$cursor" > "$CURSOR_FILE"
  fi

  sleep "$POLL"
done
