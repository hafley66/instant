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
  const chart = page.getByTestId("metrics-chart");
  await expect(chart).toHaveAttribute("data-render-state", "ready");
  const renderedChart = await chart.evaluate((host) => {
    const view = host.querySelector("canvas, svg");
    return {
      host: host.getBoundingClientRect().toJSON(),
      view: view?.getBoundingClientRect().toJSON(),
    };
  });
  expect(renderedChart.host.width).toBeGreaterThan(900);
  expect(renderedChart.view?.width).toBeGreaterThan(700);
  expect(renderedChart.view?.height).toBeGreaterThan(200);
  await expect(dashboard).toHaveScreenshot("metrics-dashboard.png", { animations: "disabled" });

  const handle = dashboard.locator(".meme-sash-horizontal");
  const chartPanel = dashboard.locator('[data-panel-id="metrics-chart-panel"]');
  const historyPanel = dashboard.locator('[data-panel-id="metrics-history-panel"]');
  const chartBefore = await chartPanel.boundingBox();
  const historyBefore = await historyPanel.boundingBox();
  const handleBox = await handle.boundingBox();
  expect(chartBefore).not.toBeNull();
  expect(historyBefore).not.toBeNull();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y - 80);
  await page.mouse.up();
  const chartAfter = await chartPanel.boundingBox();
  const historyAfter = await historyPanel.boundingBox();
  expect(chartAfter!.height).toBeLessThan(chartBefore!.height - 40);
  expect(historyAfter!.height).toBeGreaterThan(historyBefore!.height + 40);
});
