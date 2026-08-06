import { expect, test } from "@playwright/test";

test("binary files render as an old/new image pair", async ({ page }) => {
  await page.goto("/packages/patchset-diff/demo.html");
  const selects = page.locator(".patchset-range-bar select");
  // Patch sets 4 -> 5 modify both screenshots, so both sides exist.
  await expect(selects.nth(1).locator("option").nth(4)).toBeAttached();
  await selects.nth(0).selectOption("4");
  await selects.nth(1).selectOption("5");

  const shots = page.locator(".patchset-diff-file", { has: page.locator(".patchset-diff-images") });
  await expect(shots.first().locator("img").first()).toBeVisible();

  // ImageMagick's pixel difference is the third mode.
  const bar = page.locator(".patchset-diff-imagebar").first();
  await expect(bar.locator("button", { hasText: "difference" })).toBeVisible();
  await expect(bar.locator(".patchset-diff-changed")).toContainText("px changed");
  await bar.locator("button", { hasText: "difference" }).click();
  await expect(page.locator("figure.delta img").first()).toBeVisible();

  // Collapse the text files so the pair is what the receipt shows.
  const textHeaders = page.locator(".patchset-diff-file", { hasNot: page.locator(".patchset-diff-images") }).locator(".patchset-diff-head");
  const count = await textHeaders.count();
  for (let i = 0; i < count; i += 1) await textHeaders.nth(i).click();

  // The pane fits the image rather than growing to its natural height.
  const figure = shots.first().locator("figure").last();
  const fit = await figure.evaluate((node) => {
    const img = node.querySelector("img") as HTMLImageElement;
    return { pane: node.getBoundingClientRect().height, drawn: img.getBoundingClientRect().height, natural: img.naturalHeight };
  });
  // The pane caps at --pd-image-max (22rem = 352px) plus padding, and the
  // drawn image never overflows it, whatever the natural size.
  expect(fit.drawn).toBeLessThanOrEqual(fit.pane + 1);
  expect(fit.pane).toBeLessThanOrEqual(354);

  const box = await page.locator("#app").boundingBox();
  await page.setViewportSize({ width: 1280, height: Math.ceil((box?.height ?? 800) + 32) });
  await expect(page).toHaveScreenshot("images.png", { fullPage: true });
});
