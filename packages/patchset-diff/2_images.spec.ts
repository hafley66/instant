import { expect, test } from "@playwright/test";

test("binary files render as an old/new image pair", async ({ page }) => {
  await page.goto("/packages/patchset-diff/demo.html");
  const selects = page.locator(".patchset-range-bar select");
  await expect(selects.nth(1).locator("option").nth(3)).toBeAttached();
  await selects.nth(0).selectOption("3");
  await selects.nth(1).selectOption("4");

  const shots = page.locator(".patchset-diff-file", { has: page.locator(".patchset-diff-images") });
  await expect(shots.first().locator("img").first()).toBeVisible();

  // Collapse the text files so the pair is what the receipt shows.
  const textHeaders = page.locator(".patchset-diff-file", { hasNot: page.locator(".patchset-diff-images") }).locator(".patchset-diff-head");
  const count = await textHeaders.count();
  for (let i = 0; i < count; i += 1) await textHeaders.nth(i).click();

  const box = await page.locator("#app").boundingBox();
  await page.setViewportSize({ width: 1280, height: Math.ceil((box?.height ?? 800) + 32) });
  await expect(page).toHaveScreenshot("images.png", { fullPage: true });
});
