import { defineConfig, devices } from "@playwright/test";

// Real tier: Chromium drives the built bundle served by instant-serve, the same
// Rust backend the app ships, over its JSON-RPC WebSocket. No Tauri process,
// no fixture table. Build first: `vite build` and `cargo build --bin instant-serve`.
const port = Number(process.env.INSTANT_REAL_PORT ?? 47790);
const socket = process.env.INSTANT_REAL_SOCKET ?? "instant-real-e2e";
const serve = process.env.INSTANT_SERVE_BIN ?? "src-tauri/target/debug/instant-serve";
const dataDir = process.env.INSTANT_SERVE_DATA ?? `/tmp/${socket}`;

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
  },
  webServer: {
    command: `${serve} --port ${port} --data-dir ${dataDir} --dist dist`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !!process.env.INSTANT_SERVE_REUSE,
    timeout: 30_000,
    env: { INSTANT_TMUX_SOCKET: socket, INSTANT_NO_GLOBALS: "1" },
  },
});
