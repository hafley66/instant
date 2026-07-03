# Rules for agents working in this repo

## No bespoke list/table UIs
Never hand-roll a list, table, or tree-list UI in a panel. Any UI that renders rows of
data reuses the existing grid stack:

- `src/treetable.tsx` — TreeTable (@tanstack/react-table + react-virtual): sorting,
  searching, keyboard nav, virtualization, tree expansion. This is the canonical grid.
- `src/tablepanels.tsx` — reference consumers (TmuxPanelV2, WorktreesPanelV2,
  ActivityPanelV2, FavoritesPanelV2). Copy their column-def + row-model shape.

If it looks like rows (a file tree, a rule list, a match feed, a session list), it is
the grid. Flat lists are a one-level tree. Do not add a third table implementation;
`src/table.ts` (vanilla) is legacy — do not build new panels on it.

## No massive files
Keep source files under ~500 lines. When a change would push a file past that, split by
concern into sibling modules first (see the main.ts split: composition root + 16 concern
modules). One panel per file. Do not grow god files back.

## Split panes
Never hand-roll drag-resize math (pointermove listeners computing clamped widths/heights)
for a split pane. Use `react-resizable-panels`: `PanelGroup` / `Panel` / `PanelResizeHandle`
(pin the `3.x` line — `4.x` renamed these to `Group`/`Panel`/`Separator`). Persist layout via
the `onLayout` callback into the panel's `pluginState` slice (see `src/pluginState.ts`), not
the library's own `autoSaveId` localStorage path. Style `PanelResizeHandle` with the skin's
existing frame/hover tokens and set the correct `col-resize`/`row-resize` (or `ew-resize`/
`ns-resize`) cursor. See `src/memeSplit.tsx` + `src/memeSplitLayout.ts` for the reference
implementation, including the one-time px-based-legacy-state -> percentage-layout migration.

## Gates
`just check` (tsc strict), `just build`, `just cargo-check` must pass before commit.
Extension code: `just ext-build`.

## Dev runs
Never run `just dev` from an agent/verification session — the owner's daily-driver
instance is always running, and a second `just dev` fights it for the same macOS tray
icon and double-click/double-cmd summon gesture (both process-wide singletons). Use
`just dev-safe` instead, which sets `INSTANT_NO_GLOBALS=1` to skip tray creation, the
global shortcut, and the summon-gesture CGEventTap in the second instance (it shows its
window on launch instead, since the summon gesture is otherwise the only way to reach it).
