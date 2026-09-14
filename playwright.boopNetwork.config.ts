import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Boop network tier: Chromium against the built bundle served by instant-serve
// with a scratch, real-schema Boop sqlite store. It seeds a large synthetic
// lane/event history so the panel's marbler (the "network") must render while
// the graph read stays bounded. Isolated from the owner: private
// BOOP_DB/BOOP_MAIL_DIR, private app data dir, private TMUX_TMPDIR, TMUX
// cleared, INSTANT_NO_GLOBALS=1.
const port = Number(process.env.INSTANT_BOOP_NET_PORT ?? 47815);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const serve =
  process.env.INSTANT_BOOP_NET_SERVE ??
  process.env.INSTANT_BOOP_LIFE_SERVE ??
  path.join(root, "src-tauri/target/debug/instant-serve");
const scratchRoot = process.env.INSTANT_BOOP_LIFE_TMP ?? `/tmp/instant-boop-net-${port}`;
const dataDir = path.join(scratchRoot, "serve");
const boopDir = path.join(scratchRoot, "boop");
const tmuxDir = path.join(scratchRoot, "tmux");
const boopDb = path.join(boopDir, "boop.db");

// The seed helper computes its paths from the same two variables the launcher
// gets, so the worker and the server can never disagree about the store.
process.env.INSTANT_BOOP_LIFE_PORT = String(port);
process.env.INSTANT_BOOP_LIFE_TMP = scratchRoot;

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(boopDir, { recursive: true });
fs.mkdirSync(tmuxDir, { recursive: true });

export default defineConfig({
  testDir: "./e2e-real",
  testMatch: "**/boop-network.spec.ts",
  workers: 1,
  timeout: 180_000,
  outputDir: "test-results/boop-network",
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
    reuseExistingServer: !!process.env.INSTANT_BOOP_NET_REUSE,
    timeout: 30_000,
  },
  metadata: { scratchRoot, boopDb, boopDir, tmuxDir, root },
});
