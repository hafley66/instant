import { expect, test } from "@playwright/test";

async function measuredFps(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve) => {
    let frames = 0;
    const started = performance.now();
    const frame = (now: number) => {
      frames += 1;
      if (now - started >= 1_000) resolve(frames * 1_000 / (now - started));
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
}

test("renders Boop messages as a stable Marbler agent waterfall", async ({ page }, testInfo) => {
  await page.goto("/e2e-boop-network.html?e2e=1");

  const calls = () => page.evaluate(() => (window as Window & { __boopNetworkCalls?: number }).__boopNetworkCalls ?? 0);
  await expect.poll(calls).toBe(1);
  const firstQuery = await page.evaluate(() => (
    window as Window & { __boopNetworkQueries?: Array<{ sinceMs: number; limit: number }> }
  ).__boopNetworkQueries?.[0]);
  expect(firstQuery).toMatchObject({ limit: 2_000 });
  expect(Date.now() - (firstQuery?.sinceMs ?? 0)).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1_000);
  expect(Date.now() - (firstQuery?.sinceMs ?? 0)).toBeLessThan(7 * 24 * 60 * 60 * 1_000 + 30_000);

  await expect(page.getByText("2000 events · past 7 days · cap 2000")).toBeVisible();
  const marbler = page.getByTestId("boop-network-marbler");
  await expect(marbler.getByTestId("marbler")).toBeVisible();
  await expect(marbler.getByTestId("time-navigator")).toBeVisible();
  expect(Number(await marbler.locator(".time-navigator").getAttribute("data-mark-count"))).toBeGreaterThan(2_000);
  await expect(marbler.getByTestId("waterfall-pixi")).toBeVisible();
  await expect(marbler.getByText("2 events", { exact: true })).toBeVisible();
  const codexLane = marbler.locator(".grid-body b").filter({ hasText: /^codex-luna-a$/ });
  await expect(codexLane).toBeVisible();
  await expect(marbler.locator(".grid-body b").filter({ hasText: /^claude-haiku-b$/ })).toBeVisible();
  await expect(marbler.locator(".legend")).toContainText("send wait receive work");

  const waterfallSize = await marbler.getByTestId("waterfall-pixi").evaluate((canvas) => ({
    width: (canvas as HTMLCanvasElement).width,
    height: (canvas as HTMLCanvasElement).height,
  }));
  expect(waterfallSize.width).toBeGreaterThan(100);
  expect(waterfallSize.height).toBeGreaterThan(40);
  const fps = [await measuredFps(page), await measuredFps(page)];
  expect(Math.min(...fps)).toBeGreaterThan(30);
  await expect.poll(calls, { timeout: 1_500 }).toBe(1);

  await codexLane.click();
  await expect(marbler.getByTestId("event-details")).toBeVisible();
  await expect(marbler.getByTestId("messages-table").locator("tbody tr")).toHaveCount(1_000);
  await expect(marbler.getByTestId("messages-table")).toContainText("revision-1 event-0000");
  await expect(marbler.getByTestId("messages-table")).toContainText("claude-haiku-b");

  const startScreenshot = testInfo.outputPath("boop-marbler-waterfall.png");
  await page.screenshot({ path: startScreenshot, fullPage: true });
  await testInfo.attach("boop-marbler-waterfall", { path: startScreenshot, contentType: "image/png" });

  await page.getByRole("button", { name: "refresh" }).click();
  await expect.poll(calls).toBe(2);
  await marbler.locator(".grid-body b").filter({ hasText: /^codex-luna-a$/ }).click();
  await expect(marbler.getByTestId("messages-table")).toContainText("revision-2 event-0000");
  await expect(marbler.getByTestId("messages-table")).not.toContainText("revision-1 event-0000");
  await expect.poll(calls, { timeout: 1_500 }).toBe(2);

  await testInfo.attach("boop-marbler-stability", {
    body: JSON.stringify({ fps, initialApiCalls: 1, refreshedApiCalls: 2, laneCount: 2, inputEventCount: 2_000 }, null, 2),
    contentType: "application/json",
  });
});
