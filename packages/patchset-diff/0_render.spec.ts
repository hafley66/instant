import { expect, test } from "@playwright/test";

test("patch-range selector reads live jj patch sets and diffs between them", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(String(error)));
  await page.goto("/packages/patchset-diff/demo.html?repo=lab");

  const selects = page.locator(".patchset-range-bar select");
  await expect(selects).toHaveCount(2);

  // evolog found three patch sets, so the "to" select lists three options.
  await expect(selects.nth(1).locator("option")).toHaveCount(4);

  // Default range is the last two patch sets.
  await expect(page.locator(".patchset-diff-path, .patchset-diff-empty").first()).toBeVisible();

  // Patch set 1 -> 4 spans a real edit, so the file renders with a diffstat.
  await selects.nth(0).selectOption("1");
  await selects.nth(1).selectOption("4");
  await expect(page.locator(".patchset-diff-path")).toHaveText("sum.ts");
  await expect(page.locator(".patchset-diff-adds")).toBeVisible();

  // shiki colours survive the style-to-class remap. The grammar loads per file,
  // so first paint is plain and colour arrives a tick later.
  await expect
    .poll(() => page.locator("span[class^='pds']").count())
    .toBeGreaterThan(10);

  // Patch set 3 -> 4 was a pure rebase, so the author changed nothing.
  await selects.nth(0).selectOption("3");
  await expect(page.locator(".patchset-diff-empty")).toHaveText(/No change/);
  await expect(page.locator(".patchset-diff-path")).toHaveCount(0);

  // Back to 1 -> 4 for the pinned screenshot.
  await selects.nth(0).selectOption("1");
  await expect(page.locator(".patchset-diff-path")).toHaveText("sum.ts");

  expect(failures).toEqual([]);

  const box = await page.locator("#app").boundingBox();
  await page.setViewportSize({ width: 1280, height: Math.ceil((box?.height ?? 800) + 32) });
  await expect(page).toHaveScreenshot("patchset-diff.png", { fullPage: true });
});
