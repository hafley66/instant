# TASKS

Working backlog for the instant tmux/worktree workbench. Checked = landed in the
working tree (may still need a `tauri dev` rebuild to run).

## Big rocks (decided)
- [~] **Migrate ALL lists to TanStack `@tanstack/react-table` + `@tanstack/react-virtual`.** One headless `<TreeTable>` (columns + `getSubRows` + sort + virtual) replaces `table.ts` (`renderTable`/`virtualTable`), the `treeNode` tree, and the `<ul>` session list. Headless = keep xp/p5/ac3 CSS. Drives: worktrees tree+table, sessions, files, activity, sprefa results.
  - [x] `src/treetable.tsx` — generic headless `<TreeTable>` (react-table v8), emits `.dtable` markup → all skins style it free. Flat + tree (mark a column `tree` + pass `getSubRows`), column sort, row click/dbl/context, draggable `rowEntity`.
  - [x] **tmux v2** + **worktrees v2** panels (`src/tablepanels.tsx`), registered alongside the vanilla panels (ids `tmux2`/`worktrees2`). Bridge pattern: derivation + handlers stay in `main.ts` (`tmuxRows`/`wtRows`/`wtGestures`/`registerV2Bridges`); the React panels are presentational + `useApp()`-subscribed. Component panels skip `PanelDef.onShow` (pool-adoption only) → a mount `useEffect` calls `bridge.onShow`.
  - [ ] **files v2** — tree via row-expand (`getSubRows` + the `tree` column twisty). Next.
  - [ ] activity → virtualized `<TreeTable>` (`@tanstack/react-virtual` now installed; the 2000-row spy is why virtual exists). Then retire `table.ts`, the `treeNode` tree, and the `<ul>` session list once the v2 panels replace v1.
- [ ] **Kill all innerHTML / vanilla DOM string-building.** No more `innerHTML =` template assembly. Convert panels from `injectPanelHtml` strings to React components rendered through dockview-react. Inventory below.
- [ ] **CSS Anchor Positioning polyfill** (`@oddbird/css-anchor-positioning`) so tooltips/menus can use native `anchor-name`/`position-area`/`position-try` in WebKit. (installing now)
- [ ] **Native tooltips** via `data-tip` + anchor-positioning (least code, override via CSS), replacing scattered `title="…"`.

### innerHTML / vanilla inventory (what's still not React)
- `src/table.ts` — `renderTable` + `virtualTable`, 12 `createElement`. → becomes `<TreeTable>`.
- `src/ctxmenu.ts` — `showContextMenu`, 3 `createElement`. → React menu or keep (small).
- `src/plugin.tsx:78,96` — `injectPanelHtml` writes `p.html` strings + rail button. → React panels.
- `src/reactdock.tsx:208` — error `<pre>` injection. → minor.
- `src/main.ts` — heavy: session list (`:412`), worktree hosts (`:659/662/841/963`), files preview (`:1089/1218-1240`), config panel (`:1292/1337-1349`), source/preview render (`:1433-1539`), sprefa (`:1558/1562`). All to migrate as the panels move to React.

## Done (this session)
- [x] Worktree favorites: star worktrees, `Focus` toggle filters to starred (`wtFavorites`/`wtFocus`).
- [x] Worktree filepath on disk: tree leaves (tildified) + `path` column in flat table.
- [x] Configurable agent list (`wtAgents`, default claude/opencode), editable via right-click → "edit agents…".
- [x] tmux panel renamed from "Sessions"; shows foreground proc (`pane_current_command`) + cwd; pin-to-top.
- [x] Keybindings: cmd/ctrl+T new shell, cmd/ctrl+W close active tab.
- [x] **New-vs-reuse picks only the latest session.** `freshSessionName` unions open tabs + `store.sessions`; chooser menu lists every existing session to resume, then each new option. Single+right click open it; double = new default.
- [x] **OS drag-drop AND tab-drag, both working (helper-window catcher).** `dragDropEnabled:true` swallows the HTML5 drag dockview needs for tabs (macOS WKWebView; binary, no runtime toggle), so the main window keeps it `false`. A second headless window (`dropcatcher`, `dragDropEnabled:true`, transparent/always-on-top/`visible:false`) is the only surface with the native handler. Main's DOM `dragenter` still fires (handler off only strips paths, not events) → `wireOsDrop` raises the catcher over main's exact bounds → being on top it becomes the OS drop target, reads absolute paths, emits `os-file-drop` back → main routes to sprefa scope tray or `pasteToActive`. Catcher hides on drop/leave; 8s watchdog for cancelled drags. Files: `dropcatcher.html`, `src/dropcatcher.ts`, window in `tauri.conf.json`, caps in `capabilities/default.json`, 2nd entry in `vite.config.ts`. Confirmed (dragged a screenshot, path pasted). ~70 lines logic, zero new Rust.
- [x] **Empty session list.** `listEl` was cached at module load before `injectPanelHtml` created `#session-list` → null forever, render bailed. Now queried fresh per call.

