# FEATURES.md: the instant feature inventory

What instant is, feature by feature: how each is triggered, where it lives, when it landed. Built for a reader with zero context.

## Contents

- [1. Palette commands](#1-palette-commands)
- [2. Sidebar rail panels](#2-sidebar-rail-panels)
- [3. Terminal overlays and gestures](#3-terminal-overlays-and-gestures)
- [4. Context menus](#4-context-menus)
- [5. Drops and pastes](#5-drops-and-pastes)
- [6. Tabs and sessions](#6-tabs-and-sessions)
- [7. Settings](#7-settings)
- [8. Boop-backed reads](#8-boop-backed-reads)
- [Counts](#counts)

---

## 1. Palette commands

Open with ⌘⇧P (or ⌘P). Typing filters; ↑/↓ move; Enter runs; Esc dismisses. Table below is the verbatim output of `python3 scripts/features-inventory.py`.

| group | title | keys | id | file |
| --- | --- | --- | --- | --- |
| AI | Favorite Latest AI Turn | ⌘⇧s | ai.favTurn | src/main.ts |
| Agent | Jump to a file the agent touched | ⌘⇧j | agent.jump | src/main.ts |
| App | Reload Window | ⌘r | app.reload | src/main.ts |
| App | Reload Window (Safe Boot) | ⌘⇧r | app.safeReload | src/main.ts |
| App | Zoom In | ⌘=, ⌘⇧= | app.zoomIn | src/main.ts |
| App | Zoom Out | ⌘- | app.zoomOut | src/main.ts |
| App | Reset Zoom | ⌘0 | app.zoomReset | src/main.ts |
| Browser | Toggle Performance Mode (1x) |  | browser.perf | src/main.ts |
| Browser | Cycle Render Quality |  | browser.quality | src/main.ts |
| Overlay | Toggle Click-Through | ⌘⇧i | overlay.clickThrough | src/main.ts |
| Overlay | Toggle Fade | ⌘⇧d | overlay.fade | src/main.ts |
| Overlay | Toggle Mini Mode | ⌘⇧m | overlay.mini | src/main.ts |
| Overlay | Cycle Overlay Mode | ⌘⇧o | overlay.mode | src/main.ts |
| Palette | Show All Commands | ⌘⇧p | palette.open | src/main.ts |
| Skin | Cycle Skin |  | skin.cycle | src/main.ts |
| Skin | Toggle Super XP (pixel font) |  | skin.xpPixel | src/main.ts |
| Tabs | Open Browser |  | tab.browser | src/main.ts |
| Tabs | Close Tab | ⌘w | tab.close | src/main.ts |
| Tabs | Next Tab | ⌘⇧], ⌃Tab | tab.next | src/main.ts |
| Tabs | New Tab at Current Directory | ⌘t | tab.open | src/main.ts |
| Tabs | Previous Tab | ⌘⇧[, ⌃⇧Tab | tab.prev | src/main.ts |
| Tabs | Reopen Closed Tab | ⌘⇧t | tab.reopen | src/main.ts |
| View | Toggle Session Sidebar | ⌘⇧Backslash | term.sidebar | src/main.ts |
| View | Toggle Comment Fork Live Pane (overlay ⇄ child pane) |  | view.forkLivePane | src/main.ts |
| View | Toggle Inline Diagrams |  | view.inlineDiagrams | src/main.ts |
| View | Toggle Table/List Selection Checkboxes |  | view.inlineStructuredSelectors | src/main.ts |
| View | Toggle Dark Mode |  | view.mode | src/main.ts |
| View | Set Panic Button Text |  | view.panicBody | src/main.ts |
| View | Toggle Panic Button |  | view.panicButton | src/main.ts |
| View | Cycle Panic Button Mode |  | view.panicMode | src/main.ts |
| View | Cycle Panic Button Subtext |  | view.panicSub | src/main.ts |
| View | Screenshot to Active Terminal |  | view.shot | src/main.ts |
| View | Toggle Top Toolbar |  | view.toolbar | src/main.ts |
| View | Toggle Turn Attribution Debug Overlay |  | view.turnDebug | src/main.ts |

The rail panels (section 2) also register as palette commands under group `Panel` (`panel.<id>`, keys empty) via `allPanels()`. Titled bindings without a literal string id (the numbered `tab.goto1..9`) are hidden from the palette.

## 2. Sidebar rail panels

The left rail. Drag to reorder, right-click to show/hide, hover a tooltip while compact. `Metrics` nests under `Rules` (railParent).

| panel | what it shows | file | first commit |
| --- | --- | --- | --- |
| tmux | tmux session list with live/agent/rogue state | src/tablepanels.tsx | 2026-06-25 |
| Worktrees | worktree list with a nested file tree | src/tablepanels.tsx | 2026-06-25 |
| Activity | captured activity timeline (browser, capture, file opens) | src/tablepanels.tsx | 2026-06-25 |
| Favorites | favorited AI turns, grouped by session | src/tablepanels.tsx | 2026-06-25 |
| Config | plugin config toggles (options list) | src/activity.tsx | 2026-07-03 |
| Status | background service health with a rail dot | src/status.tsx | 2026-06-29 |
| Files | file explorer and search tree | src/plugins/files | 2026-07-21 |
| Paint | paint editor | src/paintPanel.tsx | 2026-07-19 |
| Rules | activity rules editor (raw JSON) | src/rules.tsx | 2026-07-03 |
| Boop | lane roster and mail stream (marbler) | src/boopPanel.tsx | 2026-09-01 |
| Metrics | usage/spend dashboards (child of Rules) | src/plugins/metrics | 2026-07-20 |

## 3. Terminal overlays and gestures

Everything painted on or around an xterm, and the gestures that drive it.

| feature | trigger | file | first commit |
| --- | --- | --- | --- |
| Inline Mermaid/D2 diagrams, click to zoom | automatic (agent output) / click | src/0_terminalDiagrams.ts | 2026-08-04 |
| Turn attribution tags (`t<N> user` / `assistant`) in the gutter, per-turn hue | automatic | src/0_terminalTurnVisibility.ts | 2026-08-20 |
| Turn attribution debug overlay (full row tags) | palette toggle `view.turnDebug` | src/0_turnDebugOverlay.ts | 2026-08-23 |
| Structured table/list overlay, click to expand | automatic / click | src/1_terminalStructuredOverlay.ts | 2026-08-20 |
| Prompt context queue (NEXT MESSAGE) | right-click "Ask about this" | src/1a_terminalContextQueue.ts | 2026-08-20 |
| Gutter selection checkboxes on structured rows | click | src/1a2_terminalContextGutter.ts | 2026-09-04 |
| Hover line checkbox in the gutter | hover | src/1c_terminalHoverCheck.ts | 2026-09-04 |
| Comment marks (pencil) and fork blocks on quoted turns | click / right-click | src/1d_terminalTurnMarks.ts | 2026-09-04 |
| Fork mark placement on comment rows | automatic | src/1e_terminalForkMarks.ts | 2026-09-05 |
| Fork block horizontal renderer | automatic | src/1f_terminalForkRender.ts | 2026-09-05 |
| Comment/context sync to boop.db (pull + write-through) | automatic | src/1b_terminalContextSync.ts | 2026-08-31 |
| Pinned selection overlay for mouse-owning panes (codex/claude) | selection | src/0_terminalPinnedSelection.ts | 2026-08-30 |
| Row geometry + line anchors (positioning foundation) | automatic | src/0_terminalRowGeometry.ts | 2026-09-04 |
| ⌘-click routing (token to file/url/rule action) | ⌘-click | src/clickrules.ts | 2026-07-03 |
| ⌘-hover ref resolution card | ⌘-hover | src/refResolve.ts | 2026-07-25 |
| Jump palette (files the agent touched) | ⌘⇧J | src/jumpPalette.ts | 2026-09-04 |
| Fork preset submenu (pick a lane preset) | right-click fork | src/1g_forkPresetMenu.ts | 2026-09-05 |

The brief asked for a session file-diff panel carrying `t<N> user E` / `assistant A` tags with a `+N files edited before this session (show)` fold. No such panel exists in the tree today; the nearest real surface is the turn attribution overlay and comment marks above, which carry the `t<N> user/assistant` tags.

## 4. Context menus

One right-click handler (`ctxItemsFor` in src/chrome.ts, wired in src/main.ts) maps the click target to its entries.

| entry | when it appears | what it runs |
| --- | --- | --- |
| Add to selection / Remove from selection | right-click on a scoped entity cell | `toggleScope` (sprefa scope) |
| Copy | right-click on an entity cell | clipboard write |
| Open (paste path) | right-click on a file entity | `pasteToActive` |
| Clear selection | right-click on an entity cell | clears `sprefaScope` |
| Paste / Copy | right-click on an activity row | `pasteToActive` / clipboard |
| Expand Mermaid/D2 diagram | right-click over a diagram | diagram lightbox |
| Boop session:turn (disabled label) | right-click over a turn | none (identifies the turn) |
| ★ favorite turn | right-click over a turn | `favoriteBoopTurn` |
| no Boop turn at pointer (disabled) | right-click in a terminal with no turn | none |
| Ask about this | right-click with a selection | `askAboutSelection` (queues for next message) |
| Copy selection | right-click with a selection | clipboard |
| Fork selection (with preset submenu) | right-click with a selection | `forkSelection` |
| Paste | right-click in a terminal | `pasteToActive` |
| Clear | right-click in a terminal | terminal buffer clear |
| Screenshot region | right-click in a terminal | `captureToPrompt` |
| New session | right-click on empty window | `openTabAtPwd` |
| Cycle skin / Super XP on-off / Dark-light mode | right-click on empty window | settings toggles |

Rail menus: right-click anywhere on the rail toggles each panel's visibility (src/rail.ts, `railMenuItems`). Fork preset submenu entries come from `boop config presets` (src/1g_forkPresetMenu.ts).

## 5. Drops and pastes

| gesture | what it does | file |
| --- | --- | --- |
| Finder file drop over the sprefa scope tray | adds each path to the sprefa file scope | src/dnd.ts |
| Finder file drop on a terminal (image) | `boop beep paste --pane … <path>` so the pane's app takes it as a picture | src/dnd.ts |
| Finder file drop on a terminal (other) | paths shell-quoted and typed into the active terminal | src/dnd.ts |
| Drag in progress | raises the headless dropcatcher window to read absolute paths | src/dropcatcher.ts |
| Right⌘ + Right⇧ + V (`boop beep paste`) | copies the frontmost app's selection and writes it into the active terminal | src/main.ts |

## 6. Tabs and sessions

| feature | trigger | file |
| --- | --- | --- |
| Tab title from tmux, durable rename, pin (📌) | automatic + rename/pin | src/tabs.ts |
| Visual tab nav across all panes (⌘1..9, next, prev) | keys | src/tabs.ts |
| Close / new-at-pwd / reopen-closed tab | keys (⌘W, ⌘T, ⌘⇧T) | src/tabs.ts |
| Reopen with agent resume | ⌘⇧T | src/tabs.ts |
| Open browser tab | palette `tab.browser` | src/browser.ts |
| Dock layout persistence and panel pooling | automatic | src/reactdock.tsx |

## 7. Settings

Persisted keys. `setting<key>` in src/0_settings.ts, src/0_overlaySettings.ts, src/0_panicSettings.ts; `sprefa.root` via `storageSignal` in src/reactive/statusModel.ts.

| key | type | default | reads it |
| --- | --- | --- | --- |
| skin | string | xp | chrome + terminal theme |
| mode | string | light | dark/light chrome |
| xpPixel | bool | false | pixel font |
| zoom | number | 1 | webview zoom |
| panelZoom | map | {} | per-panel font zoom |
| showToolbar | bool | false | top toolbar |
| sidebar | string | big | rail compact/big |
| sidebarWidth | number | 150 | rail width |
| termSidebar | map | {} | per-terminal session sidebar |
| clipboardFromTerminal | bool | true | OSC52 terminal clipboard |
| inlineDiagrams | bool | true | diagram overlay |
| boopOnlyActive | bool | true | Boop panel filter |
| inlineStructuredSelectors | bool | true | gutter checkboxes |
| active | string\|null | null | restore active tab |
| openTabs | array | [] | restore tabs |
| tabTitles | map | {} | durable tab renames |
| dockJSON | unknown | null | dock layout |
| resumeTabs | map | {} | agent resume records |
| pinnedTabs | array | [] | pinned tabs |
| sessionWorktrees | map | {} | session to worktree map |
| autoWorktrees | array | [] | extra worktree roots |
| sessionSort | object | activity desc | session sort |
| pinnedSessions | array | [] | pinned sessions |
| wtView | string | tree | worktree view |
| scanRoot | string | ~/projects | worktree scan root |
| wtExpanded / favExpanded | array | [] | tree expansion |
| wtFavorites | array | [] | favorite worktrees |
| wtFocus | bool | false | worktree follow focus |
| wtAgents | array | defaults | agent launch list |
| spaces | array | [] | non-git workspaces |
| activitySource / activityType | string | all | Activity filters |
| captureEnabled | bool | false | OS capture |
| tableSort | map | {} | per-table sort state |
| aiEnabled | bool | true | AI integrations switch |
| autoResume | bool | true | auto resume |
| clickRules | array | defaults | ⌘-click rules |
| sprefaScope / sprefaScopeActive | array/bool | []/false | sprefa scope |
| pluginState | map | {} | per-plugin slices (rail) |
| overlayMode | string | off | overlay mode |
| overlayTarget | string | Code | follow target |
| overlayFade | bool | false | faded panel |
| miniMode | bool | false | compact overlay |
| panicButton | bool | true | panic button |
| panicBody | string | default | panic text |
| panicPos | object | 0,0 | panic position |
| panicMode | string | clear | panic behavior |
| panicSub | string | below | panic subtext |
| sprefa.root | string | ~/projects/sprefa/v5 | sprefa root |
| fork.presets.order / favorites | array | [] | fork preset menu order/favorites |

## 8. Boop-backed reads

Every tauri command in ipc/commands.json starting with `boop_`. Backend in src-tauri/src/0_boop.rs, src-tauri/src/0_tmux.rs, src-tauri/src/0_harness_store.rs.

| command | what it reads | which UI uses it |
| --- | --- | --- |
| boop_turns | turns of one session | Favorites panel |
| boop_turns_recent | recent turns since a time, by harness | Favorites panel |
| boop_sync_session | session/harness attribution stats | terminal turn tagging |
| boop_locate_turns | turns for given line ranges | terminal turn overlays |
| boop_favorite_add | adds a turn to favorites | Favorites (backend) |
| boop_favorites | boop favorites list | Favorites panel |
| boop_favorite_toggle | toggles a turn favorite | Favorites panel |
| boop_turn_comments | comments for a session's turns | terminal context/comment marks |
| boop_turn_comment_upsert | writes a comment | comment/context sync |
| boop_turn_comment_delete | deletes a comment | comment/context sync |
| boop_turn_comments_sent | marks comments sent | comment/context sync |
| boop_turn_annotations | annotations/comments for sessions | terminal context/comment marks |
| boop_turn_comment_forks | forks of given comment ids | terminal fork blocks |
| boop_config_presets | boop lane presets | fork preset menu |
| boop_lanes | current lane roster | registered (panel uses session_graph) |
| boop_lane_events | lane mail events since a time | Boop panel |
| boop_agent_touches | files an agent touched | jump palette (⌘⇧J) |
| boop_session_graph | session/lane graph | Boop panel |
| boop_mux_capture | a tmux pane's screen | terminal intersection/capture |
| boop_mux_session | tmux session id for a pane | terminal intersection |
| boop_mux_send_keys | sends keys to a pane | panic button |
| boop_mux_exit_copy_mode | exits tmux copy mode | terminal wheel/scroll |

## Counts

- Palette commands: 34
- Rail panels (top-level): 10
- Boop-backed commands: 22
