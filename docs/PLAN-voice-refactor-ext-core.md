# Voice mode, refactor targets, turnkey extension core

Date: 2026-07-03. Source: repo exploration (instant + ~/projects/local-ext), Claude Code docs, web research.

---

## 1. Voice mode in instant

Two independent blockers, one overriding fact.

### Blocker A: microphone TCC (missing entirely)

- Zero hits for `microphone|NSMicrophone|entitlement|Info.plist|AVAudio` across `src/` and `src-tauri/`.
- No `Info.plist`, no `.entitlements`, no `infoPlist` key in `tauri.conf.json`.
- macOS attributes mic access to the responsible app bundle. In iTerm2 the grant target is `com.googlecode.iterm2` (why it works there). In instant, Claude Code's audio module runs as a child of instant's bundle, which declares no usage string, so capture is denied.
- Fix: `NSMicrophoneUsageDescription` in the bundled Info.plist (Tauri 2: `src-tauri/Info.plist` merge or `bundle.macOS` config), rebuild, run `/voice` once to trigger the TCC prompt. `scripts/sign-link.sh` already gives stable dev signatures so the grant persists.
- If prompt never appears: `tccutil reset Microphone <instant bundle id>`, quit fully, relaunch.

### Blocker B: hold-space key path

- Chain: xterm.js → pty → tmux → claude. Hold detection relies on key-repeat events.
- Custom key handler `src/main.ts:1257` returns early on non-keydown. Kitty keyboard protocol (encodes releases, `main.ts:159`) enabled only for graphics tabs (`main.ts:1256`).
- Browser autorepeat keydowns should flow through as data, so hold mode may work after the mic fix. If it misfires: `/voice tap` bypasses key-repeat, or rebind `voice:pushToTalk` to a modifier combo in `~/.claude/keybindings.json`.
- Test order: mic fix → `/voice tap` → hold mode.

### Overriding fact: /voice is cloud STT

- `/voice` streams audio to Anthropic's servers. No local option. Requires Claude.ai login (not API key/Bedrock/Vertex). Docs: https://code.claude.com/docs/en/voice-dictation
- Given the no-cloud-voice constraint, the daily-driver answer is a local push-to-talk app (§2), which also makes Blocker B irrelevant (the app types into xterm.js like a keyboard, and mic permission belongs to the dictation app, not instant).

## 2. Local STT under 16GB

All run on-device on Apple Silicon:

| Model | Size | Notes |
|---|---|---|
| Parakeet-TDT-0.6B-v3 | ~2 GB | lower WER than whisper large-v3 at 4x smaller; fastest on Apple Silicon |
| whisper large-v3-turbo (whisper.cpp) | ~6 GB | Metal acceleration, broadest language coverage |
| Moonshine | 27 MB+ | beats whisper large-v3 with 6x fewer params; streaming-friendly |
| distil-whisper | ~2-3 GB | low-latency streaming |

Push-to-talk apps wrapping these (hold key, speak, text typed at cursor in any app):

| App | License | Backends |
|---|---|---|
| Handy | open source, cross-platform | Whisper, Parakeet V3, Moonshine |
| VoiceInk | GPLv3, macOS | whisper.cpp |
| open-wispr | MIT, macOS | whisper.cpp + Metal |
| OpenWhispr | open source, cross-platform | Whisper, Parakeet |

Sources:
- https://northflank.com/blog/best-open-source-speech-to-text-stt-model-in-2026-benchmarks
- https://www.onresonant.com/resources/local-stt-models-2026
- https://spokenly.app/blog/parakeet-vs-whisper
- https://www.getvoibe.com/resources/handy-review/
- https://www.getvoibe.com/resources/voiceink-review/
- https://open-wispr.com/
- https://github.com/OpenWhispr/openwhispr

## 3. Repo eval

Language split: 15 `.ts`, 8 `.tsx`, 2 `.js` (both `extension/`), 18 `.rs`. Strict TS on; 3 `any` escapes in `src/`.

| Finding | Evidence |
|---|---|
| God file | `src/main.ts` 5,502 lines, ~130 top-level functions: terminals, tabs, worktrees, favorites, browser, overlay, zoom, keymap, drag/drop |
| Vanilla DOM vs React split | React only in dockview shell + 5 panels; palette, prompts, context menus, worktree tree are imperative `createElement`/`innerHTML` |
| Three state patterns | central store (`state.ts`/`store.ts`/`useStore.ts`); meme direct `localStorage` (`meme.tsx` ~146-165); module-level mutable registries (`plugin.tsx`, `keymap.ts`, terminal registry in `main.ts`) |
| Plugin API bypassed | favorites via bespoke `registerFavoritesBridge` (`main.ts:728`); status probes registered separately |
| Dual panel paradigms | `PanelDef` takes React `component` or raw `html` string injected via `innerHTML` (`plugin.tsx:143`) |
| Two table impls | `src/table.ts` (270, vanilla) vs `src/treetable.tsx` (477, tanstack) + `tablepanels.tsx` (1,126) |
| Tests | zero front-end; Rust tests only in `src-tauri/src/kitty.rs` |
| Untyped extension | `extension/*.js` outside tsconfig, no `@types/chrome` |