## Features queued
- [x] **Keymap (tinykeys) — tab commands.** `keymap.ts`: one `Command[]` drives the window listener (tinykeys) AND the xterm passthrough (`runMatchingCommand` via `parseKeybinding`/`matchKeybindingPress`, so combos aren't typed into the pty). Bindings: next `$mod+Shift+]`/`Ctrl+Tab`, prev `$mod+Shift+[`/`Ctrl+Shift+Tab`, goto `$mod+1..9` (9=last), close `$mod+W`, open `$mod+T` (new tmux at the active tab's cwd). Replaced `handleAppShortcut`. NOTE: next/prev/goto use **tab open-order** (`tabs` Map), not dockview visual order — switch to a reactdock order helper once the tab drag-drop session lands.
- [ ] **UI zoom in/out.** Whole-UI zoom like a browser. `getCurrentWebview().setZoom(factor)` (or `zoom` CSS on the root) + keybinds cmd+`=` / cmd+`-` / cmd+`0` (reset). Persist the factor in the store; clamp ~0.5–2.0. Route through `handleAppShortcut`.
- [ ] **Config: close on outside click (default true).** Persisted `closeOnBlur: boolean` (default `true`). Gate the existing `win.onFocusChanged` auto-hide (`main.ts`, the blur→`getCurrentWindow().hide()` path) on it; expose a toggle in config/settings. Off = window stays open when it loses focus.

## Bugs still open
- [x] **cmd+1..9 / next / prev couldn't reach the v2 tool panels (tmux v2, worktrees v2).** Nav walked `termPanelOrder()` (terminals only); the v2 panels share the tab group but aren't terminals, so cmd+4 jumped to the 4th *terminal* and skipped them. Fixed: nav now walks the active group's full visual panel list (`groupPanelIds`/`activePanelId`/`focusPanelById`, generic over panel type).
- [ ] **Foreground-proc label is ugly (XP coloring partly addressed).** tmux `pane_current_command` reports claude as `2.1.191` and opencode as `opencode.exe`. Map version-ish / `.exe` names back to clean `claude`/`opencode`. (Dark-xp contrast for the v2 proc column was fixed; the label text itself is still raw.)
- [x] **XP icon pack for the activity rail.** Open lookalike set: `@react95/icons` (MIT) — its published form only ships `png/` (icons.css + react components are broken/absent), and `exports` blocks deep png imports, so the 7 used icons are copied into `public/icons/` and referenced by url. `PanelDef.iconUrl` (wins over the `icon` glyph) → `buildActivityRail` renders `<img class="ai-img">` (16px, `image-rendering: pixelated`). Map: tmux=BatExec, tmux2=BatExec2, worktrees=Explorer100, wt2=FolderExe, files=Folder, activity=WindowGraph, config=Controls3000. Sprefa + any others still fall back to the glyph.
- [ ] **Purple background on all non-xterm panes.** Window is `transparent: true` + `decorations: false`; empty/non-terminal panes don't paint a bg so the desktop bleeds through. Give dockview group-view / panel host an opaque `--surface`/`--panel-bg`. (dockview v6 `theme: themeLight` may not apply the `.dockview-theme-light` class the CSS overrides target — verify.)
- [ ] **Remove the dockview tab-overflow control** (mini split/list popover at the end of the tab bar listing all tabs).
- [ ] **Foreground-proc label is ugly.** tmux `pane_current_command` reports claude as `2.1.191` (claude sets its process title to its version) and opencode as `opencode.exe`. Map known version-ish / `.exe` names back to clean `claude`/`opencode`.

## Gesture model (settled)
- single click (220ms buffer): chooser menu — resume any existing session here, or start a new one.
- double click: new session with the default (first) agent.
- right click: same chooser menu.

## Open questions / later
- [ ] Single-click skip the menu when exactly one session exists (resume directly)?
- [ ] Pure tree views (Files) → `react-arborist` instead of TanStack? (better drag-drop, but it's a tree not columns)
- [ ] Keybinding lib (tinykeys) for chords + `when`-context, vs hand-rolled `handleAppShortcut`.
