import { expect, test } from "@playwright/test";

test("Dockview hosts a culled React Flow canvas with live panel state", async ({ page }, testInfo) => {
  await page.goto("/e2e-dock-canvas-lab.html");
  await expect(page.locator(".dv-tab")).toHaveCount(7);
  await expect(page.getByTestId("canvas-panel")).toBeVisible();
  await expect(page.getByTestId("metrics-panel")).toBeVisible();

  const input = page.getByLabel("Live panel 1 input");
  await input.fill("survives canvas interaction");
  await page.getByTestId("canvas-panel").hover();
  await page.mouse.wheel(0, -400);
  await page.mouse.wheel(0, 400);
  await expect(input).toHaveValue("survives canvas interaction");
  await expect.poll(() => page.evaluate(() => window.__dockCanvasLab.values["panel-0"].$())).toBe("survives canvas interaction");

  await expect(page.locator(".lab-workspace .dv-tab")).toHaveCount(4);
  await page.locator(".lab-workspace .dv-tab").filter({ hasText: "xterm" }).click();
  await expect(page.getByTestId("terminal-panel")).toBeVisible();

  const initial = await page.evaluate(() => window.__dockCanvasLab.$());
  expect({
    requestedNodes: initial.metrics.requestedNodes,
    dockPanels: initial.metrics.dockPanels,
    panels: Object.keys(initial.panels),
  }).toEqual({
    requestedNodes: 100,
    dockPanels: 3,
    panels: ["terminal", "files", "turns", "subagents"],
  });
  expect(await page.getByTestId("live-panel").count()).toBeLessThan(initial.metrics.requestedNodes);

  await page.getByRole("button", { name: "500 nodes" }).click();
  await expect.poll(() => page.evaluate(() => window.__dockCanvasLab.metrics.requestedNodes.$())).toBe(500);
  const stressed = await page.evaluate(() => window.__dockCanvasLab.$());
  expect(await page.getByTestId("live-panel").count()).toBeLessThan(stressed.metrics.requestedNodes);
  expect(stressed.metrics.layoutMs).toBeLessThan(50);
  expect(stressed.metrics.eventCount).toBeLessThan(100);

  await testInfo.attach("dockview-reactflow-metrics", {
    body: Buffer.from(JSON.stringify({ initial, stressed }, null, 2)),
    contentType: "application/json",
  });
  await page.screenshot({ path: "test-results/dockview-reactflow-lab.png", fullPage: true });
});
