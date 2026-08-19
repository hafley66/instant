import { defineConfig, devices } from "@playwright/test";

// Own port and own dev server: sibling lab worktrees hold 4173 (root config,
// reuseExistingServer) and 4183 (busmail), and either would serve another
// tree's sources into this lane's receipts.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/dock-strip-in-tab.spec.ts",
  use: {
    baseURL: "http://127.0.0.1:4197",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1920, height: 1080 },
  },
  webServer: {
    command: "corepack pnpm@10.12.4 run dev --host 127.0.0.1 --port 4197",
    url: "http://127.0.0.1:4197/e2e-dock-strip-in-tab.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
