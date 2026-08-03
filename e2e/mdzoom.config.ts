import { defineConfig, devices } from "@playwright/test";

// Private port + no server reuse: the repo default (4173, reuseExistingServer)
// silently binds another worktree's dev server.
const PORT = 4231;

export default defineConfig({
  testDir: ".",
  testMatch: "mdzoom.spec.ts",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `corepack pnpm@10.12.4 run dev --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/e2e-mdzoom.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
