# REPORT: comment fork rendering (horizontal shape)

Lane brief: `terminal: horizontal fork block under a commented turn; boop_turn_comment_forks read`.
Branch: `feature/fork-render`. Amendment 1 (2026-09-05) accepted both original blockers and added
ownership of `src/1b_terminalContextSync.ts`, `src/terminal.ts` (:771 only), and
`src/1d_terminalTurnMarks.ts`.

## What was built

- `src-tauri/src/0_boop.rs` — `BoopTurnCommentFork` + `BoopTurnCommentForkReply` wire types;
  `fork_state(has_result, live)` state derivation (result row = done, live session without one =
  running, neither = dead); `fork_reply` joining the lane's `agent_route.session_id` to the last
  assistant `agent_turn` of that session; `read_turn_comment_forks(&[i64])` calling
  `store.turn_comment_forks(id)` per id; the `boop_turn_comment_forks` tauri command (same
  `open_store_ro` + `spawn_blocking` shape as `boop_turn_annotations`). State join: latest
  `agent_mail` row `kind='result' AND from_route=lane` => done (rc from that row); else
  `agent_live` via `dict_session` => running; else dead. All joins are inline
  `store.connection().prepare(..)` SQL; no new boop-store API.
- `src-tauri/src/0_boop.rs` — `comment_id` added to `BoopTurnComment` as `#[serde(default)]`,
  populated in `comment_to_wire` (camelCase wire `commentId`; existing JSON still reads via the
  default).
- `src-tauri/src/lib.rs` — `boop_turn_comment_forks` registered.
- `src/generated/native.ts` — command name in the union and the `boop` namespace.
- `src/1b_terminalContextSync.ts` — `commentId: number` on the client `BoopTurnComment`; a
  `forks` signal fetched in `pullAnnotations` (same tick as annotations, no timer) for the
  visible comment ids via `boop_turn_comment_forks`; `toComment` sets `commentId: 0`.
- `src/terminal.ts` (:771) — the `forks` signal passed into `TerminalTurnMarks`.
- `src/1d_terminalTurnMarks.ts` — `TerminalTurnMarks` takes the forks signal, subscribes it to
  the gutter paint, and calls `placeForks` in the same paint tick as `placeAnnotations`,
  storing the result on `placedForks` for the horizontal block renderer.
- `src/1e_terminalForkMarks.ts` — `PlacedFork`, `placeForks` (one per `(comment_id, lane)` on the
  comment's row), `ForkBlock`, `forkBlock` (header `└ fork-comment-26 (flash4) done rc=0`, reply
  wrapped to `cols`; running lanes render the header only), `wrapText`.
- `src/1e_terminalForkMarks.test.ts` — `placeForks` placement/dedup, `forkBlock` header,
  reply wrap, running header-only.
- `src/1b_terminalContextSync.test.ts`, `src/1d_terminalTurnMarks.test.ts` — updated for the
  `commentId` field and the new command.

The horizontal block renderer (appending rows into the xterm buffer under the turn via the
`0_terminalDiagrams.ts` path) was not owned by this lane's file set; `1d` computes and exposes
`placedForks` for it. Vertical child pane (section 5) is out of scope.

## Validation

```
$ export CARGO_TARGET_DIR=$HOME/.cache/cargo-target/instant-harness-out && cd src-tauri && cargo test 2>&1 | tail -15 && cd ..
   Doc-tests instant_lib

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

Full Rust run: 67 passed, 1 ignored (includes `fork_state` derivation test).

```
$ npx vitest run 2>&1 | tail -8
 Test Files  89 passed (89)
      Tests  479 passed (479)
   Start at  19:46:18
   Duration  3.45s
```

```
$ npx tsc --noEmit 2>&1 | tail -5
(no errors; exit 0)
```

```
$ git log --oneline -1
<this lane's commit>
```

The cold target dir caused the original SIGTERM; the warm
`instant-harness-out` dir builds and tests cleanly. Clippy has 12 pre-existing errors outside
this lane's lines; not fixed, not gated on.
