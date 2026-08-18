import { expect, test } from "@playwright/test";

test("bounds and virtualizes the Boop network waterfall through its panel scroll owner", async ({ page }, testInfo) => {
  await page.goto("/e2e-boop-network.html?e2e=1");

  await expect.poll(() => page.evaluate(() => (window as Window & { __boopNetworkCalls?: number }).__boopNetworkCalls)).toBe(1);
  const firstQuery = await page.evaluate(() => (
    window as Window & { __boopNetworkQueries?: Array<{ sinceMs: number; limit: number }> }
  ).__boopNetworkQueries?.[0]);
  expect(firstQuery).toMatchObject({ limit: 2_000 });
  expect(Date.now() - (firstQuery?.sinceMs ?? 0)).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1_000);
  expect(Date.now() - (firstQuery?.sinceMs ?? 0)).toBeLessThan(7 * 24 * 60 * 60 * 1_000 + 30_000);

  await expect(page.getByText("2000 events · past 7 days · cap 2000")).toBeVisible();
  const graph = page.getByTestId("boop-network-graph");
  await expect(graph).toHaveAttribute("data-node-count", "2000");
  await expect(graph).toHaveAttribute("data-edge-count", "1998");
  const graphtCanvas = page.getByTestId("boop-network-grapht");
  await expect(graphtCanvas).toBeVisible();
  await expect(graphtCanvas).toHaveCount(1);
  expect(await graphtCanvas.evaluate((canvas) => ({
    width: (canvas as HTMLCanvasElement).width,
    height: (canvas as HTMLCanvasElement).height,
  }))).toMatchObject({ width: 1280, height: 180 });
  await expect(page.getByRole("columnheader")).toHaveText([
    "Time", "Event", "Lane", "From", "To", "Session", "State", "Duration", "Detail",
  ]);
  const grid = page.getByTestId("grid");
  await expect(grid).toHaveAttribute("data-scroll-mode", "external");
  await expect(grid).toHaveAttribute("data-scroll-owner", "ancestor");

  const mountedAtStart = await page.getByTestId("grid-row").count();
  expect(mountedAtStart).toBeGreaterThan(5);
  expect(mountedAtStart).toBeLessThan(50);
  await expect(page.getByText("delivery", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("codex-luna-a", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("coordinator", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("worker-0", { exact: true })).toBeVisible();
  await expect(page.getByText("session-0", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("started", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("revision-1 event-0000")).toBeVisible();
  const startScreenshot = testInfo.outputPath("boop-network-start.png");
  await page.screenshot({ path: startScreenshot, fullPage: true });
  await testInfo.attach("boop-network-start", { path: startScreenshot, contentType: "image/png" });

  const owner = page.getByTestId("boop-network-scroll-owner");
  const dimensions = await owner.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight * 20);
  await owner.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByText("revision-1 event-1999")).toBeVisible();
  const mountedAtEnd = await page.getByTestId("grid-row").count();
  expect(mountedAtEnd).toBeGreaterThan(5);
  expect(mountedAtEnd).toBeLessThan(50);

  await page.getByRole("button", { name: "refresh" }).click();
  await expect(page.getByText("revision-2 event-1999")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as Window & { __boopNetworkCalls?: number }).__boopNetworkCalls)).toBe(2);
  await expect(page.getByText("revision-1 event-1999")).toHaveCount(0);
  const endScreenshot = testInfo.outputPath("boop-network-end-after-refresh.png");
  await page.screenshot({ path: endScreenshot, fullPage: true });
  await testInfo.attach("boop-network-end-after-refresh", { path: endScreenshot, contentType: "image/png" });

  const scrollableGridDescendants = await grid.locator("*").evaluateAll((elements) => elements.filter((element) => {
    const node = element as HTMLElement;
    const style = getComputedStyle(node);
    return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
  }).length);
  expect(scrollableGridDescendants).toBe(0);
});
