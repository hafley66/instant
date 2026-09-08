# Lane: tauri-shell (instant, Rust)

You work in `$PWD`, your own worktree of the instant repo, branched from `integration/tauri-condom` at the tip `git log -1` shows. Never `cd` elsewhere. Commit on your branch only. Set `CARGO_TARGET_DIR=/Users/chrishafley/.cache/cargo-target/tauri-shell` for every cargo command.

## Goal
The Tauri process keeps three jobs: the tray icon with its menu, the summon shortcut (Cmd+Alt+Space, Cmd+Shift+Space when `INSTANT_ISOLATED`), and the window it summons. Everything the CGEventTap did goes away: the double-right-click and double-right-⌘ summon gestures, gesture-driven screen capture, and the Cmd+C highlight grab. The command table (`ipc/commands.json`) does not change, so the frontend needs no edit.

## Files you own (only these)
- `src-tauri/src/lib.rs`, `src-tauri/src/capture.rs`, `src-tauri/src/services.rs`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`
- `wdio.native.conf.ts`, `e2e-native/` (delete), `package.json` and `pnpm-lock.yaml` only to drop the `@wdio/*` devDependencies and the `test:e2e:native` and `native:e2e:build` scripts (`corepack pnpm@10.12.4 install` refreshes the lock)
- `src-tauri/tauri.conf.json` only if it names the `native-e2e` feature

## Steps
1. In `lib.rs` delete: `Gesture` and its statics (the double-click and double-⌘ windows near line 49), the throttled capture trigger that calls `capture::take` (near line 83 to 105), `spawn_input_taps` (line 108 to about 315), `synth_copy`, `read_clipboard`, `grab_and_send_selection`, and every `core_graphics` / `core_foundation` import. Keep `dot_icon`, `set_tray_recording` (or whatever swaps the tray icon at line 339), `toggle_window`, `set_switcher_visible`, `activate_window`, `spawn_frontmost_watch`, the global shortcut plugin and its handler, the `setup` tray and menu, the `Focused` window event, `activity::spawn_server`, the orphan reapers, and the activation policy calls.
2. In `setup`, the `skip_shared_globals` branch no longer mentions a summon gesture; the eprintln says the tray is skipped. Remove the `enabled` and `tap_active` locals that fed the tap.
3. `services.rs`: delete the `tap_active` field if nothing reads it after step 1; keep `capture_enabled` (the front toggles it through `activity::capture_enabled`) and `window_focused`.
4. `capture.rs`: delete `take` and the helpers only it used. `capture_permissions_impl` keeps its result shape; `tap_expected` and `tap_active` become constant `false` with a one-line comment that the tap is gone. Keep `capture_request_screen` and `frontmost_app`.
5. `Cargo.toml`: drop `core-graphics`, `core-foundation`, and `libc` when `cargo build` proves no remaining user; drop the `native-e2e` feature and `tauri-plugin-wdio-webdriver`; delete the `#[cfg(all(debug_assertions, feature = "native-e2e"))]` plugin line in `lib.rs`.
6. Delete `wdio.native.conf.ts` and `e2e-native/`; drop the `@wdio/*` devDependencies and the two scripts; run `corepack pnpm@10.12.4 install`.
7. Validate:
```
CARGO_TARGET_DIR=/Users/chrishafley/.cache/cargo-target/tauri-shell cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -1
CARGO_TARGET_DIR=/Users/chrishafley/.cache/cargo-target/tauri-shell cargo build --manifest-path src-tauri/Cargo.toml --bin instant-serve 2>&1 | tail -1
CARGO_TARGET_DIR=/Users/chrishafley/.cache/cargo-target/tauri-shell cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep "test result"
node scripts/generate-native.mjs --check && node scripts/generate-api.mjs --check && echo commands-unchanged
npx tsc --noEmit && echo tsc-ok
grep -c "CGEventTap\|spawn_input_taps\|grab_and_send_selection" src-tauri/src/lib.rs
```
The last line must print 0. Clippy warnings that predate you in `fs.rs`, `kitty.rs` stay; mention them in the commit body if they appear.

## Style laws (comments, commit message)
No em dashes. No sycophancy. No negative parallelism (`not X, Y`). No one-word sentences. Banned words: provenance, substrate, load-bearing, regime, grounded, ruling, honest, distill. No deictic filler (`here is`, `below`, `the following`).

## Commit subject (exact)
`tauri: the shell keeps tray, summon shortcut and window; the CGEventTap, gesture capture and the wdio native tier are gone`

## Receipt (paste the real output of step 7 into the commit body)
