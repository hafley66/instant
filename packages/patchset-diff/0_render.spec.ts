import { expect, test } from "@playwright/test";

test("renders jj patch sets, syntax-highlighted, with a pure-rebase empty state", async ({ page }) => {
  await page.goto("/packages/patchset-diff/demo.html");
  await page.waitForSelector("body[data-ready='1']");

  const els = page.locator("patchset-diff");
  await expect(els).toHaveCount(3);
  await expect(els.first().locator(".patchset-diff-path")).toHaveText("sum.ts");

  // shiki colours survive the style-to-class remap only if tokens carry a class.
  const coloured = els.first().locator("span[class^='pd-c']");
  await expect(coloured.first()).toBeVisible();
  expect(await coloured.count()).toBeGreaterThan(10);

  await expect(els.nth(1).locator("td", { hasText: "Math.hypot(b.x - a.x, b.y - a.y)" }).first()).toBeVisible();
  await expect(els.nth(2).locator(".patchset-diff-empty")).toHaveText(/No change/);

  await expect(page).toHaveScreenshot("patchset-diff.png", { fullPage: true });
});
