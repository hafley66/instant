# lift-wave-2 (sol6): instant runs terminals on @hafley66/boop-xterm layer-1 models

Design: ~/projects/hafley-rxjs/plans/boop-xterm-wave2.DESIGN.md (section 9 overrides). Package source:
~/projects/hafley-rxjs/packages/boop-xterm/src (read only). Read ~/projects/claude-research/skills/signals/SKILL.md and rxjs/SKILL.md.

## Step 0: baseline (receipt carries it)
`pnpm install --frozen-lockfile`, `npx tsc --noEmit` error count, `pnpm test` file/test counts,
`.subscribe(` count: `rg -c '\.subscribe\(' src -g '!*.test.*' -g '!*.spec.*' | awk -F: '{s+=$2} END{print s}'`.

## Step 1: pins
Every `@hafley66/*` pin currently at `-dev.1790389689806` moves to the same base version at `-dev.1790394856560`
(`npm view @hafley66/<n> dist-tags.dev`). Commit `deps: boop-xterm wave 2 dev pins`.

## Step 2: typed command endpoints (design ruling 6)
`scripts/generate-native.mjs` emits `commandEndpoint<I, O>(name)` with I/O typed per command for the 7 port commands
(boop_mux_session, boop_mux_capture, boop_turns, boop_turns_recent, boop_sync_session, boop_locate_turns, scroll_session),
types taken from the Rust signatures in src-tauri (field names exactly as serde emits them). Regenerate; `--check` passes.
Commit `build(native): typed command endpoints for boop-xterm ports`.

## Step 3: cutover
- terminal.ts builds `BoopXtermPorts` from those endpoints and host signals, calls `createBoopXtermPane(term, el, identity, ports)`,
  and replaces XtermViewportAdapter, NativeTmuxPane, TerminalLineAnchors, TerminalTurnVisibilityV2, TerminalWheelRouter,
  TerminalPinnedSelection. The pane's `effects` joins the stream terminal.ts hands up; if terminal.ts has no such stream
  yet, it may subscribe `pane.effects` exactly once per pane, and that subscription must replace >= 2 removed subscribe sites.
- Delete from src (with tests, which already live in the package): 00a_terminalIntersection.ts (keep type re-exports
  the rest of instant needs, from the package), 00b_terminalLineAnchors.ts, 0_terminalTurnVisibility.ts, 0_terminalWheel.ts,
  0_terminalPinnedSelection.ts, 0b_ompTurnBinding.ts.
- Consumers of the removed classes (0_turnDebugOverlay, 1_terminalStructuredOverlay, 1a_terminalContextQueue,
  1d_terminalTurnMarks, 0_terminalDiagrams, forkSelection etc.) read the model fields (`visibility.state`, `visibility.changes`,
  `visibility.settled`, `anchors.state`, `turnAtBufferRow`, `bufferRowAtPoint`). Minimal edits; no redesign of wave-3 files.
Commit `refactor: terminals run on @hafley66/boop-xterm layer-1 models`.

## Gates (receipt carries every output line)
1. `rg -l "00a_terminalIntersection|00b_terminalLineAnchors|0_terminalTurnVisibility|0_terminalWheel|0_terminalPinnedSelection|0b_ompTurnBinding|TerminalTurnVisibilityV2|XtermViewportAdapter|NativeTmuxPane|TerminalWheelRouter" src` prints nothing.
2. tsc errors <= baseline; pnpm test failing files subset of baseline (test file count drops only by deleted files; list them).
3. `.subscribe(` count strictly below baseline.
4. `git diff <base>..HEAD | rg '^\+.*(as any|as unknown as|as never|@ts-ignore|@ts-expect-error|\.skip\(|\.only\(|toBeDefined)'` prints nothing; no new `vi.mock` of package or product code.
5. `pnpm build` passes.
6. Live check: `pnpm test:e2e --grep "turn|terminal"` (list specs run and results). If e2e needs the Tauri app and cannot run headless, say so and run the specs that can.

## Stop on
A consumer needing a class method with no model equivalent (name file:line + method), a package defect (name export + behavior),
any need to edit hafley-rxjs. Report and stop.
Receipt: status / sha / files / validation / next.
