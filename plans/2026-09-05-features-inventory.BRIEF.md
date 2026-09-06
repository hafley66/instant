# Lane: docs/FEATURES.md, the instant feature inventory (instant)

Favor plain reading and exact receipts. This lane writes one document and one script; no product code changes. If reality deviates, STOP and write `plans/2026-09-05-features-inventory.REPORT.md`.

## Why
Chris: "i think there are like 50 features in this thing and i literally do not know." The document is for a reader with zero context: name the feature, how it is triggered, where it lives, when it landed.

## Deliver
1. `scripts/features-inventory.py` (python3, stdlib only): extracts every palette command from `src/**/*.ts*` (object literals with `id`, `keys`, `title`, optional `group`; `$mod` prints as ⌘) and prints a markdown table sorted by group. Re-runnable; the doc's palette section is its output pasted verbatim.
2. `docs/FEATURES.md`, opens with a TOC, tables only, no prose paragraphs (a one-line caption under a table is fine). Sections, in this order:
   1. Palette commands (34 today): group | title | keys | id | file. From the script.
   2. Sidebar rail panels: the items in the left rail (`src/rail.ts`, `src/plugins/*`, `src/boopPanel.tsx`; today the rail shows tmux, Activity, Favorites, Config, Files, Paint, Status, Boop): panel | what it shows in one line | file | first commit date.
   3. Terminal overlays and gestures: everything painted on or around an xterm (`src/0_terminal*.ts`, `src/1*_terminal*.ts`, `src/0_turnDebugOverlay*`, `src/jumpPalette.ts`, `src/refresolve*`/`src-tauri/src/refresolve.rs`, `src/clickrules.ts`, the session file-diff panel with `t<N> user E` / `t<N> assistant A` tags and the `+N files edited before this session (show)` fold): feature | trigger (key, click, hover, right-click, automatic) | file | first commit date.
   4. Context menus: every entry `ctxItemsFor` in `src/main.ts` can produce (and `src/1g_forkPresetMenu.ts`, `src/rail.ts` menus): entry | when it appears | what it runs.
   5. Drops and pastes: `src/dnd.ts`, `src/dropcatcher.ts`, `boop beep paste`: what a dropped image / file / text does, per target pane kind.
   6. Tabs and sessions: tmux binding rules (`src/0_tabTitleFromTmux.ts`, sidebar), tab commands, reopen, browser tab.
   7. Settings: every persisted key (`grep -rn "setting<\|storageSignal(" src`), key | type | default | which feature reads it.
   8. Boop-backed reads: every tauri command in `ipc/commands.json` that starts with `boop_`: command | what it reads | which UI uses it.
   First-commit dates: `git log --diff-filter=A --format=%ad --date=short -- <file> | tail -1`.
3. `docs/README.md` or the existing docs index (check `ls docs`) gains one line pointing at FEATURES.md.

## Rules
- Every palette command id from the script appears in section 1; every rail item appears in section 2; every `boop_*` command appears in section 8. Put the three counts at the bottom of the doc.
- Banned words in prose: provenance, substrate, load-bearing, regime. No em dashes.
- One commit, subject exactly: `docs: FEATURES.md inventory and the script that regenerates its palette table`.

## Validation (paste into the report)
```
python3 scripts/features-inventory.py | tail -3
grep -c '^|' docs/FEATURES.md
grep -c 'boop_' ipc/commands.json; grep -c 'boop_' docs/FEATURES.md
git log --oneline -1
```
