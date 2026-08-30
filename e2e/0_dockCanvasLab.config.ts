import { defineConfig, devices } from "@playwright/test";

const PORT = 4237;

export default defineConfig({
  testDir: ".",
  testMatch: "0_dockCanvasLab.spec.ts",
  reporter: [["html", { open: "never", outputFolder: "../playwright-report-dock-canvas" }], ["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `corepack pnpm@10.12.4 run dev --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/e2e-dock-canvas-lab.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
