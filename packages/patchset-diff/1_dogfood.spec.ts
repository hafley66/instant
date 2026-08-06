import { expect, test } from "@playwright/test";

test("reads this PR's own force-pushed patch sets through gitSource", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(String(error)));
  await page.goto("/packages/patchset-diff/demo.html");

  const selects = page.locator(".patchset-range-bar select");
  // This branch keeps getting force-pushed, so the count grows; pin the pair,
  // never the total.
  const options = selects.nth(1).locator("option");
  await expect(options.nth(2)).toBeAttached();
  expect(await options.count()).toBeGreaterThanOrEqual(3);

  await selects.nth(0).selectOption("2");
  await selects.nth(1).selectOption("3");
  await expect(page.locator(".patchset-diff-path").first()).toBeVisible();
  // markEdits paints only the changed words, so an edit span must exist and
  // must be narrower than its line.
  const edit = page.locator(".diff-code-edit").first();
  await expect(edit).toBeVisible();
  const editBox = await edit.boundingBox();
  const lineBox = await page.locator("td.diff-code-delete").first().boundingBox();
  expect(editBox!.width).toBeLessThan(lineBox!.width * 0.9);

  // Shiki rules are minted lazily, so the stylesheet must fill in as files render.
  const painted = await page.evaluate(
    () => getComputedStyle(document.querySelector("span[class^='pds']")!).color,
  );
  expect(painted).not.toBe("rgb(201, 209, 217)");

  // Headers collapse their file.
  const firstFile = page.locator(".patchset-diff-file").first();
  const header = firstFile.locator(".patchset-diff-head");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(firstFile.locator("table")).toHaveCount(0);
  await header.click();
  await expect(firstFile.locator("table")).toBeVisible();

  expect(failures).toEqual([]);

  const box = await page.locator("#app").boundingBox();
  await page.setViewportSize({ width: 1280, height: Math.ceil((box?.height ?? 800) + 32) });
  await expect(page).toHaveScreenshot("dogfood.png", { fullPage: true });
});
