---
created: 2026-09-20
updated: 2026-09-20
type: bug
status: testing
priority: high
---

# Terminal selection ask loses first activation and needs double right click shortcut

## Description

## Comments

### 2026-09-20T16:34:56Z · @codex

Worktree: instant-worktrees/selection-ask, branch fix/selection-ask, based on main. Root causes: Ask reread mutable terminal selection on menu activation, so a TUI repaint could clear it after the menu was built; menu popover teardown can restore focus after focusNote. Capture text and turn IDs when constructing menu, focus annotation on next animation frame, deduplicate synthetic/native contextmenu events, add double-right-click using captured action (500 ms, 8 px). Validation: 37 unit tests; 2 real-backend Playwright tests including repaint between menu-open and activation plus immediate typing; just check/build/cargo-check pass. Changes not merged.

### 2026-09-20T16:58:53Z · @codex

Additional annotation review reproduced two deterministic failures before patch: hydration lost focus/caret because renderQueue replaces textarea nodes; same-millisecond delete/add overwrote a retained row because generated IDs used Date.now and items.size. Fixed focus/caret restoration and UUID IDs. Gesture resets on scroll/resize. Full suite now 752 tests passes; just check/build passes; real first-click/double-right regressions rerun. Work remains isolated and unmerged.

### 2026-09-20T17:01:20Z · @codex

Final refreshed annotation validation: 752 unit tests pass; just check and just build pass; 2 real-backend browser tests pass with uniquely named test sessions and cleanup restricted to their own comment rows. Annotation patch also copied into fixes-integration / fix/instant-interaction-bugs for combined verification after preview work completes.

### 2026-09-20T17:28:17Z · @codex

Native conflict found from current-build report: macOS HID double-right-click tap toggled and hid visible Instant before webview shortcut handling. Integration worktree now skips right-click summon toggling while any Instant webview is focused. Rust check passes; real native gesture verification remains. Browser annotation and focus regressions passed earlier.



