import { defineConfig, devices } from "@playwright/test";

// Own port and own dev server, like the strip gate: sibling lab worktrees hold
// 4173 (root), 4183 (busmail), and 4197 (stripsub) — this lane gets its own so
// another tree's vite instance never serves our sources.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/waterfall.spec.ts",
  use: {
    baseURL: "http://127.0.0.1:4198",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "corepack pnpm@10.12.4 run dev --host 127.0.0.1 --port 4198",
    url: "http://127.0.0.1:4198/e2e-waterfall.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
