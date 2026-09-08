import { defineConfig, devices } from "@playwright/test";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Real tier: Chromium drives the built bundle served by instant-serve, the same
// Rust backend the app ships, over its JSON-RPC WebSocket. No Tauri process,
// no fixture table. Build first: `vite build` and `cargo build --bin instant-serve`.
const port = Number(process.env.INSTANT_REAL_PORT ?? 47790);
const socket = process.env.INSTANT_REAL_SOCKET ?? "instant-real-e2e";
const serve = process.env.INSTANT_SERVE_BIN ?? "src-tauri/target/debug/instant-serve";
const dataDir = process.env.INSTANT_SERVE_DATA ?? `/tmp/${socket}`;
// boop's fork verb is stubbed for the whole tier: e2e-real/stub-bin/boop answers
// `beep fork` without a lane, a worktree, a tmux session or a model process, and
// logs the call to INSTANT_FORK_STUB_LOG. Everything else reaches the real boop.
const stubBin = process.env.INSTANT_REAL_STUB_PATH ?? path.join(dirname(fileURLToPath(import.meta.url)), "e2e-real", "stub-bin");
const home = process.env.HOME ?? "";

export default defineConfig({
  testDir: "./e2e-real",
  testMatch: "**/*.spec.ts",
  workers: 1,
  timeout: 120_000,
  outputDir: "test-results/real",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1400, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    // One renderer, no GPU process, a capped V8 heap: the box this runs on has
    // 16 GB and a dev app, an editor and a browser already resident.
    launchOptions: {
      args: ["--renderer-process-limit=1", "--disable-gpu", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=512"],
    },
  },
  webServer: {
    command: `${serve} --port ${port} --data-dir ${dataDir} --dist dist`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !!process.env.INSTANT_SERVE_REUSE,
    timeout: 30_000,
    env: {
      INSTANT_TMUX_SOCKET: socket,
      INSTANT_NO_GLOBALS: "1",
      PATH: `${stubBin}:${process.env.PATH ?? ""}`,
      REAL_BOOP: process.env.REAL_BOOP ?? path.join(home, ".cargo/bin/boop"),
      INSTANT_FORK_STUB_LOG: process.env.INSTANT_FORK_STUB_LOG ?? path.join(dataDir, "fork-stub.log"),
    },
  },
});
