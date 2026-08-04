import { defineConfig, devices } from "@playwright/test";

// Live suite: real tmux (private -L socket) + the real bus CLI. Own dir and
// suffix keep its process spawns and wall-clock polls out of the default battery.
export default defineConfig({
  testDir: "./e2e-live",
  testMatch: "**/*.live.ts",
  workers: 1,
  timeout: 90_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "corepack pnpm@10.12.4 run dev --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/e2e-paint.html",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
