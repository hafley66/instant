import { expect, test } from "@playwright/test";

test("JSON-Rx dashboard renders captured metric data", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
    w.__instantE2eNativeResults = {
      activity_rule_matches: [
        {
          ruleId: "fixture-usage",
          url: "http://127.0.0.1:4173/fixture.html",
          ts: 1893562985000,
          matches: [{ percent: 37, resets_at: "2030-01-02T03:04:05Z" }],
          stream: "fixture.usage",
          schema: {
            type: "object",
            properties: {
              percent: { type: "number", title: "Usage percent", minimum: 0, maximum: 100 },
              resets_at: { type: "string", title: "Reset time", format: "date-time" },
            },
          },
        },
        {
          ruleId: "fixture-usage",
          url: "http://127.0.0.1:4173/fixture.html",
          ts: 1893563045000,
          matches: [{ percent: 42, resets_at: "2030-01-02T03:04:05Z" }],
          stream: "fixture.usage",
          schema: {
            type: "object",
            properties: {
              percent: { type: "number", title: "Usage percent", minimum: 0, maximum: 100 },
              resets_at: { type: "string", title: "Reset time", format: "date-time" },
            },
          },
        },
      ],
    };
  });
  await page.goto("/e2e-paint.html?e2e=1");

  await page.locator("#rules-toggle .actbar-exp").click();
  await page.locator("#rules-metrics-child").click();
  const dashboard = page.getByTestId("metrics-dashboard");
  await expect(dashboard).toHaveAttribute("data-state", "ready");
  await expect(dashboard).toContainText("Usage percent");
  await expect(dashboard).toContainText("42%");
  await expect(dashboard).toContainText("fixture-usage");
  await expect(dashboard).toHaveScreenshot("metrics-dashboard.png", { animations: "disabled" });
});
