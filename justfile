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
    npx tsc --noEmit

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
