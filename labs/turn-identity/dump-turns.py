"""Dump the newest TURN_WINDOW turns of a boop session, matching what
`src-tauri/src/0_boop.rs:read_turns` hands the frontend."""

import json
import sqlite3
import sys

TURN_WINDOW = 300
DB = "/Users/chrishafley/.agent/boop.db"


def dump(name: str, session: str, harness: str) -> None:
    db = sqlite3.connect(DB)
    top = db.execute(
        "SELECT MAX(t.turn) FROM agent_turn t "
        "WHERE t.session_id = (SELECT id FROM dict_session WHERE value = ?)",
        (session,),
    ).fetchone()[0]
    if top is None:
        raise SystemExit(f"{name}: no turns for {session}")
    low = max(0, top - TURN_WINDOW)
    rows = db.execute(
        "SELECT t.turn, t.ts, r.value, t.said FROM agent_turn t "
        "JOIN dict_session s ON s.id = t.session_id "
        "JOIN dict_role r ON r.id = t.role_id "
        "WHERE s.value = ? AND t.turn >= ? ORDER BY t.turn",
        (session, low),
    ).fetchall()
    out = [
        {"session": session, "harness": harness, "turn": t, "ts": ts, "role": role, "said": said or ""}
        for t, ts, role, said in rows
    ]
    with open(f"fixtures/{name}.turns.json", "w") as handle:
        json.dump(out, handle, indent=1)
    print(f"{name:10} {harness:9} {session:40} turns {low}..{top} ({len(out)} rows)")


if __name__ == "__main__":
    for spec in sys.argv[1:]:
        dump(*spec.split("=", 2))
