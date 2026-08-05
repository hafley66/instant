import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "3_receipt.spec.ts",
  outputDir: "../../test-results/patchset-ledger",
  reporter: [["list"], ["html", { outputFolder: "../../playwright-report/patchset-ledger", open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
});
