# Lane: comment fork rendering, horizontal shape (instant)

Favor plain code. If reality deviates from this brief, STOP and write REPORT.md at the worktree root describing the deviation; do not improvise.

## Plan
Read `plans/2026-09-04-comment-fork-rendering.md` in $PWD first. Section 2 gives the exact type signatures; implement those, no others. Build section 4 (horizontal: reply block under the quoted turn). Section 5 (vertical child pane) is out of scope for this lane.

## Decisions already made (section 7 open calls)
- Default shape: horizontal.
- Who runs the verb: instant shells out to `boop beep fork <comment-id> --preset flash4`; no store writes from tauri.
- Reply source: the last assistant `agent_turn` of the lane's session; while none exists the block is the header line only.

## Files you own (inside $PWD, your worktree)
- src-tauri/src/0_boop.rs: `boop_turn_comment_forks(comment_ids: Vec<i64>) -> Vec<BoopTurnCommentFork>` beside `boop_turn_annotations` (:492); same `open_store_ro` + `spawn_blocking` shape. Read `store.turn_comment_forks(id)` (boop-store ident.rs:1682) per id; join lane state and rc from `agent_mail` (`kind='result'`, `from = lane`, body `lane <lane> done rc=N`) and the lane's session via `boop beep lane get`-equivalent store read (`agent_route` row `route = lane`, its session id), then the last assistant turn from `agent_turn` for that session. State: `running` when no result row and the route is live, `done` when a result row exists, `dead` otherwise. Use `store.query(..)`-style SQL the file already uses; do not add a new boop-store API.
- src-tauri/src/lib.rs: register the command.
- src/generated/native.ts: add the command name the way the others are listed (:78, :232).
- src/1e_terminalForkMarks.ts (new): `PlacedFork`, `placeForks`, `ForkBlock`, `forkBlock` per section 2.
- src/1d_terminalTurnMarks.ts: call `placeForks` in the same tick as `placeAnnotations` (:101), only for comment ids on screen.
- The renderer that appends rows under a turn: reuse the buffer-row path `0_terminalDiagrams.ts` uses so `0_terminalRowGeometry.ts` hit-testing stays by buffer row. Underline the quote rows with a decoration.
- src/1e_terminalForkMarks.test.ts (new): `placeForks` places one `PlacedFork` per `(comment_id, lane)`, `forkBlock` header reads `└ fork-comment-26 (flash4) done rc=0` and wraps `reply.said` at `cols`, a running fork renders the header only.
- src-tauri tests: one test for the state derivation (no result row + live route = running; result row = done; neither = dead).

Do not touch any other file. Do not touch hafley-rs. Wire JSON of existing commands unchanged.

## Rules
1. Poll cadence: same tick as `boop_turn_annotations`, only for visible comment ids; no timer of its own.
2. Banned identifiers: provenance, substrate, load-bearing, regime.
3. One commit, subject exactly: `terminal: horizontal fork block under a commented turn; boop_turn_comment_forks read`.

## Validation (run all, paste output into REPORT.md)
```
export CARGO_TARGET_DIR=$HOME/.cache/cargo-target/fork-render
cd src-tauri && cargo test 2>&1 | tail -15 && cd ..
npx vitest run 2>&1 | tail -8
npx tsc --noEmit 2>&1 | tail -5
git log --oneline -1
```
instant clippy has 12 pre-existing errors outside your lines; do not fix them, do not gate on clippy.
Write REPORT.md at the worktree root.