Other god files: `meme.tsx` 1,152; `tablepanels.tsx` 1,126; `cdp.ts` 833; `lib.rs` 820; `pty.rs` 622; `cdp.rs` 616; `reactdock.tsx` 547; `ledger.rs` 516.

## 4. Context awareness today

| Capability | Status |
|---|---|
| Clipboard | webview `navigator.clipboard` (`main.ts:739,1137,4364,4448`, `meme.tsx:884`) + tmux OSC-52 bridge (`pty.rs:241-253`). No background watching; needs `tauri-plugin-clipboard-manager` + Rust-side polling for that |
| VSCode / LSP | nothing. Cheapest path: tiny VS Code extension POSTing active file on `onDidChangeActiveTextEditor` to the ingest server |
| Browser | `extension/` reports nav, tab lifecycle, copy, selection, clicks to `POST 127.0.0.1:8787/ingest` (`src-tauri/src/activity.rs:175`, tiny_http) |

## 5. Turnkey extension core design

One MV3 core, config-driven, server is source of truth. Unifies `instant/extension/` (activity spy) with the patterns proven in `~/projects/local-ext/extension/`.

### Rule shape

```
{ id, host: regex, url?: regex,
  mode: "textnodes" | "selector" | "netcapture",
  selector?, regex?, captures: {group -> field},
  schedule?: {intervalMin} | "passive",
  action: "report" | "notify" }
```

Replaces local-ext's hardcoded `/usage/i` (`inject_main.js:21`) and usage-specific DOM heuristics (`background.js:289-408`).

### Engine layers (all prototyped across the two repos)

| Layer | Source to generalize |
|---|---|
| config transport | extension fetches `GET 127.0.0.1:8787/config` each tick (local-ext pattern, `background.js:26-47`); rules live in instant |
| text-node scan | TreeWalker `scan()` in local-ext `background.js:376-408`; add MutationObserver for SPAs |
| selector engine | `querySelectorAll` + per-node regex |
| network capture | MAIN-world fetch/XHR patch, local-ext `inject_main.js:23-54`, gated per-rule |
| driven scans | background-tab reload + `scripting.executeScript` (local-ext `runOnce`, `background.js:204-275`); this is the "/see every host in config" command |
| reporting | existing `POST /ingest`; add `{ruleId, url, matches[]}` event type |
| control center | instant plugin panel: rules CRUD + live match feed |

### MV3 host-matching decision

Static `matches` cannot be config-driven. Options: (a) `<all_urls>` content script that no-ops unless `location.host` matches a rule (activity spy already ships `<all_urls>`); (b) `scripting.registerContentScripts` + `optional_host_permissions`. Chosen: (a), one code path, personal-use extension. Everything stays on 127.0.0.1.

## 6. Work packages

| # | Package | Status | Agent |
|---|---|---|---|
| 1 | Mic entitlement (voice Blocker A) | merged to main (`3be11a5`) 2026-07-03 | sonnet |
| 2 | Turnkey extension core (§5, milestone 1) | merged to main (`3ebce48`) 2026-07-03 | opus |
| 3 | Split `main.ts` by concern (5,502 -> 437 lines, 16 modules) | merged to main (`b695934`) 2026-07-03 | opus |
| 3b | Rules panel + match feed onto TreeTable grid (AGENTS.md rule) | on main (`92bf5be`) 2026-07-03 | sonnet |
| 4 | `PanelDef` React-only; convert html-string panels; delete `#panel-pool` reparenting | queued | |
| 5 | Meme `localStorage` -> central store; namespaced plugin persistence key | queued | |
| 6 | Favorites onto `registerPlugin` | queued | |
| 7 | Vitest harness + tests (`fuzzy.ts`, store); Rust tests for `pty.rs` | queued | |
| 8 | VS Code active-file reporter extension | queued | |

Post-merge notes:
- ext-core deviation: driven scans use `tabs.sendMessage` to the injected content script instead of `scripting.executeScript` (avoids broad host_permissions). Deferred: `action:"notify"` acts as `report`; netcapture first-tick race.
- AGENTS.md added at repo root: row-shaped UI must reuse the TreeTable grid stack; `src/table.ts` is legacy.
