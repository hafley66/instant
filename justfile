# instant — task runner. `just` lists recipes; `just dev` runs the full app.
# The Tauri shell (Rust backend) is what you want for real runs — it spawns the
# vite frontend itself (tauri.conf beforeDevCommand = "npm run dev"). Running
# vite alone (`just web`) gives the UI in a browser but no Rust commands
# (tmux/pty/worktrees/harness all no-op).

set shell := ["bash", "-uc"]

# list recipes
default:
    @just --list

# full app: Rust backend + webview (this is the normal dev loop)
dev:
    npm run tauri dev

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

# compile-check the Rust backend
cargo-check:
    cargo check --manifest-path src-tauri/Cargo.toml

# run the Rust backend tests
cargo-test:
    cargo test --manifest-path src-tauri/Cargo.toml

# full preflight before a commit: tsc + vite build + cargo check
verify: check build cargo-check
