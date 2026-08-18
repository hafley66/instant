import { expect, test } from "@playwright/test";

test("bounds and virtualizes the Boop network waterfall through its panel scroll owner", async ({ page }) => {
  await page.goto("/e2e-boop-network.html?e2e=1");

  await expect.poll(() => page.evaluate(() => (window as Window & { __boopNetworkCalls?: number }).__boopNetworkCalls)).toBe(1);
  await expect(page.getByText("2000 events · past 7 days · cap 2000")).toBeVisible();
  const grid = page.getByTestId("grid");
  await expect(grid).toHaveAttribute("data-scroll-mode", "external");
  await expect(grid).toHaveAttribute("data-scroll-owner", "ancestor");

  const mountedAtStart = await page.getByTestId("grid-row").count();
  expect(mountedAtStart).toBeLessThan(50);
  await expect(page.getByText("revision-1 event-0000")).toBeVisible();

  const owner = page.getByTestId("boop-network-scroll-owner");
  await owner.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByText("revision-1 event-1999")).toBeVisible();
  expect(await page.getByTestId("grid-row").count()).toBeLessThan(50);

  await page.getByRole("button", { name: "refresh" }).click();
  await expect(page.getByText("revision-2 event-1999")).toBeVisible();

  const scrollableGridDescendants = await grid.locator("*").evaluateAll((elements) => elements.filter((element) => {
    const node = element as HTMLElement;
    const style = getComputedStyle(node);
    return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
  }).length);
  expect(scrollableGridDescendants).toBe(0);
});
