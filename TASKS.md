# TASKS

Working backlog for the instant tmux/worktree workbench. Checked = landed in the
working tree (may still need a `tauri dev` rebuild to run).

## Big rocks (decided)
- [ ] **Migrate ALL lists to TanStack `@tanstack/react-table` + `@tanstack/react-virtual`.** One headless `<TreeTable>` (columns + `getSubRows` + sort + virtual) replaces `table.ts` (`renderTable`/`virtualTable`), the `treeNode` tree, and the `<ul>` session list. Headless = keep xp/p5/ac3 CSS. Drives: worktrees tree+table, sessions, files, activity, sprefa results.
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
