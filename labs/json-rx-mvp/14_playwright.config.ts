import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "13_receipt.spec.ts",
  outputDir: "../../test-results/json-rx-lab",
  reporter: [["list"], ["html", { outputFolder: "../../playwright-report/json-rx-lab", open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
});
