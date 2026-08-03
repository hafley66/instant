import { defineConfig, devices } from "@playwright/test";

// Own port and own dev server: sibling lab worktrees run the root config's 4173
// with reuseExistingServer, which would serve their tree's sources into this
// lane's screenshots.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/mail-preview.spec.ts",
  use: {
    baseURL: "http://127.0.0.1:4183",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "corepack pnpm@10.12.4 run dev --host 127.0.0.1 --port 4183",
    url: "http://127.0.0.1:4183/e2e-mail-preview.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
