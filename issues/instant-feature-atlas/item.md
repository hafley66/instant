---
created: 2026-09-12
updated: 2026-09-14
type: epic
status: in-progress
priority: normal
---

# Declare Instant app architecture and verify scoped Boop showcase

## Description

Declared app and plugin entrypoints, developer architecture and ownership map, terminal-scoped Boop network/history, shared Vitest Chromium integration, and reproducible README attribution/network screenshots. Delegated in isolated Boop worktrees; acceptance requires actual validation evidence.

## Comments

### 2026-09-12T19:51:39Z · @codex

Final integration authorized. Network d42e3349 and atlas88c170fb assigned to fresh f41 integration lane. Independent review and red-green evidence complete; parent reproduced foreign-root deletion. Acceptance now forbids whole-tmux-server teardown in tests and helpers; cleanup targets owned sessions only. Native TUI, ps activity, ghcacher routing and final cross-repo verification remain active. Nothing integrated or installed yet.

### 2026-09-14T00:13:35Z · @codex

README audit at aa9901b0: four referenced docs/screenshots PNGs are absent; source Layout block is stale. Candidate scenes: terminals with D2/Mermaid, fork menu, metrics/rules, recipient selection. General e2e-real/0_real.ts hardcodes HOME/.agent/boop.db and includes default tmux helpers; isolate those before screenshot regeneration. Chromium covers app surfaces; macOS summon gesture needs native capture. Source-only report /private/tmp/instant-readme-audit-result.md. No README rewrite or screenshot regeneration performed in this audit.

### 2026-09-14T01:00:05Z · @codex

README delivery integrated and pushed to origin/main through 3909a620, including worker commits 51a1d150, d93e2321, 6444ae3e. Five real Playwright captures cover inline D2/Mermaid turns, turn favorite menu, persisted favorites, two-recipient selector, roster/mail. Parent capture run 4/4 passed on isolated port 47817; main just check, just build, just cargo-check passed. Relative README links all resolve. Rustdoc remains pending. README lane/worktree/branch removed after merge; wider atlas and network scope remain separate.

### 2026-09-14T13:48:56Z · @codex

Cleanup 2026-09-14: retained chore/f41-final-integration-20260912 at e9241faef05821012b870f40ab9d11504db97473 as the consolidated pending terminal-scoped network/app-atlas source. Removed precursor worktrees chore/f41-independent-review-20260912, fix/f41-scoped-network-20260912 and test/f41-isolation-red-20260912 after preserving exact tips under archive/boop-cleanup-20260914/<original-branch>. Luna dirty test harness is superseded by the consolidated branch; its binary diff is backed up locally. Main active-only/split timeline and loading fixes are already delivered; do not overwrite them by merging the old integration wholesale. Future port must reuse current tests and retain scratch-root/tmux cleanup ownership. Source-only audit; no new test result claimed.

### 2026-09-14T14:00:13Z · @codex

Cleanup final: the consolidated integration worktree is now removed. Candidate source remains at local ref archive/boop-cleanup-20260914/chore/f41-final-integration-20260912 (e9241faef05821012b870f40ab9d11504db97473). Precursor review and red-test tips remain under the same archive prefix. Port terminal scoping selectively onto current main; no full stale merge and no current test pass claimed.





## Agent Runs

### 2026-09-12T20:20:27Z · @f41-integration-lane

Branch chore/f41-final-integration-20260912 from 9fca010e, ready to merge (not merged, not installed). Merged fix/f41-scoped-network-20260912 (d42e3349) at 050c4a0e and chore/luna-app-atlas-20260912 (88c170fb) at aecb5a32, both clean. Delivery commits: 6f282986 (teardown stops only owned tmux sessions, never kill-server), 2454d8f5 (one boop-tab instance id), 53f17a20 (README screenshot links + scoped-panel atlas + signature validator), cc563d1f (docs/2_delivery-receipt.md). Audit: zero kill-server / killAllSessions in scripts, e2e, src, src-tauri. Unowned-session survival regression retained. Validation: frozen-lockfile install; just check; just build; CARGO_BUILD_JOBS=2 cargo check; full vitest 107 files/664 passed; scripts/4_scopedNetworkCleanupOwnership.test.ts 2 passed; pnpm test:showcase 9 passed with no leftover sockets or servers; atlas validator valid (20 entrypoints, 10 signatures). Blocker: cargo test --lib does not compile due to pre-existing 0_boop.rs fixture drift against current hafley-rs (missing Harness::mock_tui_launch, two Capabilities fields); required gates pass.
