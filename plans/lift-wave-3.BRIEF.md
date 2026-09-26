# lift-wave-3: instant terminals run on @hafley66/boop-xterm wave 3 models (sol6)

**Goal:** `terminal.ts` builds each terminal with `createBoopXtermView` from `@hafley66/boop-xterm`. Delete instant's copies of every wave 3 file in the same change.

## Read first, whole files
- `~/projects/hafley-rxjs/plans/boop-xterm-wave3.DESIGN.md`: section 8 (host composition, instant-only table) and section 12 (rulings)
- `~/projects/hafley-rxjs/packages/boop-xterm/src/9_view.ts`, `3_ports.ts`, `theme.css`
- `plans/lift-wave-2.BRIEF.md`, the previous cutover, for its shape
- `~/projects/claude-research/skills/rxjs/SKILL.md`
- `~/projects/claude-research/skills/signals/SKILL.md`

## Steps
1. **Baseline:** record tsc error count, failing test files, and the non-test `.subscribe(` count. Today's count is 67.
2. **Pins:** set every `@hafley66/*` dev pin to stamp `1790432843607` (all 12 are on verdaccio), run `pnpm install`, and commit `deps: boop-xterm wave 3 dev pins`.
3. **Typed endpoints:** add typed `commandEndpoint` entries in `scripts/generate-native.mjs` and `src/generated/native.ts`. Use wave 2's commit `c6b4d700` as the pattern. The Endpoints are:
   - `boop_turn_comments`, `boop_turn_annotations`, `boop_turn_comment_forks`
   - `boop_turn_comment_upsert`, `boop_turn_comment_delete`, `boop_turn_comments_sent`
   - `squares_watch`, `squares_unwatch`, `boop_mux_exit_copy_mode`, `write_pty`

   Argument names must match the Rust `#[tauri::command]` signatures listed in design section 2. Commit this step.
4. **Cutover:**
   - `terminal.ts` calls `createBoopXtermView` with the full `BoopXtermPorts` shown in design section 8.
   - Graphics tabs build `graphicsOverlayStream` beside it.
   - The host merges the view's events into its effect stream: `menuRequested` into the fork menu, `favoriteToggle`/`tagEdit` into favorites, `selectionWritten` into the fork continuation, and `gutterChanged` into `refitForGutter`.
   - The instant-only behaviour in design section 8's table stays in instant.
5. **Theme:**
   - Import `@hafley66/boop-xterm/theme.css` once.
   - In instant's stylesheet, map instant's app variables onto the package tokens where instant's look differs from the package defaults, for example `--boop-xterm-context-queue-bg: var(--panel-bg)`.
   - Delete the instant CSS rules that the package now owns (`styles.css` 1028-1380 as listed in design section 7, `1_agentSquares.css`, `1_turnPanel.css`), keeping any rule instant-only UI still uses.
6. **Delete these instant files and their tests:**
   - `0_terminalDiagrams`, `1_terminalStructuredOverlay`, `0_turnDebugOverlay`
   - `1a2_terminalContextGutter`, `1a_terminalContextQueue`, `1b_terminalContextSync`, `1c_terminalHoverCheck`
   - `1d_terminalTurnMarks`, `1e_terminalForkMarks`, `1f_terminalForkRender`
   - `0_agentSquareVisual`, `1_agentSquaresMarks`, `1_agentSquaresModel`, `1_agentSquaresFeed`, `1_agentSquares`
   - `1_turnPanel`, `graphics`

   Importers switch to `@hafley66/boop-xterm` exports. Use `extract` for specifier repair where it applies.

## Gates
- `rg -l` for each deleted file's basename in `src` prints nothing.
- `npx tsc --noEmit` errors are at most baseline.
- Failing test files are a subset of baseline.
- `pnpm build` passes.
- Non-test `.subscribe(` count is strictly below baseline. Report the number.
- No `as any`, `as unknown as`, `as never`, `@ts-*` comments, `.skip`, `.only`, `toBeDefined` added.
- No edits under `node_modules` or to hafley-rxjs.
- `pnpm test:e2e` for any spec touching terminal, turns, context, forks, squares or diagrams: list the spec files and results. Real-backend specs that failed at base `a3f6729a` may still fail; name them.

## Stop on
- A package defect: a missing export, a wrong type, or behaviour that differs from instant's original. Report file:line in the package; do not work around it in instant.
- Any change needed in hafley-rxjs.

## Commit
Scoped commits as you go. Final subject exactly: `refactor: terminals run on @hafley66/boop-xterm wave 3 models`

Receipt: status / sha / files / validation (every gate with its number) / next.
