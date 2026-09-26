# Brief: one turn projection feeds the squares strip and the turn overlay

Branch: `fix/the-gang-reads-one-strip`

## Defect
Two pipelines decide which boop turns are on screen in a pane, and they disagree. The user reports the squares strip is right and the turn overlay/debug is wrong.

| | squares strip (correct) | turn overlay / gutter / debug |
| --- | --- | --- |
| code | `src-tauri/src/1_squares.rs` (Rust) | `@hafley66/boop-xterm` `6_turnVisibility.ts` + `2_turnLocate.ts` (TS) |
| trigger | pty dirty bit, one capture per flush | client scan / `scanRequested` |
| turn set | `boop_store` session turns cut at the reset boundary (`current_conversation`, `:402`) | `boop_turns(session)` with a harness-wide `boop_turns_recent` fallback, then `selectProjectionTurns` guessing |
| screen text | tmux `capture-pane` | xterm buffer rows (+ `boop_mux_capture` check) |
| matcher | `boop_turnvis` | `boop_locate_turns` (Rust) or TS `locateVisibleTurns` |
| viewport | tmux `#{scroll_position}` | xterm `viewportY` |
| delivery | push `squares-update` | request/response |

## Want
One Rust projection per pane. It emits one frame, and every surface reads that frame.

1. In `1_squares.rs`, extend the reconcile to emit a `turn-projection` frame alongside or in place of `squares-update`:
   `{ pty, session, harness, viewport: { scroll_position, pane_height, history_size }, turns: LocatedTurn[] }`.
   Each `LocatedTurn` carries the pane-capture row span plus what the overlay needs (id, session, turn, role, confidence, regions). Field names follow the existing `LocatedTurn` wire spelling; no renamed copies.
2. The frame must let the client map capture rows to xterm buffer rows. Document the mapping. It is the same pane, offset by `history_size - scroll_position`; verify against tmux and xterm scrollback lengths.
3. Instant wiring: `listenNativeEvent("turn-projection")` becomes the source for the boop-xterm port that feeds turn visibility. The package change itself (6_turnVisibility reading the frame and deleting the TS query/locate path) is a follow-up in hafley-rxjs. This lane defines the port shape, `turnProjection: Signal<TurnProjectionFrame | null>` inside the one host state signal (see hafley-rxjs `issues/boop-xterm-no-map-one-signal`), and writes a follow-up brief for the package change in `plans/`.
4. The harness-wide `boop_turns_recent` fallback must not be the source of any on-screen attribution. Remove its use from the overlay path in instant, or document which caller still needs it.

## Rules
- All of this is Rust side. No TS matcher logic.
- No JS `Map` in new TS. One state signal read by path; no per-field `Signal(...)` records.
- One golden Rust test: a fixture pane capture plus a fixture turn set, producing a snapshot of the frame (`insta` if already in the workspace, else an inline expected string). Delete or replace any narrower tests this supersedes; don't add more than 2 tests total.
- Time cap: no command over 300s. No playwright/e2e.
- The Rust path deps `../../hafley-rs` don't resolve from a worktree. Create a symlink `.boop-worktrees/fix/hafley-rs -> ~/projects/hafley-rs` (gitignored) and use `CARGO_TARGET_DIR=~/projects/instant/src-tauri/target`.
- Commit on the branch; do not push; do not merge.

## Report (mail back)
3 lines: the frame shape (Rust struct + field list); the capture-row → buffer-row mapping and how it was verified; the test receipt, plus the path of the follow-up brief for the package change.
