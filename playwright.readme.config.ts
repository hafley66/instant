import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// README capture tier: Chromium drives the built bundle served by instant-serve,
// the same Rust backend the app ships, and writes the PNGs under
// docs/screenshots. Everything is scratch so a capture run never touches the
// owner's store, default tmux socket, or desktop.
//
// Isolation:
//   BOOP_DB / BOOP_MAIL_DIR  scratch sqlite store + mailbox
//   BOOP_NO_SYNC             no startup transcript sync
//   TMUX_TMPDIR              private socket dir; `tmux`/boop with no -L resolve
//                            to $TMUX_TMPDIR/tmux-<uid>/default, never the
//                            owner's /tmp/tmux-<uid>/default. TMUX is cleared so
//                            the runner's own tmux session cannot leak in.
//   INSTANT_TMUX_SOCKET      unset: the app and boop share the private default
//                            socket, which is how boop resolves the pane.
//   INSTANT_NO_GLOBALS       no tray, global shortcut, or summon gesture.
//
// The serve binary defaults repo-relative; point INSTANT_README_SERVE at a warm
// CARGO_TARGET_DIR build to reuse a cached binary. No machine-local path is
// committed.
const port = Number(process.env.INSTANT_README_PORT ?? 47813);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const serve =
  process.env.INSTANT_README_SERVE ?? path.join(root, "src-tauri/target/debug/instant-serve");
const scratchRoot = process.env.INSTANT_README_TMP ?? `/private/tmp/instant-readme-${port}`;
const dataDir = path.join(scratchRoot, "serve");
const boopDir = path.join(scratchRoot, "boop");
const tmuxDir = path.join(scratchRoot, "tmux");
const boopDb = path.join(boopDir, "boop.db");
// The app shells out to `boop` through PATH (run_click), so the binary the spec
// seeds with and the one the server runs must match, hence BOOP_BIN names both.
const boopBin = process.env.BOOP_BIN ?? path.join(process.env.HOME ?? "", ".cargo/bin/boop");
const boopBinDir = path.dirname(boopBin);

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(boopDir, { recursive: true });
fs.mkdirSync(tmuxDir, { recursive: true });

export default defineConfig({
  testDir: "./e2e-real",
  testMatch: "**/readme-screenshots.spec.ts",
  workers: 1,
  timeout: 120_000,
  outputDir: "test-results/readme",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 960 },
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: {
      args: ["--renderer-process-limit=1", "--disable-gpu", "--in-process-gpu", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=384"],
    },
  },
  webServer: {
    // `env -u TMUX`: the runner may itself be inside tmux; an inherited TMUX
    // would point every tmux call (app and boop) at the owner's server.
    command: `env -u TMUX TMUX_TMPDIR=${tmuxDir} PATH=${boopBinDir}:$PATH INSTANT_NO_GLOBALS=1 INSTANT_TMUX_SOCKET= BOOP_DB=${boopDb} BOOP_MAIL_DIR=${boopDir} BOOP_NO_SYNC=1 ${serve} --port ${port} --data-dir ${dataDir} --dist ${path.join(root, "dist")}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !!process.env.INSTANT_README_REUSE,
    timeout: 30_000,
  },
  metadata: { scratchRoot, boopDb, boopDir, tmuxDir, root },
});
