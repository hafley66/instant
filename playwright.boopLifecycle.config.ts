import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Boop lifecycle tier: Chromium against the built bundle served by
// instant-serve with a scratch Boop sqlite store, so the panel's initial mount,
// refocus, close/reopen, and hidden-update paths are exercised end to end.
// Isolated from the owner: private BOOP_DB/BOOP_MAIL_DIR, private app data dir,
// private TMUX_TMPDIR, TMUX cleared, INSTANT_NO_GLOBALS=1.
const port = Number(process.env.INSTANT_BOOP_LIFE_PORT ?? 47807);
const serve =
  process.env.INSTANT_BOOP_LIFE_SERVE ??
  "/Users/chrishafley/projects/boop-selection-work/cargo-target/debug/instant-serve";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const scratchRoot = process.env.INSTANT_BOOP_LIFE_TMP ?? `/tmp/instant-boop-life-${port}`;
const dataDir = path.join(scratchRoot, "serve");
const boopDir = path.join(scratchRoot, "boop");
const tmuxDir = path.join(scratchRoot, "tmux");
const boopDb = path.join(boopDir, "boop.db");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(boopDir, { recursive: true });
fs.mkdirSync(tmuxDir, { recursive: true });

export default defineConfig({
  testDir: "./e2e-real",
  testMatch: "**/boop-lifecycle.spec.ts",
  workers: 1,
  timeout: 120_000,
  outputDir: "test-results/boop-lifecycle",
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
    command: `env -u TMUX TMUX_TMPDIR=${tmuxDir} INSTANT_NO_GLOBALS=1 INSTANT_TMUX_SOCKET= BOOP_DB=${boopDb} BOOP_MAIL_DIR=${boopDir} BOOP_NO_SYNC=1 ${serve} --port ${port} --data-dir ${dataDir} --dist ${path.join(root, "dist")}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !!process.env.INSTANT_BOOP_LIFE_REUSE,
    timeout: 30_000,
  },
  metadata: { scratchRoot, boopDb, boopDir, tmuxDir, root },
});
