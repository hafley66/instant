# REPORT: features inventory lane

Delivery: `docs/FEATURES.md` + `scripts/features-inventory.py` + one README
index line. Commit `f8e098d` subject `docs: FEATURES.md inventory and the
script that regenerates its palette table`.

## Deviations from the brief

1. Section 3 listed "the session file-diff panel with `t<N> user E` /
   `assistant A` tags and the `+N files edited before this session (show)`
   fold". No such panel exists in the tree. Greps for the strings
   (`edited before this session`, `user E`, `assistant A`, the fold) across
   `src`, `src-tauri`, and the whole repo return nothing. The nearest real
   surface is the turn attribution overlay (`src/0_terminalTurnVisibility.ts`,
   `src/0_turnDebugOverlay.ts`) and the comment marks
   (`src/1d_terminalTurnMarks.ts`), which do carry the `t<N> user/assistant`
   tags. The doc documents those and notes the absence.

2. The rail panel list in the brief (8 items) omitted Worktrees and Rules.
   The registry (`railPanelIds`, panels without a `railParent`) has 10 top-level
   panels: tmux, Worktrees, Activity, Favorites, Config, Status, Files, Paint,
   Rules, Boop, plus `Metrics` nested under `Rules`. The doc lists all of them.

3. `src/0_tabTitleFromTmux.ts` does not exist; tab-title-from-tmux lives in
   `src/tabs.ts` (`syncTabTitlesFromTmux`, first commit 2026-07-03).

## Validation (as pasted from the brief)

```
python3 scripts/features-inventory.py | tail -3
grep -c '^|' docs/FEATURES.md
grep -c 'boop_' ipc/commands.json; grep -c 'boop_' docs/FEATURES.md
git log --oneline -1
```

Output:

```
| View | Toggle Turn Attribution Debug Overlay |  | view.turnDebug | src/main.ts |

34 palette commands.
177
2
23
f8e098d docs: FEATURES.md inventory and the script that regenerates its palette table
```

`boop_` appears on 2 lines of `ipc/commands.json` (the two array lines) and on
23 lines of the doc; all 22 `boop_*` commands are listed in section 8. The
`grep -c` values are line counts, so they need not match.

## Counts

- Palette commands (script output): 34
- Rail panels (top-level): 10
- Boop-backed commands: 22
