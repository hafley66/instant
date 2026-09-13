import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Boop-selection real tier: Chromium against the built bundle served by
// instant-serve, with a scratch Boop store and a scratch tmux server so the
// feature is exercised end to end without touching the owner's ~/.agent store
// or the default tmux socket.
//
// Isolation:
//   BOOP_DB / BOOP_MAIL_DIR  scratch sqlite store + mailbox
//   BOOP_NO_SYNC             no startup transcript sync
//   TMUX_TMPDIR              private socket dir; `tmux` with no -L resolves to
//                            $TMUX_TMPDIR/tmux-<uid>/default, never the owner's
//                            /tmp/tmux-<uid>/default. TMUX is cleared so the
//                            runner's own tmux session cannot leak in.
//   INSTANT_TMUX_SOCKET      unset: the app and boop share the private default
//                            socket, which is how boop resolves the pane.
const port = Number(process.env.INSTANT_BOOP_PORT ?? 47801);
const serve = process.env.INSTANT_BOOP_SERVE ?? "src-tauri/target/debug/instant-serve";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const scratchRoot = process.env.INSTANT_BOOP_TMP ?? `/tmp/instant-boop-sel-${port}`;
const dataDir = path.join(scratchRoot, "serve");
const boopDir = path.join(scratchRoot, "boop");
const tmuxDir = path.join(scratchRoot, "tmux");
const boopDb = path.join(boopDir, "boop.db");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(boopDir, { recursive: true });
fs.mkdirSync(tmuxDir, { recursive: true });

export default defineConfig({
  testDir: "./e2e-real",
  testMatch: "**/boop-selection.spec.ts",
  workers: 1,
  timeout: 120_000,
  outputDir: "test-results/boop",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: {
      args: ["--renderer-process-limit=1", "--disable-gpu", "--in-process-gpu", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=384"],
    },
  },
  webServer: {
    // `env -u TMUX`: the runner may itself be inside tmux; an inherited TMUX
    // would point every tmux call (app and boop) at the owner's server.
    command: `env -u TMUX TMUX_TMPDIR=${tmuxDir} INSTANT_NO_GLOBALS=1 INSTANT_TMUX_SOCKET= BOOP_DB=${boopDb} BOOP_MAIL_DIR=${boopDir} BOOP_NO_SYNC=1 ${serve} --port ${port} --data-dir ${dataDir} --dist dist`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !!process.env.INSTANT_BOOP_REUSE,
    timeout: 30_000,
  },
  metadata: {
    scratchRoot,
    boopDb,
    tmuxDir,
    root,
  },
});
