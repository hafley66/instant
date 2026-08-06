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

  // Binary files carry no hunks, so the image pair is the only view of them.
  // Patch sets 3 -> 4 are the pair that touched screenshots.
  await selects.nth(0).selectOption("3");
  await selects.nth(1).selectOption("4");
  const images = page.locator(".patchset-diff-images img");
  await expect(images.first()).toBeVisible();
  expect(
    await images.first().evaluate((node) => (node as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);

  // Grammars load per language, so the file that dies is one low in the list
  // whose language is not the first one resident. The newest pair is the widest
  // mix of languages, so sweep it and require every file to reach paint.
  const values = await selects.nth(1).locator("option").evaluateAll(
    (nodes) => nodes.map((node) => (node as HTMLOptionElement).value),
  );
  await selects.nth(0).selectOption(values.at(-2)!);
  await selects.nth(1).selectOption(values.at(-1)!);

  const HIGHLIGHTED = /\.(ts|tsx|js|jsx|css|json|md|yml|yaml|toml|sh|rs)$/;
  const files = page.locator(".patchset-diff-file");
  await expect(files.first().locator("table")).toBeVisible();

  // Files mount on intersection, so walk the page to wake every observer. Each
  // mount shifts layout, which is why this is a scripted scroll and not
  // scrollIntoViewIfNeeded.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise((done) => setTimeout(done, 50));
    }
    window.scrollTo(0, 0);
  });

  const bare: string[] = [];
  for (let i = 0; i < (await files.count()); i += 1) {
    const file = files.nth(i);
    const name = (await file.locator(".patchset-diff-path").innerText()).trim();
    if (!HIGHLIGHTED.test(name)) continue;
    await expect(file.locator("span[class^='pds']").first())
      .toBeAttached({ timeout: 4000 })
      .catch(() => bare.push(name));
  }
  expect(bare, "files rendered with no syntax colour").toEqual([]);

  // Back to the pair the screenshot pins. Coming off a wide diff, the file list
  // has to shrink before the capture, so wait on the count rather than the first
  // path, which stays visible throughout.
  await selects.nth(0).selectOption("2");
  await selects.nth(1).selectOption("3");
  await expect(files).toHaveCount(2);
  // A file exists before it mounts, so the table is the only proof of render.
  await expect(page.locator(".patchset-diff-file table")).toHaveCount(2);

  expect(failures).toEqual([]);

  const box = await page.locator("#app").boundingBox();
  await page.setViewportSize({ width: 1280, height: Math.ceil((box?.height ?? 800) + 32) });
  await expect(page).toHaveScreenshot("dogfood.png", { fullPage: true });
});
