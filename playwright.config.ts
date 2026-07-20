import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
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
