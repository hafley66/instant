import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "0_render.spec.ts",
  use: { baseURL: "http://localhost:5201", viewport: { width: 1280, height: 800 } },
  webServer: { command: "pnpm vite --port 5201 --strictPort", url: "http://localhost:5201", reuseExistingServer: true, timeout: 60000 },
});
