# instant — task runner. `just` lists recipes; `just dev` runs the full app.
# The Tauri shell (Rust backend) is what you want for real runs — it spawns the
# vite frontend itself (tauri.conf beforeDevCommand = "npm run dev"). Running
# vite alone (`just web`) gives the UI in a browser but no Rust commands
# (tmux/pty/worktrees/harness all no-op).

set shell := ["bash", "-uc"]

# list recipes
default:
    @just --list

# full app: Rust backend + webview (this is the normal dev loop). The linker
# shim signs the dev binary with the stable "Instant Dev" identity (run
# `just signing-setup` once) so its macOS TCC grants survive rebuilds. Without
# the cert the shim is a harmless no-op (binary stays ad-hoc, as before).
dev:
    CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="{{justfile_directory()}}/scripts/sign-link.sh" npm run tauri dev

# same as `dev`, but with INSTANT_NO_GLOBALS=1: skips the tray icon, the global
# Cmd+Alt+Space shortcut, and the double-click/double-cmd summon gesture, so
# this instance doesn't fight the owner's always-running one. Use this for
# agent/verification runs.
dev-safe:
    INSTANT_NO_GLOBALS=1 CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="{{justfile_directory()}}/scripts/sign-link.sh" npm run tauri dev

# isolated second instance: separate Vite port + summon shortcut, with no second
# tray icon or process-wide summon gesture. Use Cmd+Shift+Space to summon it.
dev-isolated:
    INSTANT_ISOLATED=1 CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="{{justfile_directory()}}/scripts/sign-link.sh" npm run tauri dev -- --config '{"build":{"beforeDevCommand":"npm run dev -- --port 1422","devUrl":"http://localhost:1422"}}'

# one-time: install the Tauri CLI machine-global (~/.cargo/bin, on PATH across
# all checkouts and nvm node versions) so any repo can run `cargo tauri …` /
# `tauri …` without the per-checkout node_modules devDep.
install-cli:
    cargo install tauri-cli --version "^2" --locked

# one-time: create the self-signed "Instant Dev" code-signing identity used by
# the dev linker shim. Prompts for your login-keychain password (and the first
# build will ask to allow codesign to use the key — click "Always Allow").
signing-setup:
    ./scripts/setup-signing.sh

# one-time: local push-to-talk dictation (Handy, https://handy.computer — open
# source, fully on-device, no audio leaves the machine). Alternative to Claude
# Code's /voice, which streams audio to Anthropic. After install: grant Handy
# Microphone + Accessibility when prompted, pick the Parakeet V3 model in its
# settings (~2 GB, best on Apple Silicon), set a push-to-talk shortcut that
# doesn't collide with instant/tmux/claude keys, then hold-to-dictate into any
# focused input — including claude tabs here.
voice-setup:
    brew list --cask handy >/dev/null 2>&1 || brew install --cask handy
    open -a Handy

# frontend only in a browser (no backend; invoke() calls fail)
web:
    npm run dev

# typecheck + production frontend build
build:
    npm run build

# release bundle (.app/.dmg) via Tauri
bundle:
    npm run tauri build

# typecheck only
check:
    npm run api:check
    npx tsc --noEmit

# build the Chrome extension (extension/src/*.ts -> extension/dist/*.js). Load
# extension/ unpacked in chrome://extensions after this. `ext-watch` rebuilds
# on save while iterating.
ext-build:
    npm run ext:build

ext-watch:
    npm run ext:watch

# typecheck the extension (its own tsconfig + @types/chrome)
ext-check:
    npm run ext:check

# run the frontend (vitest) unit tests
test:
    npx vitest run

# compile-check the Rust backend
cargo-check:
    cargo check --manifest-path src-tauri/Cargo.toml

# run the Rust backend tests
cargo-test:
    cargo test --manifest-path src-tauri/Cargo.toml

# security audit of the Rust deps against the RustSec advisory DB. The ignore
# list (src-tauri/.cargo/audit.toml) covers only the Linux-webview + build-time
# advisories that don't reach the macOS binary; a real finding still fails this.
audit:
    cd src-tauri && cargo audit

# full preflight before a commit: tsc + vite build + cargo check + tests
verify: check build cargo-check test

# build the VS Code extension (npm install + tsc -> vscode-ext/out)
vscode-build:
    cd vscode-ext && npm install && npx tsc -p ./

# package + install the VS Code extension for local dev use. Packaging with
# vsce works without a publisher account (the marketplace id in package.json
# is a placeholder, only needed to actually publish). If `code`/`vsce` aren't
# on PATH, symlink vscode-ext/ into ~/.vscode/extensions instead — see
# vscode-ext/README.md.
vscode-install: vscode-build
    cd vscode-ext && npx @vscode/vsce package --allow-missing-repository -o instant-activity.vsix
    code --install-extension vscode-ext/instant-activity.vsix
